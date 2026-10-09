import { describe, expect, test } from 'vitest'
import { downloadFileUrl } from './api.js'

describe('downloadFileUrl', () => {
  test.each([
    [
      '/data/AA から BB CC_dd.data',
      'data/AA%20%E3%81%8B%E3%82%89%20BB%20CC_dd%2Edata',
    ],
    ['assets.v1/app.min.js', 'assets%2Ev1/app%2Emin%2Ejs'],
    ['/data/value.json', 'data/value%2Ejson'],
    ['/dot-free/nested', 'dot-free/nested'],
    ['/literal%2E/#?.data', 'literal%252E/%23%3F%2Edata'],
  ])('encodes %s without changing decoded segments', (path, encoded) => {
    const url = downloadFileUrl(
      'https://artifactshare.test/prefix/?old=1#old',
      'site123abc',
      path,
    )
    expect(url.href).toBe(
      `https://artifactshare.test/prefix/api/cli/artifacts/site123abc/download/${encoded}`,
    )
    expect(encoded.split('/').map(decodeURIComponent).join('/')).toBe(
      path.replace(/^\//, ''),
    )
  })
})
