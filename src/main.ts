import * as core from '@actions/core'
import puppeteer, { Browser, Page } from 'puppeteer'
import FormData from 'form-data'
import axios from 'axios'
import { createReadStream, statSync, createWriteStream } from 'fs'
import { basename, extname } from 'path'
import { ReUploadResponse, SSOResponseBody } from './types'
import {
  deleteIfExists,
  resolveAssetId,
  getBrowserHeaders,
  getEnv,
  getUrl,
  preparePuppeteer,
  zipAsset,
  syncUploadVersion,
  resolveChangelog,
  getShortSha
} from './utils'
import { Readable } from 'stream'

interface AssetVersion {
  id: number
  version?: string
  state: string
  created_at?: string
  changelog?: string
  packs: VersionPack[]
}

interface VersionPack {
  id: number
  game: string
}

interface Asset {
  id: string
  name: string
  state: string
  chunk_status: boolean[]
  updated_at: Date
  is_disabled: boolean
  disabled: string | undefined
  versions: AssetVersion[]
}

interface AssetResponse {
  items: Asset[]
}

const ASSET_READY_TIMEOUT_MS = 30 * 60 * 1000
const VERSION_ACTIVE_TIMEOUT_MS = 10 * 60 * 1000

interface UploadedVersion {
  assetId: string
  versionId: string
  cookies: string
}

/**
 * The version uploaded by this run that is not meant to stay on the portal:
 * set as soon as the portal hands out its id, cleared once it is deleted (or
 * kept, when nothing is downloaded).
 */
let versionToCleanup: UploadedVersion | null = null

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  await preparePuppeteer()

  // Puppeteer's own signal handlers exit at once, which left the uploaded
  // version on the portal when a job was cancelled (next run: 409).
  const browser = await puppeteer.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  const page = await browser.newPage()
  const onCancel = (signal: NodeJS.Signals): void => {
    void cancelRun(browser, signal)
  }
  process.once('SIGINT', onCancel)
  process.once('SIGTERM', onCancel)

  try {
    let assetId = core.getInput('assetId')
    let assetName = core.getInput('assetName')

    let uploadPath =
      core.getInput('uploadPath') || core.getInput('zipPath') || ''
    const makeZip = core.getInput('makeZip').toLowerCase() === 'true'
    const skipUpload = core.getInput('skipUpload').toLowerCase() === 'true'
    const shouldDownload = core.getInput('download').toLowerCase() === 'true'
    const downloadPath =
      core.getInput('downloadPath') || `asset-${assetId || 'download'}.zip`

    const chunkSize = parseInt(core.getInput('chunkSize'))
    const maxRetries = parseInt(core.getInput('maxRetries'))

    if (isNaN(chunkSize)) {
      throw new Error('Invalid chunk size. Must be a number.')
    }

    if (isNaN(maxRetries)) {
      throw new Error('Invalid max retries. Must be a number.')
    }

    // No asset id or name provided, using the repository name
    // If skipUpload is true, we don't need to update the asset name
    if (!assetId && !assetName && !skipUpload) {
      core.debug('No asset id or name provided, using repository name...')
      assetName = basename(getEnv('GITHUB_WORKSPACE'))
    }

    const redirectUrl = await getRedirectUrl(page, maxRetries)
    await setForumCookie(browser, page)

    await page.goto(redirectUrl, {
      waitUntil: 'networkidle0'
    })

    if (page.url().includes('portal.cfx.re')) {
      if (skipUpload) {
        core.info('Redirected to CFX Portal. Skipping upload ...')
        return
      }

      core.info('Redirected to CFX Portal. Uploading file ...')
      const cookies = await getCookies(browser)

      if (assetName) {
        assetId = await resolveAssetId(assetName, cookies)
      }

      uploadPath = await getUploadPath(assetName, uploadPath, makeZip)

      const versionManifestPath = core.getInput('versionManifestPath')
      const zipManifestPath =
        core.getInput('zipManifestPath') || 'fxmanifest.lua'
      const explicitVersion = core.getInput('version')
      const changelog = resolveChangelog(core.getInput('changelog'))
      const releaseCandidate =
        core.getInput('releaseCandidate').toLowerCase() === 'true'

      let uploadVersion = explicitVersion
      if (versionManifestPath) {
        uploadVersion = syncUploadVersion(
          uploadPath,
          versionManifestPath,
          zipManifestPath
        )
      } else if (!uploadVersion) {
        uploadVersion = getShortSha()
      }

      const versionId = await uploadFile(
        uploadPath,
        assetId,
        chunkSize,
        cookies,
        uploadVersion,
        changelog,
        releaseCandidate
      )

      if (shouldDownload) {
        await waitForAssetReady(
          assetId,
          cookies,
          ASSET_READY_TIMEOUT_MS,
          5000,
          assetName
        )
        await downloadAsset(assetId, versionId, cookies, downloadPath)
        await deleteVersion(assetId, versionId, cookies)
      }
      versionToCleanup = null
    } else {
      throw new Error(
        'Redirect failed. Make sure the provided Cookie is valid.'
      )
    }
  } catch (error) {
    await cleanupUploadedVersion()
    core.setFailed(describeError(error))
  } finally {
    process.removeListener('SIGINT', onCancel)
    process.removeListener('SIGTERM', onCancel)
    await browser.close()
  }
}

