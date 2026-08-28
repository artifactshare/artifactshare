import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PREVIEW_MUTATION_HEADER,
  PREVIEW_MUTATION_HEADER_VALUE,
  PREVIEW_SESSION_ENDPOINT,
  isPreviewSessionIdentity,
} from './contract.js'
import {
  type PreviewServer,
  startPreviewServer,
  stripMetaCsp,
} from './server.js'
import { createPreviewStore } from './store.js'

const MUTATION_HEADERS = {
  'content-type': 'application/json',
  [PREVIEW_MUTATION_HEADER]: PREVIEW_MUTATION_HEADER_VALUE,
}

interface Context {
  dir: string
  filePath: string
  server: PreviewServer
  store: ReturnType<typeof createPreviewStore>
}

async function startContext(options?: {
  extension?: string
  content?: string
}): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'as-preview-server-'))
  const extension = options?.extension ?? '.html'
  const filePath = join(dir, `artifact${extension}`)
  writeFileSync(
    filePath,
    options?.content ??
      '<!doctype html><html><head><title>t</title></head><body><h1>Hello</h1></body></html>',
  )
  const store = createPreviewStore(join(dir, 'config', 'annotations.json'))
  const server = await startPreviewServer({
    filePath,
    store,
    sessionId: 'test-session',
  })
  return { dir, filePath, server, store }
}

function rawStatus(port: number, host: string): Promise<number> {
  // fetch() strips the forbidden Host header, so spoof it with node:http.
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/', headers: { host } },
      (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function origin(context: Context): string {
  return `http://127.0.0.1:${context.server.port}`
}

async function post(
  context: Context,
  path: string,
  body: unknown,
  headers: Record<string, string> = MUTATION_HEADERS,
): Promise<Response> {
  return fetch(`${origin(context)}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  })
}

describe('startPreviewServer', () => {
  let context: Context

  beforeEach(async () => {
    context = await startContext()
  })

  afterEach(async () => {
    await context.server.close()
    rmSync(context.dir, { recursive: true, force: true })
  })

  it('serves the session identity endpoint', async () => {
    const response = await fetch(
      `${origin(context)}${PREVIEW_SESSION_ENDPOINT}`,
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(isPreviewSessionIdentity(body)).toBe(true)
    expect(body.session_id).toBe('test-session')
    expect(body.realpath).toBe(context.filePath)
    expect(body.share_port).toBe(context.server.sharePort)
  })

  it('rejects requests with a non-local Host header', async () => {
    expect(await rawStatus(context.server.port, 'evil.example.com')).toBe(403)
    expect(await rawStatus(context.server.port, 'localhost:1234')).toBeLessThan(
      400,
    )
    expect(await rawStatus(context.server.port, '127.0.0.1')).toBeLessThan(400)
  })

  it('rejects mutations without the preview header', async () => {
    const response = await post(
      context,
      '/api/annotations',
      { anchor: { kind: 'artifact' }, comment: 'x' },
      { 'content-type': 'application/json' },
    )
    expect(response.status).toBe(403)
  })

  it('rejects mutations without a JSON content type', async () => {
    const response = await post(
      context,
      '/api/annotations',
      { anchor: { kind: 'artifact' }, comment: 'x' },
      {
        'content-type': 'text/plain',
        [PREVIEW_MUTATION_HEADER]: PREVIEW_MUTATION_HEADER_VALUE,
      },
    )
    expect(response.status).toBe(403)
  })

  it('never sends CORS headers', async () => {
    const response = await fetch(`${origin(context)}/api/annotations`, {
      headers: { origin: 'http://attacker.example' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('serves the shell page and the artifact with the reporter injected', async () => {
    const shell = await (await fetch(`${origin(context)}/`)).text()
    expect(shell).toContain('artifactFrame')
    expect(shell).toContain('/artifact')
    const artifact = await (await fetch(`${origin(context)}/artifact`)).text()
    expect(artifact).toContain('<h1>Hello</h1>')
    expect(artifact).toContain('securitypolicyviolation')
  })

  it('runs the draft -> submit -> next -> done -> annotations flow', async () => {
    const create = await post(context, '/api/annotations', {
      anchor: {
        kind: 'element',
        state: 'attached',
        selector: 'h1',
        label: 'h1: Hello',
        contextText: 'Hello',
      },
      comment: 'make it blue',
    })
    expect(create.status).toBe(200)
    const { annotation } = await create.json()
    expect(annotation.status).toBe('draft')

    const submit = await post(context, '/api/annotations/submit', {})
    expect((await submit.json()).submitted).toBe(1)

    const next = await post(context, '/api/agent/next', { wait: 0 })
    const nextBody = await next.json()
    expect(nextBody.items).toHaveLength(1)
    expect(nextBody.items[0].thread).toBe(annotation.thread)
    expect(nextBody.items[0].status).toBe('in_progress')
    expect(typeof nextBody.revision).toBe('string')

    const done = await post(context, '/api/agent/done', {
      items: [
        {
          thread: annotation.thread,
          generation: annotation.generation,
          outcome: 'fixed',
          note: 'done it',
        },
      ],
    })
    const doneBody = await done.json()
    expect(doneBody.results).toEqual([
      { thread: annotation.thread, result: 'accepted' },
    ])

    const list = await (
      await fetch(`${origin(context)}/api/annotations`)
    ).json()
    expect(list.annotations).toHaveLength(1)
    expect(list.annotations[0].status).toBe('resolved')
    expect(list.annotations[0].summary).toBe('done it')
    expect(list.quarantined).toBe(false)
  })

  it('rejects invalid anchors', async () => {
    const response = await post(context, '/api/annotations', {
      anchor: { kind: 'nope' },
      comment: 'x',
    })
    expect(response.status).toBe(400)
  })

  it('long-polls next until a submit arrives', async () => {
    const pending = post(context, '/api/agent/next', { wait: 10 })
    await new Promise((resolve) => setTimeout(resolve, 150))
    await post(context, '/api/annotations', {
      anchor: { kind: 'artifact' },
      comment: 'overall polish',
    })
    await post(context, '/api/annotations/submit', {})
    const body = await (await pending).json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].comment).toBe('overall polish')
    expect(body.session_ended).toBeUndefined()
  })

  it('times out a waiting next', async () => {
    const start = Date.now()
    const body = await (
      await post(context, '/api/agent/next', { wait: 0.3 })
    ).json()
    expect(body.items).toEqual([])
    expect(body.timed_out).toBe(true)
    expect(Date.now() - start).toBeGreaterThanOrEqual(250)
  })

  it('ends waiting next calls and shuts down on stop', async () => {
    const pending = post(context, '/api/agent/next', { wait: 10 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const stop = await post(context, '/api/agent/stop', {})
    expect((await stop.json()).stopped).toBe(true)
    const body = await (await pending).json()
    expect(body.items).toEqual([])
    expect(body.session_ended).toBe(true)
    await context.server.closed
  })

  it('deletes drafts and discards them in bulk', async () => {
    const create = await post(context, '/api/annotations', {
      anchor: { kind: 'artifact' },
      comment: 'one',
    })
    const { annotation } = await create.json()
    const del = await fetch(
      `${origin(context)}/api/annotations/${annotation.thread}`,
      { method: 'DELETE', headers: MUTATION_HEADERS },
    )
    expect(del.status).toBe(200)

    await post(context, '/api/annotations', {
      anchor: { kind: 'artifact' },
      comment: 'two',
    })
    const discard = await post(context, '/api/annotations/discard-drafts', {})
    expect((await discard.json()).discarded).toBe(1)
    expect(context.store.all()).toHaveLength(0)
  })

  it('discards orphaned annotations regardless of terminal status', async () => {
    const draft = await (
      await post(context, '/api/annotations', {
        anchor: { kind: 'artifact' },
        comment: 'draft one',
      })
    ).json()
    const resolvedDraft = await (
      await post(context, '/api/annotations', {
        anchor: { kind: 'artifact' },
        comment: 'resolved one',
      })
    ).json()
    await post(context, '/api/annotations/submit', {})
    await post(context, '/api/agent/next', { wait: 0 })
    await post(context, '/api/agent/done', {
      items: [
        {
          thread: resolvedDraft.annotation.thread,
          generation: 1,
          outcome: 'fixed',
        },
        { thread: draft.annotation.thread, generation: 1, outcome: 'skipped' },
      ],
    })
    const response = await post(context, '/api/annotations/orphan-discard', {
      threads: [draft.annotation.thread, resolvedDraft.annotation.thread],
    })
    const body = await response.json()
    expect(
      body.results.every((entry: { discarded: boolean }) => entry.discarded),
    ).toBe(true)
    expect(context.store.all()).toHaveLength(0)
  })

  it('rejects bodies over 1MB', async () => {
    const response = await post(context, '/api/annotations', {
      anchor: { kind: 'artifact' },
      comment: 'x'.repeat(1024 * 1024 + 10),
    })
    expect(response.status).toBe(413)
  })

  it('serves the share dialog on the share origin', async () => {
    const response = await fetch(
      `http://127.0.0.1:${context.server.sharePort}/`,
    )
    expect(response.status).toBe(200)
    const page = await response.text()
    expect(page).toContain('preview.shareDialog')
    expect(await rawStatus(context.server.sharePort, 'evil.example.com')).toBe(
      403,
    )
  })
})

