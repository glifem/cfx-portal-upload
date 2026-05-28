import {
  buildUploadVersion,
  parseManifestVersion,
  resolveBaseVersion,
  setManifestVersion
} from '../src/utils'

describe('version utils', () => {
  it('parses manifest version', () => {
    const content = "version '1.0.0'\nfx_version 'cerulean'"
    expect(parseManifestVersion(content)).toBe('1.0.0')
  })

  it('sets manifest version', () => {
    const content = "version '1.0.0'\nfx_version 'cerulean'"
    expect(setManifestVersion(content, '1.0.0-abc1234')).toBe(
      "version '1.0.0-abc1234'\nfx_version 'cerulean'"
    )
  })

  it('resolves placeholder version', () => {
    expect(resolveBaseVersion('__BUILD_VERSION__', 'abc1234')).toBe('abc1234')
    expect(resolveBaseVersion('1.0.0-{commit}', 'abc1234')).toBe('1.0.0')
  })

  it('builds unique upload version from base', () => {
    expect(buildUploadVersion('1.0.0', 'abc1234')).toBe('1.0.0-abc1234')
    expect(buildUploadVersion('1.0.0-abc1234', 'abc1234')).toBe('1.0.0-abc1234')
  })
})