/**
 * Deletes the version uploaded by this run when the job is cancelled. The
 * runner sends SIGINT, then SIGTERM 7.5 s later, then kills the process.
 * @param browser
 * @param signal
 */
async function cancelRun(
  browser: Browser,
  signal: NodeJS.Signals
): Promise<void> {
  core.warning(`Received ${signal}. Deleting the uploaded version ...`)
  await cleanupUploadedVersion()
  browser.process()?.kill('SIGKILL')
  process.exit(1)
}

/**
 * Formats an error for the job log, with the portal's response body when
 * there is one (axios only reports the status code).
 * @param error
 * @returns {string} The error message.
 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (!axios.isAxiosError(error) || !error.response) {
    return message
  }

  const data: unknown = error.response.data
  if (data === undefined || data === null || data === '') {
    return message
  }
  if (data instanceof Readable) {
    return message
  }

  try {
    const body = typeof data === 'string' ? data : JSON.stringify(data)
    return `${message}: ${body.slice(0, 1000)}`
  } catch {
    return message
  }
}

/**
 * Navigates to the SSO URL and waits for the page to load.
 * If the navigation fails, it will retry up to `maxRetries` times.
 * @param page
 * @param maxRetries
 * @returns {Promise<string>} The redirect URL.
 * @throws If the navigation fails after `maxRetries` attempts.
 */
async function getRedirectUrl(page: Page, maxRetries: number): Promise<string> {
  let loaded = false
  let attempt = 0
  let redirectUrl = null

  while (!loaded && attempt < maxRetries) {
    try {
      core.info('Navigating to SSO URL ...')

      await page.goto(getUrl('SSO'), {
        waitUntil: 'networkidle0'
      })

      core.info('Navigated to SSO URL. Parsing response body ...')

      const responseBody = await page.evaluate(
        () => JSON.parse(document.body.innerText) as SSOResponseBody
      )

      core.debug('Parsed response body.')

      redirectUrl = responseBody.url

      core.info('Redirected to Forum Origin ...')

      const forumUrl = new URL(redirectUrl).origin
      await page.goto(forumUrl)

      loaded = true
    } catch {
      core.info(`Failed to navigate to SSO URL. Retrying in 1 seconds...`)
      await new Promise(resolve => setTimeout(resolve, 1000))
      attempt++
    }
  }

  if (!loaded || redirectUrl == null) {
    throw new Error(
      `Failed to navigate to SSO URL after ${maxRetries} attempts.`
    )
  }

  return redirectUrl
}

