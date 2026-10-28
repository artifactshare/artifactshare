// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true}}
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { createShareDialogHandler } from './share-dialog.js'
import { apiGet } from '../api.js'
import { resolveCredential } from '../credentials.js'
import { resolveDefaultVisibility } from '../destination.js'
import { postShareUpload } from '../share-upload.js'
import {
  requestDeviceCode,
  exchangeDeviceTokenOnce,
} from '../command-runners/login.js'
import {
  PREVIEW_MUTATION_HEADER,
  PREVIEW_MUTATION_HEADER_VALUE,
} from './contract.js'
import { refreshAuthenticatedCredential } from '../command-runners/auto-login.js'
import { fetchProjects } from '../command-runners/projects.js'
import { readGlobalConfig } from '../token-store.js'
import { mapApiError, validationError } from '../errors.js'

vi.mock('../api.js', async (original) => ({
  ...(await original<typeof import('../api.js')>()),
  apiGet: vi.fn(),
}))
vi.mock('../credentials.js', () => ({
  resolveCredential: vi.fn(),
  resolveEffectiveDefaultProfile: vi.fn().mockResolvedValue({ profile: null }),
}))
vi.mock('../destination.js', () => ({
  resolveDefaultVisibility: vi.fn(),
  resolveProjectConfig: vi.fn().mockResolvedValue({ config: null }),
  resolveSharedProjectConfig: vi.fn().mockResolvedValue({ config: null }),
}))
vi.mock('../token-store.js', () => ({
  readGlobalConfig: vi.fn().mockResolvedValue(null),
}))
vi.mock('../command-runners/projects.js', () => ({
  fetchProjects: vi.fn().mockResolvedValue({ projects: [] }),
}))
vi.mock('../command-runners/login.js', () => ({
  requestDeviceCode: vi.fn(),
  exchangeDeviceTokenOnce: vi.fn(),
  verifyProfileTokenAccount: vi.fn().mockResolvedValue({ ok: true }),
  verifyAndStoreProfileToken: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('../command-runners/auto-login.js', () => ({
  refreshAuthenticatedCredential: vi.fn(),
}))
vi.mock('../share-upload.js', () => ({ postShareUpload: vi.fn() }))

function handler() {
  return createShareDialogHandler({
    filePath: '/tmp/report.html',
    fileName: 'report.html',
    artifactOrigin: 'http://localhost:4100',
    readFileBytes: () => Buffer.from('<h1>Snapshot</h1>'),
    cliOptions: { baseUrl: 'https://artifactshare.test' },
  })
}
function call(
  handle: ReturnType<typeof handler>,
  path: string,
  payload?: unknown,
): Promise<{ status: number; text: string; json: any }> {
  return new Promise((resolve) => {
    const request = Object.assign(new EventEmitter(), {
      method: payload === undefined ? 'GET' : 'POST',
      url: path,
      headers: {
        host: 'localhost',
        'content-type': 'application/json',
        [PREVIEW_MUTATION_HEADER]: PREVIEW_MUTATION_HEADER_VALUE,
      },
    })
    let status = 200
    const response = {
      headersSent: false,
      writeHead(code: number) {
        status = code
      },
      end(text: string) {
        let json
        try {
          json = JSON.parse(text)
        } catch {
          /* HTML */
        }
        resolve({ status, text, json })
      },
    }
    handle(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    )
    if (payload !== undefined)
      queueMicrotask(() => {
        request.emit('data', Buffer.from(JSON.stringify(payload)))
        request.emit('end')
      })
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readGlobalConfig).mockResolvedValue(null)
  vi.mocked(fetchProjects).mockResolvedValue({ projects: [] })
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  vi.mocked(resolveCredential).mockResolvedValue({
    ok: true,
    token: 'test-token',
    source: 'token_option',
  })
  vi.mocked(resolveDefaultVisibility).mockResolvedValue({
    value: 'workspace',
    source: 'product_default',
  })
  vi.mocked(apiGet).mockResolvedValue({
    body: { workspace: { visibility_available: false } },
  })
  vi.mocked(postShareUpload).mockImplementation(async (input) => ({
    body: {
      id: 'abc123def4',
      url: 'https://artifactshare.test/a/abc123def4',
      versionId: 'v1',
      artifactKind: 'html_page',
      visibility: String(input.form.get('visibility')) as 'private',
      linkExpiresAt: null,
      created: true,
      warnings: [],
    },
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

test.each([true, false])(
  'preview context and omitted-audience submission use capability %s',
  async (available) => {
    vi.mocked(apiGet).mockResolvedValue({
      body: { workspace: { visibility_available: available } },
    })
    const handle = handler()
    const context = await call(handle, '/api/context')
    expect(context.json.default_visibility).toBe(
      available ? 'workspace' : 'private',
    )
    const snapshot = await call(handle, '/api/snapshot', {})
    const result = await call(handle, '/api/share', {
      snapshot_id: snapshot.json.snapshot_id,
    })
    expect(result.json.visibility).toBe(available ? 'workspace' : 'private')
    expect(postShareUpload).toHaveBeenCalledTimes(1)
    expect(apiGet).toHaveBeenCalledWith(
      '/api/cli/whoami',
      'test-token',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ credentialSource: 'token_option' }),
    )
  },
)

test('configured and selected audiences and projects bypass capability', async () => {
  const handle = handler()
  vi.mocked(resolveDefaultVisibility).mockResolvedValue({
    value: 'workspace',
    source: 'repository',
  })
  expect((await call(handle, '/api/context')).json.default_visibility).toBe(
    'workspace',
  )
  for (const choice of [{ visibility: 'link' }, { project_id: 'prj1' }, {}]) {
    const snapshot = await call(handle, '/api/snapshot', {})
    await call(handle, '/api/share', {
      snapshot_id: snapshot.json.snapshot_id,
      ...choice,
    })
  }
  expect(apiGet).not.toHaveBeenCalled()
  expect(
    vi
      .mocked(postShareUpload)
      .mock.calls.map(([input]) => input.form.get('visibility')),
  ).toEqual(['link', 'project', 'workspace'])
})

test('unresolved config blocks omitted audience without uploading', async () => {
  vi.mocked(resolveDefaultVisibility).mockResolvedValue({
    error: validationError('Invalid config', 'Fix config'),
  })
  const handle = handler()
  expect(
    (await call(handle, '/api/context')).json.default_visibility,
  ).toBeNull()
  const snapshot = await call(handle, '/api/snapshot', {})
  expect(
    (
      await call(handle, '/api/share', {
        snapshot_id: snapshot.json.snapshot_id,
      })
    ).status,
  ).toBe(502)
  expect(postShareUpload).not.toHaveBeenCalled()
})

test('auth-start with an available credential only asks to refresh context', async () => {
  expect((await call(handler(), '/api/auth-start', {})).json).toEqual({
    refresh_context: true,
  })
  expect(requestDeviceCode).not.toHaveBeenCalled()
  expect(postShareUpload).not.toHaveBeenCalled()
})

for (const available of [true, false]) {
  test(`rendered sign-in resolves capability ${available} and waits for a subsequent Share click`, async () => {
    vi.useFakeTimers()
    vi.mocked(resolveCredential).mockResolvedValue({
      ok: false,
      source: 'none',
      error: {
        ...validationError('Login required', 'Sign in'),
        code: 'auth_required',
      },
    })
    vi.mocked(apiGet).mockResolvedValue({
      body: { workspace: { visibility_available: available } },
    })
    vi.mocked(requestDeviceCode).mockResolvedValue({
      device_code: 'device-code',
      user_code: 'ABCD1234',
      verification_uri: 'https://artifactshare.test/device',
      expires_in: 60,
      interval: 1,
    })
    vi.mocked(exchangeDeviceTokenOnce).mockResolvedValue({
      status: 'success',
      token: { access_token: 'test-token', token_type: 'Bearer' },
    })
    const handle = handler()
    const page = await call(handle, '/')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        const result = await call(
          handle,
          path,
          init?.body ? JSON.parse(String(init.body)) : undefined,
        )
        return { ok: result.status < 400, json: async () => result.json }
      }),
    )
    document.write(page.text)
    // Happy DOM evaluates inline scripts from document.write.
    await vi.advanceTimersByTimeAsync(0)
    const share = document.getElementById('shareBtn') as HTMLButtonElement
    const signIn = document.getElementById('signInBtn') as HTMLButtonElement
    expect(share.disabled).toBe(true)
    expect(signIn.disabled).toBe(false)
    signIn.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(requestDeviceCode).toHaveBeenCalledTimes(1)
    expect(postShareUpload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(
      (document.getElementById('visibility') as HTMLSelectElement).value,
    ).toBe(available ? 'workspace' : 'private')
    expect(share.disabled).toBe(false)
    expect(postShareUpload).not.toHaveBeenCalled()
    share.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(postShareUpload).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(postShareUpload).mock.calls[0]![0].form.get('visibility'),
    ).toBe(available ? 'workspace' : 'private')
  })
}

test('context capability refresh uses the renewed token and is limited to one attempt', async () => {
  const expired = {
    ok: true as const,
    token: 'expired-token',
    source: 'profile' as const,
    profile: 'default',
    profileCredentialKind: 'session' as const,
    botProfile: false,
  }
  vi.mocked(resolveCredential).mockResolvedValue(expired)
  const error = {
    ...validationError('Session expired', 'Sign in'),
    code: 'auth_required',
  }
  vi.mocked(apiGet)
    .mockResolvedValueOnce({ error })
    .mockResolvedValueOnce({
      body: { workspace: { visibility_available: false } },
    })
  vi.mocked(refreshAuthenticatedCredential).mockResolvedValue({
    ok: true,
    credential: { ...expired, token: 'fresh-token' },
  })
  const handle = handler()
  expect((await call(handle, '/api/context')).json.default_visibility).toBe(
    'private',
  )
  expect(refreshAuthenticatedCredential).toHaveBeenCalledTimes(1)
  expect(apiGet).toHaveBeenLastCalledWith(
    '/api/cli/whoami',
    'fresh-token',
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ profile: 'default' }),
  )
  const snapshot = await call(handle, '/api/snapshot', {})
  await call(handle, '/api/share', {
    snapshot_id: snapshot.json.snapshot_id,
    visibility: 'private',
  })
  expect(vi.mocked(postShareUpload).mock.calls[0]![0].token).toBe('fresh-token')
})

test('context does not refresh again after the project read already refreshed', async () => {
  const credential = {
    ok: true as const,
    token: 'test-token',
    source: 'profile' as const,
    profile: 'default',
    profileCredentialKind: 'session' as const,
    botProfile: false,
  }
  vi.mocked(resolveCredential).mockResolvedValue(credential)
  const error = {
    ...validationError('Expired', 'Sign in'),
    code: 'auth_required',
  }
  vi.mocked(fetchProjects)
    .mockResolvedValueOnce({ error })
    .mockResolvedValueOnce({ projects: [] })
  vi.mocked(apiGet).mockResolvedValue({ error })
  vi.mocked(refreshAuthenticatedCredential).mockResolvedValue({
    ok: true,
    credential,
  })
  expect(
    (await call(handler(), '/api/context')).json.default_visibility,
  ).toBeNull()
  expect(refreshAuthenticatedCredential).toHaveBeenCalledTimes(1)
  expect(postShareUpload).not.toHaveBeenCalled()
})

test('auth-only endpoint preserves bot and conflicting-credential guards', async () => {
  vi.mocked(resolveCredential).mockResolvedValue({
    ok: false,
    source: 'none',
    error: {
      ...validationError('Login required', 'Sign in'),
      code: 'auth_required',
    },
  })
  vi.mocked(readGlobalConfig).mockResolvedValue({
    profiles: { bot: { kind: 'bot' } },
  })
  const handle = createShareDialogHandler({
    filePath: '/tmp/report.html',
    fileName: 'report.html',
    artifactOrigin: 'http://localhost:4100',
    readFileBytes: () => Buffer.from('Report'),
    cliOptions: { profile: 'bot' },
  })
  expect(
    (await call(handle, '/api/auth-start', {})).json.error.details
      .reauth_reason,
  ).toBe('bot_credential_invalid')
  vi.mocked(resolveCredential).mockResolvedValue({
    ok: false,
    source: 'none',
    error: validationError('Conflicting credential selection', 'Select one'),
  })
  expect((await call(handle, '/api/auth-start', {})).json.error.code).toBe(
    'validation_failed',
  )
  expect(requestDeviceCode).not.toHaveBeenCalled()
  expect(postShareUpload).not.toHaveBeenCalled()
})

test('rendered context failure keeps Share blocked and provides a retry', async () => {
  vi.useFakeTimers()
  vi.mocked(apiGet).mockResolvedValue({
    error: validationError('Unavailable', 'Retry'),
  })
  const handle = handler()
  const page = await call(handle, '/')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const result = await call(
        handle,
        path,
        init?.body ? JSON.parse(String(init.body)) : undefined,
      )
      return { ok: result.status < 400, json: async () => result.json }
    }),
  )
  document.write(page.text)
  await vi.advanceTimersByTimeAsync(0)
  const share = document.getElementById('shareBtn') as HTMLButtonElement
  const retry = document.getElementById('signInBtn') as HTMLButtonElement
  expect(share.disabled).toBe(true)
  expect(retry.disabled).toBe(false)
  expect(retry.style.display).not.toBe('none')
  expect(postShareUpload).not.toHaveBeenCalled()
  vi.mocked(apiGet).mockResolvedValue({
    body: { workspace: { visibility_available: true } },
  })
  retry.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(share.disabled).toBe(false)
  expect(
    (document.getElementById('visibility') as HTMLSelectElement).value,
  ).toBe('workspace')
  expect(postShareUpload).not.toHaveBeenCalled()
})

