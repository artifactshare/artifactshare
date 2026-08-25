import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import type { CredentialResolution } from './credentials.js'
import type { OutputMode } from './types.js'
import { DEFAULT_BASE_URL } from './constants.js'
import {
  authRequiredError,
  profileReauthRequiredError,
  tokenInvalidError,
} from './errors.js'
import {
  handleCredentialFailure,
  isInteractiveTerminal,
  profileForAutoLogin,
} from './command-runners/auto-login.js'
import type { AutoLoginDeps } from './command-runners/auto-login.js'
import type { DeviceLoginResult } from './command-runners/login.js'

const interactiveMode: OutputMode = { json: false }
const nonInteractiveMode: OutputMode = { json: true }

function authRequiredCredential(
  source: CredentialResolution['source'] = 'none',
  profile?: string,
): Extract<CredentialResolution, { ok: false }> {
  return profile === undefined
    ? { ok: false, source, error: authRequiredError(DEFAULT_BASE_URL) }
    : {
        ok: false,
        source,
        profile,
        error: authRequiredError(DEFAULT_BASE_URL),
      }
}

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = 0
})

test('isInteractiveTerminal requires human output mode and stdin TTY', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  try {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    })
    assert.equal(isInteractiveTerminal(interactiveMode), true)
    assert.equal(isInteractiveTerminal(nonInteractiveMode), false)
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    })
    assert.equal(isInteractiveTerminal(interactiveMode), false)
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdin, 'isTTY', descriptor)
    }
  }
})

test('profileForAutoLogin uses default when no profile source is selected', () => {
  assert.equal(profileForAutoLogin(authRequiredCredential('none')), 'default')
  assert.equal(
    profileForAutoLogin(authRequiredCredential('global_profile', 'work')),
    'work',
  )
})

test('auth_required on an interactive terminal logs in once and reruns', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  let loginCalls = 0
  let rerunCalls = 0
  const performLogin = vi.fn(async (): Promise<DeviceLoginResult> => {
    loginCalls += 1
    return {
      ok: true,
      data: {
        profile: 'default',
        status: 'completed',
        credential_source: 'profile',
        token_store: 'plaintext_file',
        user: { email: 'person@example.com' },
        workspace: { id: 'wrk_1', hosted_domain: null },
        verification_uri: 'https://example.test/device',
        verification_uri_complete: null,
        user_code: 'ABCD1234',
        expires_at: null,
        session_expires_at: null,
        refresh_credential_expires_at: '2026-12-31T00:00:00.000Z',
        renewal: {
          kind: 'automatic',
          trigger: 'session_unauthorized_once',
        },
        interval_seconds: 1,
      },
    }
  })

  try {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    })
    await handleCredentialFailure(
      'share',
      authRequiredCredential(),
      {},
      interactiveMode,
      async () => {
        rerunCalls += 1
      },
      false,
      { performLogin },
    )
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdin, 'isTTY', descriptor)
    }
  }

  assert.equal(loginCalls, 1)
  assert.equal(rerunCalls, 1)
  assert.equal(performLogin.mock.calls.length, 1)
})

test.each([undefined, 'agent'])(
  'automatic login never treats a command --project destination as login preselection (preset %s)',
  async (preset) => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const performLogin = vi.fn<NonNullable<AutoLoginDeps['performLogin']>>(
      async (...args): Promise<DeviceLoginResult> => {
        assert.equal(args[3], undefined)
        return {
          ok: true,
          data: {
            profile: 'default',
            status: 'completed',
            credential_source: 'profile',
            token_store: 'plaintext_file',
            user: { email: 'person@example.com' },
            workspace: { id: 'wrk_1', hosted_domain: null },
            verification_uri: 'https://example.test/device',
            verification_uri_complete: null,
            user_code: 'ABCD1234',
            expires_at: null,
            session_expires_at: null,
            refresh_credential_expires_at: '2026-12-31T00:00:00.000Z',
            renewal: {
              kind: 'automatic',
              trigger: 'session_unauthorized_once',
            },
            interval_seconds: 1,
          },
        }
      },
    )
    try {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      })
      await handleCredentialFailure(
        'share',
        authRequiredCredential(),
        { project: 'Share destination', ...(preset ? { preset } : {}) },
        interactiveMode,
        async () => {},
        false,
        { performLogin },
      )
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor)
    }
    assert.equal(performLogin.mock.calls.length, 1)
  },
)

test('expired profile token on an interactive terminal says refresh', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true)
  const performLogin = vi.fn(async (): Promise<DeviceLoginResult> => {
    return {
      ok: true,
      data: {
        profile: 'work',
        status: 'completed',
        credential_source: 'profile',
        token_store: 'plaintext_file',
        user: { email: 'person@example.com' },
        workspace: { id: 'wrk_1', hosted_domain: null },
        verification_uri: 'https://example.test/device',
        verification_uri_complete: null,
        user_code: 'ABCD1234',
        expires_at: null,
        session_expires_at: null,
        refresh_credential_expires_at: '2026-12-31T00:00:00.000Z',
        renewal: {
          kind: 'automatic',
          trigger: 'session_unauthorized_once',
        },
        interval_seconds: 1,
      },
    }
  })

  try {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    })
    await handleCredentialFailure(
      'share',
      {
        ok: false,
        source: 'profile',
        profile: 'work',
        error: profileReauthRequiredError(DEFAULT_BASE_URL, 'profile', 'work'),
      },
      {},
      interactiveMode,
      async () => {},
      false,
      { performLogin },
    )
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdin, 'isTTY', descriptor)
    }
  }

  assert.equal(
    stdout.mock.calls[0]?.[0],
    'Profile token expired. Starting device login to refresh...\n',
  )
})

test('auth_required on a non-interactive terminal does not log in', async () => {
  const performLogin = vi.fn()
  const rerun = vi.fn()

  await handleCredentialFailure(
    'resolve',
    authRequiredCredential(),
    {},
    nonInteractiveMode,
    rerun,
    false,
    { performLogin },
  )

  assert.equal(performLogin.mock.calls.length, 0)
  assert.equal(rerun.mock.calls.length, 0)
  assert.equal(process.exitCode, 1)
})

test('token_invalid does not trigger auto-login', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const performLogin = vi.fn()
  const rerun = vi.fn()

  try {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    })
    await handleCredentialFailure(
      'share',
      {
        ok: false,
        source: 'env',
        error: tokenInvalidError(),
      },
      {},
      interactiveMode,
      rerun,
      false,
      { performLogin },
    )
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdin, 'isTTY', descriptor)
    }
  }

  assert.equal(performLogin.mock.calls.length, 0)
  assert.equal(rerun.mock.calls.length, 0)
  assert.equal(process.exitCode, 1)
})

test('retry after auto-login does not log in again when still auth_required', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const performLogin = vi.fn()
  const rerun = vi.fn()

  try {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    })
    await handleCredentialFailure(
      'share',
      authRequiredCredential(),
      {},
      interactiveMode,
      rerun,
      true,
      { performLogin },
    )
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdin, 'isTTY', descriptor)
    }
  }

  assert.equal(performLogin.mock.calls.length, 0)
  assert.equal(rerun.mock.calls.length, 0)
  assert.equal(process.exitCode, 1)
})