/**
 * Sets the cookie for the cfx.re login.
 * @param browser
 * @param page
 * @returns {Promise<void>} Resolves when the cookie has been set.
 */
async function setForumCookie(browser: Browser, page: Page): Promise<void> {
  core.info('Setting cookies ...')

  await browser.setCookie({
    name: '_t',
    value: core.getInput('cookie'),
    domain: 'forum.cfx.re',
    path: '/',
    expires: -1,
    size: 1,
    httpOnly: true,
    secure: true,
    session: false
  })

  await page.evaluate(() => document.write('Cookie' + document.cookie))

  core.info('Cookies set. Following redirect...')
}

/**
 * Gets the cookies from the browser.
 * @param browser
 * @returns {Promise<string>} Resolves with the cookies as a string.
 */
async function getCookies(browser: Browser): Promise<string> {
  return await browser
    .cookies()
    .then(cookies =>
      cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    )
}

/**
 * Retrieves the uploadPath or creates a zip based on the provided parameters.
 * @param assetName - The name of the asset.
 * @param uploadPath - The path to the upload file.
 * @param makeZip - Flag indicating whether to create a zip file.
 * @returns {Promise<string>} Resolves with the path to the upload file.
 * @throws If neither uploadPath nor makeZip is provided, or if the pre-zip command fails.
 */
async function getUploadPath(
  assetName: string,
  uploadPath: string,
  makeZip: boolean
): Promise<string> {
  core.debug('Upload path: ' + JSON.stringify(uploadPath))
  if (uploadPath.length > 0) {
    core.debug('Using provided upload path.')
    return uploadPath
  }

  if (!makeZip && uploadPath.length == 0) {
    throw new Error(
      'Either uploadPath or makeZip must be provided to upload a file.'
    )
  }

  core.info('Creating zip file ...')

  // Clean up github things before zipping
  deleteIfExists('.git/')
  deleteIfExists('.github/')
  deleteIfExists('.vscode/')

  return zipAsset(assetName)
}

/**
 * Starts the re-upload process by uploading the asset in chunks.
 * @param uploadPath
 * @param assetId
 * @param chunkSize
 * @param cookies
 * @returns {Promise<string>} Resolves with the new version id.
 * @throws If the re-upload fails due to errors in the response.
 */
async function startReupload(
  uploadPath: string,
  assetId: string,
  chunkSize: number,
  cookies: string,
  version: string,
  changelog: string,
  releaseCandidate: boolean
): Promise<string> {
  const stats = statSync(uploadPath)
  const totalSize = stats.size
  const originalFileName = basename(uploadPath)
  const chunkCount = Math.ceil(totalSize / chunkSize)

  const versions = await getAssetVersions(assetId, cookies)
  core.info(
    `Asset ${assetId} has ${versions.length} version(s): ${formatVersions(versions)}`
  )

  core.info('Starting upload ...')

  core.debug(`Total size: ${totalSize}`)
  core.debug(`Original file name: ${originalFileName}`)
  core.debug(`Chunk size: ${chunkSize}`)
  core.debug(`Chunk count: ${chunkCount}`)

  const postReupload = async (): Promise<{ data: ReUploadResponse }> =>
    axios.post<ReUploadResponse>(
      getUrl('REUPLOAD', assetId),
      {
        chunk_count: chunkCount,
        chunk_size: chunkSize,
        name: basename(originalFileName, extname(originalFileName)),
        original_file_name: originalFileName,
        total_size: totalSize,
        release_candidate: releaseCandidate,
        version,
        changelog
      },
      {
        headers: {
          ...getBrowserHeaders(),
          'Content-Type': 'application/json',
          Cookie: cookies
        }
      }
    )

  let reUploadReponse: { data: ReUploadResponse }
  try {
    reUploadReponse = await postReupload()
  } catch (error) {
    if (!axios.isAxiosError(error) || error.response?.status !== 409) {
      throw error
    }

    core.warning(`Portal refused version ${version}: ${describeError(error)}`)
    const removed = await deleteStaleVersions(assetId, version, cookies)
    if (removed === 0) {
      throw error
    }

    core.info('Retrying upload ...')
    reUploadReponse = await postReupload()
  }

  if (reUploadReponse.data.errors !== null) {
    core.debug(JSON.stringify(reUploadReponse.data.errors))
    throw new Error(
      'Failed to re-upload file. See debug logs for more information.'
    )
  }

  const versionId = reUploadReponse.data.version_id
  if (!versionId) {
    core.debug(JSON.stringify(reUploadReponse.data))
    throw new Error(
      'Re-upload response missing version_id. See debug logs for more information.'
    )
  }

  core.debug(`Version id: ${versionId}`)
  return versionId.toString()
}

