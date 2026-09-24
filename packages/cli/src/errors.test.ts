import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  mapApiError,
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

test.each([undefined, 'Supply the current version id.'])(
  'maps expected-version-required with message %s',
  (message) => {
    const error = mapApiError(
      400,
      { error: { code: 'expected-version-required', message } },
      { artifactTarget: true, operation: 'update' },
    )
    assert.equal(error.code, 'expected_version_required')
    assert.equal(
      error.message,
      message ?? 'Agent updates require the current version id.',
    )
    assert.equal(
      error.hint,
      'Pass --expected-version <version-id>, using data.version.id from the previous successful share or update output.',
    )
    assert.equal(error.agent_recoverable, true)
    assert.equal(error.requires_human, false)
    assert.deepEqual(error.recovery, { kind: 'change_input' })
  },
)

test.each([
  ['validation-failed', 'validation_failed'],
  ['missing-file', 'validation_failed'],
  ['too-many-files', 'file_count_exceeded'],
  ['invalid-container', 'project_not_found'],
])('preserves update HTTP 400 mapping for %s', (code, expected) => {
  assert.equal(
    mapApiError(
      400,
      { error: { code } },
      { artifactTarget: true, operation: 'update' },
    ).code,
    expected,
  )
})

test.each([
  {},
  { artifactTarget: true, operation: 'share' as const },
  { artifactTarget: true, operation: 'append' as const },
  { operation: 'update' as const },
])(
  'does not map expected-version-required outside artifact updates: %j',
  (options) => {
    assert.equal(
      mapApiError(400, { error: 'expected-version-required' }, options).code,
      'validation_failed',
    )
  },
)

test('does not map expected-version-required outside HTTP 400', () => {
  assert.equal(
    mapApiError(
      500,
      { error: 'expected-version-required' },
      { artifactTarget: true, operation: 'update' },
    ).code,
    'service_error',
  )
})

test('preserves update version conflict recovery', () => {
  const error = mapApiError(
    409,
    {
      error: {
        code: 'version_conflict',
        details: { current_version_id: 'ver123' },
      },
    },
    { artifactTarget: true, operation: 'update' },
  )
  assert.equal(error.code, 'version_conflict')
  assert.deepEqual(error.recovery, { kind: 'change_input' })
  assert.deepEqual(error.details, { current_version_id: 'ver123' })
  assert.equal(
    error.hint,
    'Read the current version, reapply your changes, and retry with its version id.',
  )
})