test.each(['projects', 'capability'])(
  'a rejected session with failed %s refresh can sign in before confirming a share',
  async (rejectedRead) => {
    vi.useFakeTimers()
    const error = {
      ...validationError('Session expired', 'Sign in'),
      code: 'auth_required',
    }
    vi.mocked(resolveCredential).mockResolvedValue({
      ok: true,
      token: 'expired-token',
      source: 'profile',
      profile: 'default',
      profileCredentialKind: 'session',
      botProfile: false,
    })
    vi.mocked(refreshAuthenticatedCredential).mockResolvedValue({
      ok: false,
      error,
    })
    if (rejectedRead === 'projects')
      vi.mocked(fetchProjects).mockImplementation(
        async (_token, _options, _init, errorOptions) => ({
          error: mapApiError(
            401,
            { error: 'unauthorized' },
            { authenticated: true, ...errorOptions },
          ),
        }),
      )
    else vi.mocked(apiGet).mockResolvedValue({ error })
    vi.mocked(requestDeviceCode).mockResolvedValue({
      device_code: 'device-code',
      user_code: 'ABCD1234',
      verification_uri: 'https://artifactshare.test/device',
      expires_in: 60,
      interval: 1,
    })
    vi.mocked(exchangeDeviceTokenOnce).mockResolvedValue({
      status: 'success',
      token: { access_token: 'fresh-token', token_type: 'Bearer' },
    })
    const handle = handler()
    const page = await call(handle, '/')
    const paths: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        paths.push(path)
        const result = await call(
          handle,
          path,
          init?.body ? JSON.parse(String(init.body)) : undefined,
        )
        return { ok: result.status < 400, json: async () => result.json }
      }),
    )
    document.write(page.text)
    await vi.advanceTimersByTimeAsync(0)
    const share = document.getElementById('shareBtn') as HTMLButtonElement
    const signIn = document.getElementById('signInBtn') as HTMLButtonElement
    expect(share.disabled).toBe(true)
    expect(signIn.disabled).toBe(false)
    expect(signIn.textContent).toBe('Sign in')
    expect(refreshAuthenticatedCredential).toHaveBeenCalledTimes(1)
    expect(postShareUpload).not.toHaveBeenCalled()

    // The stored expired credential remains readable; it must not defeat sign-in.
    signIn.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(paths).toContain('/api/auth-start')
    expect(requestDeviceCode).toHaveBeenCalledTimes(1)
    expect(refreshAuthenticatedCredential).toHaveBeenCalledTimes(1)
    expect(postShareUpload).not.toHaveBeenCalled()
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [] })
    vi.mocked(apiGet).mockResolvedValue({
      body: { workspace: { visibility_available: false } },
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(
      (document.getElementById('visibility') as HTMLSelectElement).value,
    ).toBe('private')
    expect(share.disabled).toBe(false)
    expect(postShareUpload).not.toHaveBeenCalled()
    share.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(postShareUpload).toHaveBeenCalledTimes(1)
    expect(vi.mocked(postShareUpload).mock.calls[0]![0]).toMatchObject({
      token: 'fresh-token',
    })
  },
)