/**
 * Uploads a file in chunks to the specified asset.
 * @param uploadPath
 * @param assetId
 * @param chunkSize
 * @param cookies
 * @returns {Promise<void>} Resolves when the upload is complete.
 * @throws If the upload fails at any stage.
 */
async function uploadFile(
  uploadPath: string,
  assetId: string,
  chunkSize: number,
  cookies: string,
  version: string,
  changelog: string,
  releaseCandidate: boolean
): Promise<string> {
  const versionId = await startReupload(
    uploadPath,
    assetId,
    chunkSize,
    cookies,
    version,
    changelog,
    releaseCandidate
  )
  versionToCleanup = { assetId, versionId, cookies }

  let chunkIndex = 0

  const stats = statSync(uploadPath)
  const totalSize = stats.size
  const chunkCount = Math.ceil(totalSize / chunkSize)

  const stream = createReadStream(uploadPath, { highWaterMark: chunkSize })

  for await (const chunk of stream) {
    const form = new FormData()
    form.append('chunk_id', chunkIndex)
    form.append('chunk', chunk, {
      filename: 'blob',
      contentType: 'application/octet-stream'
    })

    await axios.post(getUrl('UPLOAD_CHUNK', assetId, versionId), form, {
      headers: {
        ...getBrowserHeaders(),
        ...form.getHeaders(),
        Cookie: cookies
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    })

    core.info(`Uploaded chunk ${chunkIndex + 1}/${chunkCount}`)

    chunkIndex++
  }

  await completeUpload(assetId, versionId, cookies)
  return versionId
}

/**
 * Deletes an asset version from the portal.
 * @param assetId
 * @param versionId
 * @param cookies
 * @returns {Promise<void>} Resolves when the version is deleted.
 */
async function deleteVersion(
  assetId: string,
  versionId: string,
  cookies: string
): Promise<void> {
  await axios.delete(getUrl('DELETE_VERSION', assetId, versionId), {
    headers: {
      ...getBrowserHeaders(),
      Cookie: cookies
    }
  })

  core.info(`Deleted version ${versionId}.`)
}

async function cleanupUploadedVersion(): Promise<void> {
  const uploaded = versionToCleanup
  versionToCleanup = null
  if (!uploaded) {
    return
  }

  try {
    await deleteVersion(uploaded.assetId, uploaded.versionId, uploaded.cookies)
  } catch (error) {
    core.warning(
      `Failed to delete version ${uploaded.versionId} after job failure: ${describeError(error)}`
    )
  }
}

/**
 * Lists the versions of an asset.
 * @param assetId
 * @param cookies
 * @returns {Promise<AssetVersion[]>} The asset versions.
 */
async function getAssetVersions(
  assetId: string,
  cookies: string
): Promise<AssetVersion[]> {
  const response = await axios.get<Asset>(getUrl('ASSET_DETAIL', assetId), {
    headers: {
      Cookie: cookies
    },
    responseType: 'json'
  })

  return response.data.versions ?? []
}

/**
 * Formats asset versions for the job log.
 * @param versions
 * @returns {string} One entry per version.
 */
function formatVersions(versions: AssetVersion[]): string {
  return versions
    .map(
      v =>
        `${v.id} ${v.version ?? '?'} (${v.state}${v.created_at ? `, ${v.created_at}` : ''}${v.changelog ? `, "${v.changelog}"` : ''})`
    )
    .join('; ')
}

/**
 * Deletes the versions named like the one being uploaded. Such a version was
 * left by an earlier run that stopped before deleting its upload, and it
 * takes a slot of the asset (409 MAX_VERSIONS_REACHED once full).
 * @param assetId
 * @param version
 * @param cookies
 * @returns {Promise<number>} The number of deleted versions.
 */
async function deleteStaleVersions(
  assetId: string,
  version: string,
  cookies: string
): Promise<number> {
  const versions = await getAssetVersions(assetId, cookies)
  const stale = versions.filter(v => v.version === version)

  if (stale.length === 0) {
    core.info(
      `No version named ${version} on asset ${assetId}. Versions: ${formatVersions(versions)}`
    )
  }

  for (const v of stale) {
    core.info(
      `Deleting version ${v.id} (${version}, ${v.state}) left by an earlier run ...`
    )
    await deleteVersion(assetId, String(v.id), cookies)
  }

  return stale.length
}

/**
 * Completes the upload process.
 * @param assetId
 * @param versionId
 * @param cookies
 * @returns {Promise<void>} Resolves when the upload is complete.
 */
async function completeUpload(
  assetId: string,
  versionId: string,
  cookies: string
): Promise<void> {
  await axios.post(
    getUrl('COMPLETE_UPLOAD', assetId, versionId),
    {},
    {
      headers: {
        ...getBrowserHeaders(),
        Cookie: cookies
      }
    }
  )

  core.info('Upload completed.')
}

/**
 * Polls the assets endpoint to check if the asset is ready.
 * The asset is considered ready if its state is 'active'.
 * If assetName is provided, it will use it as a search parameter.
 * Otherwise, it will scan through pages until it finds the asset.
 *
 * @param assetId The asset id to search for.
 * @param cookies Cookies for authentication.
 * @param timeout Time in milliseconds to wait for the asset to become ready.
 * @param interval Polling interval in milliseconds.
 * @param assetName (Optional) The asset name to use in the search.
 * @throws If the asset is not ready within the timeout period.
 */
async function waitForAssetReady(
  assetId: string,
  cookies: string,
  timeout = ASSET_READY_TIMEOUT_MS,
  interval = 5000,
  assetName?: string
): Promise<void> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    let foundAsset: Asset | null = null

    if (assetName) {
      const res = await axios.get<AssetResponse>(
        `https://portal-api.cfx.re/v1/me/assets?page=1&search=${encodeURIComponent(
          assetName
        )}&sort=asset.id&direction=desc`,
        { headers: { Cookie: cookies } }
      )
      foundAsset =
        res.data.items.find(
          (item: Asset) =>
            String(item.id) === String(assetId) || item.name === assetName
        ) || null
    } else {
      let page = 1
      while (!foundAsset) {
        const res = await axios.get<AssetResponse>(
          `https://portal-api.cfx.re/v1/me/assets?page=${page}&search=&sort=asset.id&direction=desc`,
          { headers: { Cookie: cookies } }
        )
        const items = res.data.items
        if (!items || items.length === 0) break
        foundAsset =
          items.find((item: Asset) => String(item.id) === String(assetId)) ||
          null
        if (!foundAsset) {
          page++
        }
      }
    }

    if (foundAsset) {
      core.debug(`Asset state: ${foundAsset.state}`)
      if (foundAsset.state === 'active') {
        core.info('Asset is ready for download.')
        return
      } else if (foundAsset.state === 'invalid') {
        const assetWithErrors = foundAsset as any
        if (
          assetWithErrors.errors &&
          assetWithErrors.errors.general &&
          assetWithErrors.errors.general.length > 0
        ) {
          const errorsArray = assetWithErrors.errors.general
          const errorMsg = errorsArray.join(', ')
          const errorLabel = errorsArray.length === 1 ? 'Error' : 'Errors'
          throw new Error(`Asset upload failed. ${errorLabel}: ${errorMsg}`)
        } else {
          core.info(
            'Asset state is "invalid", but no errors were found. Waiting...'
          )
        }
      } else if (
        foundAsset.state === 'submitted' ||
        foundAsset.state === 'created'
      ) {
        core.info(
          'Asset has successfully been submitted. Waiting for asset to be active...'
        )
      } else {
        throw new Error(
          `Asset state is '${foundAsset.state}'. Asset is not ready for download.`
        )
      }
    } else {
      core.info('Asset not found in response. Waiting...')
    }
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  throw new Error(
    'Asset was not ready for download within the specified timeout.'
  )
}

