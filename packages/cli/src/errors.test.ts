import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  profileReauthRequiredError,
  tokenStoreUnavailableError,
} from './errors.js'

test('saved-profile recovery reuses its preset instead of forcing agent', () => {
  const error = profileReauthRequiredError(
    'https://artifactshare.example',
    'profile',
    'work',
  )

  assert.match(error.hint, /saved authorization preset is reused/)
  assert.match(error.hint, /login --profile work/)
  assert.doesNotMatch(error.hint, /login --profile work --preset agent/)
})

test('token store recovery only suggests plaintext fallback where supported', () => {
  const windows = tokenStoreUnavailableError(
    'default',
    'native_store_unavailable',
    'win32',
  )
  assert.match(windows.hint, /Credential Manager/)
  assert.doesNotMatch(windows.hint, /allow-plaintext-token-store/)

  const linux = tokenStoreUnavailableError(
    'default',
    'native_store_unavailable',
    'linux',
  )
  assert.match(linux.hint, /allow-plaintext-token-store/)

  const configWrite = tokenStoreUnavailableError(
    'default',
    'config_write_failed',
    'win32',
  )
  assert.match(configWrite.hint, /configuration directory/)
  assert.doesNotMatch(configWrite.hint, /Credential Manager/)
  assert.equal(configWrite.agent_recoverable, true)
  assert.equal(configWrite.requires_human, false)
  assert.deepEqual(configWrite.recovery, { kind: 'retry_later' })
})