describe('markdown rendering', () => {
  it('renders markdown with the reporter script injected', async () => {
    const context = await startContext({
      extension: '.md',
      content: '# Title\n\nSome **body** text.\n',
    })
    try {
      const response = await fetch(`${origin(context)}/artifact`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      const html = await response.text()
      expect(html).toContain('Title')
      expect(html).toContain('securitypolicyviolation')
    } finally {
      await context.server.close()
      rmSync(context.dir, { recursive: true, force: true })
    }
  })
})

describe('stripMetaCsp', () => {
  it('removes meta CSP tags regardless of case and attribute order', () => {
    const html =
      '<html><head>' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">' +
      "<META content=\"script-src 'self'\" HTTP-EQUIV='content-security-policy'/>" +
      '<meta http-equiv=content-security-policy content="img-src *">' +
      '<meta charset="utf-8">' +
      '</head><body></body></html>'
    const stripped = stripMetaCsp(html)
    expect(stripped.toLowerCase()).not.toContain('http-equiv')
    expect(stripped).toContain('<meta charset="utf-8">')
  })

  it('is applied to served HTML artifacts', async () => {
    const context = await startContext({
      content:
        '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body>ok</body></html>',
    })
    try {
      const html = await (await fetch(`${origin(context)}/artifact`)).text()
      expect(html.toLowerCase()).not.toContain(
        'content-security-policy" content',
      )
      expect(html).toContain('securitypolicyviolation')
      expect(html).toContain('ok')
    } finally {
      await context.server.close()
      rmSync(context.dir, { recursive: true, force: true })
    }
  })
})
