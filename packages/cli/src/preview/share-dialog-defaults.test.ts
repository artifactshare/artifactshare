// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true}}
import assert from 'node:assert/strict'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { createShareDialogHandler } from './share-dialog.js'
import { resolveCredential } from '../credentials.js'
import { resolveDefaultVisibility } from '../destination.js'
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
import { validationError } from '../errors.js'
import { collectBody, formField, withServer } from '../test/server.js'

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

/** Requests the dialog made to the Artifact Share API, newest last. */
let api: { path: string; authorization: string; body: string }[] = []
/** What the stub API answers GET /api/cli/whoami with. */
let whoami: { status: number; body: unknown } = {
  status: 200,
  body: { workspace: { visibility_available: false } },
}
let baseUrl = ''
/** How many times the rendered dialog finished loading /api/context. */
let contextLoads = 0

async function withApi<T>(callback: () => Promise<T>): Promise<T> {
  return await withServer(
    async (request, response) => {
      const path = request.url ?? ''
      const body = request.method === 'GET' ? '' : await collectBody(request)
      api.push({
        path,
        authorization: request.headers.authorization ?? '',
        body,
      })
      response.setHeader('content-type', 'application/json')
      if (path === '/api/cli/whoami') {
        response.statusCode = whoami.status
        return response.end(JSON.stringify(whoami.body))
      }
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          versionId: 'v1',
          artifactKind: 'html_page',
          visibility: formField(body, 'visibility'),
          shareUrl: 'https://artifactshare.test/a/abc123def4',
        }),
      )
    },
    async (url) => {
      baseUrl = url
      return await callback()
    },
  )
}

const uploads = () =>
  api
    .filter((entry) => entry.path === '/api/shareables/uploads')
    .map((entry) => formField(entry.body, 'visibility'))
const whoamiCalls = () =>
  api.filter((entry) => entry.path === '/api/cli/whoami')

function handler() {
  return createShareDialogHandler({
    filePath: '/tmp/report.html',
    fileName: 'report.html',
    artifactOrigin: 'http://localhost:4100',
    readFileBytes: () => Buffer.from('<h1>Snapshot</h1>'),
    cliOptions: { baseUrl },
  })
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Wait for the dialog script to apply the resolved /api/context, then let its
 * promise chain drain so clearing the document cannot race it. */
async function settled(): Promise<void> {
  for (let attempt = 0; attempt < 500 && contextLoads === 0; attempt += 1)
    await tick()
  assert.ok(contextLoads > 0, 'dialog loaded its context')
  for (let drain = 0; drain < 10; drain += 1) await tick()
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
  api = []
  contextLoads = 0
  whoami = { status: 200, body: { workspace: { visibility_available: false } } }
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await tick()
  document.body.innerHTML = ''
})

test.each([true, false])(
  'preview context and omitted-audience submission use capability %s',
  async (available) => {
    whoami = {
      status: 200,
      body: { workspace: { visibility_available: available } },
    }
    await withApi(async () => {
      const handle = handler()
      const context = await call(handle, '/api/context')
      expect(context.json.default_visibility).toBe(
        available ? 'workspace' : 'private',
      )
      expect(context.json.private_default).toBe(!available)
      const snapshot = await call(handle, '/api/snapshot', {})
      const result = await call(handle, '/api/share', {
        snapshot_id: snapshot.json.snapshot_id,
      })
      expect(result.json.visibility).toBe(available ? 'workspace' : 'private')
      expect(uploads()).toEqual([available ? 'workspace' : 'private'])
      expect(whoamiCalls().map((entry) => entry.authorization)).toContain(
        'Bearer test-token',
      )
    })
  },
)

test('configured and selected audiences and projects bypass capability', async () => {
  vi.mocked(resolveDefaultVisibility).mockResolvedValue({
    value: 'workspace',
    source: 'repository',
  })
  await withApi(async () => {
    const handle = handler()
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
    expect(whoamiCalls()).toEqual([])
    expect(uploads()).toEqual(['link', 'project', 'workspace'])
  })
})

test('unresolved config blocks omitted audience without uploading', async () => {
  vi.mocked(resolveDefaultVisibility).mockResolvedValue({
    error: validationError('Invalid config', 'Fix config'),
  })
  await withApi(async () => {
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
    expect(uploads()).toEqual([])
  })
})

test('a failed capability check keeps the workspace product default', async () => {
  whoami = { status: 503, body: { error: 'unavailable' } }
  await withApi(async () => {
    const handle = handler()
    expect((await call(handle, '/api/context')).json.default_visibility).toBe(
      'workspace',
    )
    const snapshot = await call(handle, '/api/snapshot', {})
    await call(handle, '/api/share', { snapshot_id: snapshot.json.snapshot_id })
    expect(uploads()).toEqual(['workspace'])
  })
})

test.each([true, false])(
  'rendered dialog explains a private account default (capability %s)',
  async (available) => {
    whoami = {
      status: 200,
      body: { workspace: { visibility_available: available } },
    }
    vi.mocked(fetchProjects).mockResolvedValue({
      projects: [{ id: 'prj1', name: 'Reports' }],
    } as never)
    await withApi(async () => {
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
          if (path === '/api/context') contextLoads += 1
          return { ok: result.status < 400, json: async () => result.json }
        }),
      )
      document.write(page.text)
      await settled()
      const visibility = document.getElementById(
        'visibility',
      ) as HTMLSelectElement
      const note = document.getElementById('privateDefaultNote') as HTMLElement
      expect(visibility.value).toBe(available ? 'workspace' : 'private')
      expect(note.style.display).toBe(available ? 'none' : '')
      expect(note.textContent).not.toBe('')
      visibility.value = 'link'
      visibility.dispatchEvent(new Event('change'))
      expect(note.style.display).toBe('none')
      if (!available) {
        const destination = document.getElementById(
          'destination',
        ) as HTMLSelectElement
        destination.value = 'prj1'
        destination.dispatchEvent(new Event('change'))
        expect(note.style.display).toBe('none')
        visibility.value = 'project'
        destination.value = ''
        destination.dispatchEvent(new Event('change'))
        expect(visibility.value).toBe('private')
        expect(note.style.display).toBe('')
      }
    })
  },
)