/**
 * Polls the asset versions until the given version is active.
 * @param assetId
 * @param versionId
 * @param cookies
 * @param timeout Time in milliseconds to wait for the version.
 * @param interval Polling interval in milliseconds.
 * @returns {Promise<AssetVersion>} The active version.
 * @throws If the version is gone or not active within the timeout.
 */
async function waitForVersionActive(
  assetId: string,
  versionId: string,
  cookies: string,
  timeout = VERSION_ACTIVE_TIMEOUT_MS,
  interval = 5000
): Promise<AssetVersion> {
  const startTime = Date.now()

  for (;;) {
    const version = (await getAssetVersions(assetId, cookies)).find(
      v => String(v.id) === versionId
    )

    if (!version) {
      throw new Error(`Version ${versionId} is no longer on the portal.`)
    }
    if (version.state === 'active' && version.packs?.length > 0) {
      return version
    }
    if (Date.now() - startTime >= timeout) {
      throw new Error(
        `Version ${versionId} was not active within the timeout (state: ${version.state}).`
      )
    }

    core.info(`Version ${versionId} is ${version.state}. Waiting...`)
    await new Promise(resolve => setTimeout(resolve, interval))
  }
}

/**
 * Downloads the version uploaded by this run (not just any active one: a
 * version left by an earlier run would be another build).
 * @param assetId
 * @param versionId
 * @param cookies
 * @param downloadPath The file path where the asset will be saved.
 * @returns {Promise<void>} Resolves when the download is complete.
 */
