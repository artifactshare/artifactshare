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

test('a failed capability check keeps the workspace product default', async () => {
  vi.mocked(apiGet).mockResolvedValue({
    error: mapApiError(503, { error: 'unavailable' }),
  } as never)
  const handle = handler()
  expect((await call(handle, '/api/context')).json.default_visibility).toBe(
    'workspace',
  )
  const snapshot = await call(handle, '/api/snapshot', {})
  await call(handle, '/api/share', { snapshot_id: snapshot.json.snapshot_id })
  expect(
    vi
      .mocked(postShareUpload)
      .mock.calls.map(([input]) => input.form.get('visibility')),
  ).toEqual(['workspace'])
})
