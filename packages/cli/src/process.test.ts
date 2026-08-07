import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { resolveBrowserOpener } from './process.js'

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

test('Windows browser opener passes URLs without cmd shell parsing', () => {
  const url = 'https://artifactshare.test/device?user_code=ABCD&next=a|b'
  Object.defineProperty(process, 'platform', { value: 'win32' })

  const opener = resolveBrowserOpener(url)

  assert.equal(opener.command, 'rundll32')
  assert.deepEqual(opener.args, ['url.dll,FileProtocolHandler', url])
  assert.equal(opener.label, 'rundll32')
})
