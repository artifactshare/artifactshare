import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  detectNativeStore,
  plaintextFallbackSupported,
  resolveConfigHome,
  type NativeStore,
} from './token-store.js'
import type { SpawnFileResult } from './process.js'

test('resolveConfigHome falls back through USERPROFILE and the OS home', () => {
  assert.equal(
    resolveConfigHome(
      { HOME: 'C:\\shell-home', USERPROFILE: 'C:\\Users\\person' },
      () => 'C:\\Users\\fallback',
      'win32',
    ),
    join('C:\\Users\\person', '.config/artifactshare'),
  )
  assert.equal(
    resolveConfigHome({}, () => '/Users/fallback'),
    join('/Users/fallback', '.config/artifactshare'),
  )
  assert.equal(
    resolveConfigHome({}, () => {
      throw new Error('no OS user')
    }),
    null,
  )
})

test('plaintext token fallback is unavailable on Windows', () => {
  assert.equal(plaintextFallbackSupported('win32'), false)
  assert.equal(plaintextFallbackSupported('linux'), true)
  assert.equal(plaintextFallbackSupported('darwin'), true)
})

test('Windows Credential Manager keeps credential values off process arguments', async () => {
  const calls: Array<{ args: string[]; input?: string }> = []
  const run = async (
    _command: string,
    args: string[],
    input?: string,
  ): Promise<SpawnFileResult> => {
    calls.push({ args, ...(input === undefined ? {} : { input }) })
    const request = JSON.parse(
      Buffer.from(input ?? '', 'base64').toString('utf8'),
    ) as { operation?: string }
    return {
      status: 0,
      stdout:
        request.operation === 'read'
          ? Buffer.from('stored-value').toString('base64')
          : '',
      stderr: '',
    }
  }

  const store = await detectNativeStore('win32', run)
  assert.equal(store?.kind, 'windows_credential_manager')
  assert.equal(await store?.write('account', 'secret-value'), true)
  assert.equal(await store?.read('account'), 'stored-value')
  assert.equal(await store?.delete('account'), true)
  assert.ok(calls.every(({ args }) => !args.includes('secret-value')))
  assert.match(
    Buffer.from(calls[1]?.input ?? '', 'base64').toString('utf8'),
    /secret-value/,
  )
})

const windowsTest = process.platform === 'win32' ? test : test.skip

windowsTest(
  'Windows Credential Manager stores, reads, and deletes a credential',
  async () => {
    const store: NativeStore | null = await detectNativeStore('win32')
    assert.ok(store)
    const account = `integration-${process.pid}-${Date.now()}`
    const value = JSON.stringify({ kind: 'api_token', token: 'x'.repeat(6000) })
    try {
      assert.equal(await store.write(account, value), true)
      assert.equal(await store.read(account), value)
    } finally {
      await store.delete(account)
    }
    assert.equal(await store.read(account), null)
  },
)