async function downloadAsset(
  assetId: string,
  versionId: string,
  cookies: string,
  downloadPath: string
): Promise<void> {
  core.info(`Waiting for version ${versionId} to be active ...`)
  const activeVersion = await waitForVersionActive(assetId, versionId, cookies)

  core.info('Grabbing asset version pack ID ...')
  const packId = activeVersion.packs[0].id

  const portalDownloadUrl = `https://portal-api.cfx.re/v1/assets/${assetId}/versions/${activeVersion.id}/packs/${packId}/download`
  core.info(`Grabbing real CDN download URL from ${portalDownloadUrl} ...`)

  const cdnDownloadUrl = await axios.get(portalDownloadUrl, {
    headers: {
      Cookie: cookies
    },
    responseType: 'json'
  })

  const response = await axios.get(cdnDownloadUrl.data.url, {
    headers: {
      Cookie: cookies
    },
    responseType: 'stream'
  })

  // Cast response.data to a Readable stream to satisfy the linter.
  const readableStream = response.data as Readable
  const writer = createWriteStream(downloadPath)
  readableStream.pipe(writer)

  await new Promise<void>((resolve, reject) => {
    writer.on('finish', resolve)
    writer.on('error', reject)
  })

  core.info(`Downloaded asset saved to ${downloadPath}`)
}