test('failed bot-session refresh still requires admin recovery instead of device sign-in', async () => {
  const error = {
    ...validationError('Expired', 'Sign in'),
    code: 'auth_required',
  }
  vi.mocked(resolveCredential).mockResolvedValue({
    ok: true,
    token: 'expired-token',
    source: 'profile',
    profile: 'bot',
    profileCredentialKind: 'session',
    botProfile: true,
  })
  vi.mocked(apiGet).mockResolvedValue({ error })
  vi.mocked(refreshAuthenticatedCredential).mockResolvedValue({
    ok: false,
    error,
  })
  const handle = handler()
  expect((await call(handle, '/api/context')).json.authenticated).toBe(false)
  const result = await call(handle, '/api/auth-start', {})
  expect(result.json.error.details.reauth_reason).toBe('bot_credential_invalid')
  expect(requestDeviceCode).not.toHaveBeenCalled()
  expect(postShareUpload).not.toHaveBeenCalled()
})

test('a replacement credential after failed refresh requests context confirmation without signing in', async () => {
  const credential = {
    ok: true as const,
    token: 'expired-token',
    source: 'profile' as const,
    profile: 'default',
    profileCredentialKind: 'session' as const,
    botProfile: false,
  }
  const error = {
    ...validationError('Expired', 'Sign in'),
    code: 'auth_required',
  }
  vi.mocked(resolveCredential).mockResolvedValue(credential)
  vi.mocked(apiGet).mockResolvedValue({ error })
  vi.mocked(refreshAuthenticatedCredential).mockResolvedValue({
    ok: false,
    error,
  })
  const handle = handler()
  expect((await call(handle, '/api/context')).json.authenticated).toBe(false)
  vi.mocked(resolveCredential).mockResolvedValue({
    ...credential,
    token: 'fresh-token',
  })
  expect((await call(handle, '/api/auth-start', {})).json).toEqual({
    refresh_context: true,
  })
  expect(requestDeviceCode).not.toHaveBeenCalled()
  expect(postShareUpload).not.toHaveBeenCalled()
})
