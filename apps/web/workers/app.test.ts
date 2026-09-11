import { beforeEach, describe, expect, test, vi } from 'vitest'

const getSessionUserMock = vi.hoisted(() => vi.fn())
const loadCommentAccessMock = vi.hoisted(() => vi.fn())
const requestHandlerMock = vi.hoisted(() =>
  vi.fn((_request: Request) => new Response('app')),
)
const sandboxHandlerMock = vi.hoisted(() => vi.fn())
const routerContextSetMock = vi.hoisted(() => vi.fn())
const cleanupExpiredCliRotationReplaysMock = vi.hoisted(() => vi.fn())
const cleanupExpiredAnonymousViewSignalsMock = vi.hoisted(() => vi.fn())
const cleanupExpiredLinkPublicationsMock = vi.hoisted(() => vi.fn())
const runReconciliationMock = vi.hoisted(() => vi.fn())
const processSlackNotificationOutboxMock = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: DurableObjectState
    env: Cloudflare.Env

    constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
      this.ctx = ctx
      this.env = env
    }
  },
  WorkflowEntrypoint: class {},
}))

vi.mock('react-router', () => ({
  createContext: (defaultValue: unknown) => ({ defaultValue }),
  createRequestHandler: () => requestHandlerMock,
  RouterContextProvider: class {
    set(...args: unknown[]) {
      routerContextSetMock(...args)
    }
  },
}))

vi.mock('./bundle-sandbox', () => ({
  handleArtifactSandboxRequest: sandboxHandlerMock,
}))

vi.mock('../app/services/db.server', () => ({
  createDb: () => ({}),
}))

const anchorAuthInitMock = vi.hoisted(() => vi.fn())

vi.mock('../app/services/auth.server', () => ({
  anchorAuthInit: anchorAuthInitMock,
  getSessionUser: getSessionUserMock,
}))

vi.mock('../app/services/comments.server', () => ({
  loadCommentAccess: loadCommentAccessMock,
}))

vi.mock('../app/services/reconcile.server', () => ({
  runReconciliation: runReconciliationMock,
}))

vi.mock('../app/services/slack-notifications.server', () => ({
  processSlackNotificationOutbox: processSlackNotificationOutboxMock,
  scheduledJobForCron: (cron: string) =>
    cron === '*/5 * * * *' ? 'slack-notifications' : 'reconciliation',
}))

vi.mock('../app/services/cli-refresh-credentials.server', () => ({
  cleanupExpiredCliRotationReplays: cleanupExpiredCliRotationReplaysMock,
}))

vi.mock('../app/services/link-abuse-signals.server', () => ({
  cleanupExpiredAnonymousViewSignals: cleanupExpiredAnonymousViewSignalsMock,
}))

vi.mock('../app/services/link-sharing.server', () => ({
  cleanupExpiredLinkPublications: cleanupExpiredLinkPublicationsMock,
}))

import app from './app'
import { PostUploadWorkflowSpike } from './post-upload-workflow-spike'

beforeEach(() => {
  getSessionUserMock.mockReset()
  loadCommentAccessMock.mockReset()
  requestHandlerMock.mockClear()
  anchorAuthInitMock.mockClear()
  sandboxHandlerMock.mockReset()
  routerContextSetMock.mockReset()
  cleanupExpiredCliRotationReplaysMock.mockReset().mockResolvedValue(0)
  cleanupExpiredAnonymousViewSignalsMock.mockReset().mockResolvedValue(0)
  cleanupExpiredLinkPublicationsMock.mockReset().mockResolvedValue(undefined)
  runReconciliationMock.mockReset().mockResolvedValue(undefined)
  processSlackNotificationOutboxMock.mockReset().mockResolvedValue(undefined)
  requestHandlerMock.mockImplementation(
    (_request: Request) => new Response('app'),
  )
})

describe('app worker link-domain routing', () => {
  test('dispatches versioned content hosts to the sandbox handler', async () => {
    sandboxHandlerMock.mockResolvedValue(new Response('bundle'))
    const request = workerRequest(
      'https://abc123def4--v-7631.artifactshare.link/index.html?t=token',
    )
    const ctx = executionContext()

    const response = await app.fetch(
      request,
      productionEnv({ maintenance: false }),
      ctx,
    )

    await expect(response.text()).resolves.toBe('bundle')
    expect(sandboxHandlerMock).toHaveBeenCalledWith(request, ctx)
    expect(requestHandlerMock).not.toHaveBeenCalled()
  })

  test.each(['artifactshare.link', 'www.artifactshare.link'])(
    'redirects the %s apex to the app landing page',
    async (hostname) => {
      const response = await app.fetch(
        workerRequest(`https://${hostname}/anything?ignored=1`),
        productionEnv({ maintenance: false }),
        executionContext(),
      )

      expect(response.status).toBe(301)
      expect(response.headers.get('location')).toBe(
        'https://artifactshare.com/',
      )
      expect(requestHandlerMock).not.toHaveBeenCalled()
    },
  )

  test('rejects an unrecognized link-domain host before session handling', async () => {
    const response = await app.fetch(
      workerRequest('https://login.artifactshare.link/sign-in', {
        headers: { cookie: 'better-auth.session_token=secret' },
      }),
      productionEnv({ maintenance: false }),
      executionContext(),
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(anchorAuthInitMock).not.toHaveBeenCalled()
    expect(requestHandlerMock).not.toHaveBeenCalled()
  })

  test.each(['/', '/_.data'])(
    'preserves viewer path %s and strips credentials, version, and timezone',
    async (pathname) => {
      const response = await app.fetch(
        workerRequest(
          `https://abc123def4.artifactshare.link${pathname}?version=old&theme=dark&tag=one&tag=two&version=older`,
          {
            headers: {
              authorization: 'Bearer secret',
              cookie:
                '__as_viewer=anonymous; __as_analytics_consent=granted; __as_theme=dark; __as_tz=Asia%2FTokyo; theme=dark; better-auth.session_token=secret',
            },
          },
        ),
        productionEnv({ maintenance: false }),
        executionContext(),
      )

      expect(response.status).toBe(200)
      const forwarded = requestHandlerMock.mock.calls.at(-1)?.[0]
      expect(new URL(forwarded!.url).pathname).toBe(pathname)
      expect(new URL(forwarded!.url).search).toBe('?theme=dark&tag=one&tag=two')
      expect(forwarded?.headers.get('cookie')).toBe(
        '__as_viewer=anonymous; __as_analytics_consent=granted',
      )
      expect(forwarded?.headers.has('authorization')).toBe(false)
      expect(routerContextSetMock).toHaveBeenCalledWith(expect.anything(), {
        shareableId: 'abc123def4',
      })
    },
  )

  test('does not forward a timezone-only cookie to the application', async () => {
    const response = await app.fetch(
      workerRequest('https://abc123def4.artifactshare.link/', {
        headers: { cookie: '__as_tz=Asia%2FTokyo' },
      }),
      productionEnv({ maintenance: false }),
      executionContext(),
    )

    expect(response.status).toBe(200)
    const forwarded = requestHandlerMock.mock.calls.at(-1)?.[0]
    expect(forwarded?.headers.has('cookie')).toBe(false)
  })

  test('forwards the viewer-only data paths the anonymous page needs', async () => {
    for (const path of [
      '/api/shareables/abc123def4/versions?version=1',
      '/a/abc123def4.data',
      '/__manifest?paths=%2Fa%2Fabc123def4&version=1',
    ]) {
      requestHandlerMock.mockClear()
      const response = await app.fetch(
        workerRequest(`https://abc123def4.artifactshare.link${path}`),
        productionEnv({ maintenance: false }),
        executionContext(),
      )
      expect(response.status).toBe(200)
      const forwarded = requestHandlerMock.mock.calls.at(-1)?.[0]
      expect(new URL(forwarded!.url).pathname).toBe(path.split('?')[0])
      if (path.includes('version=1')) {
        expect(new URL(forwarded!.url).searchParams.get('version')).toBe('1')
      }
    }
  })

  test('allows both analytics consent action forms without leaving the viewer host', async () => {
    for (const path of [
      '/set-analytics-consent',
      '/set-analytics-consent.data',
    ]) {
      requestHandlerMock.mockClear()
      const response = await app.fetch(
        workerRequest(`https://abc123def4.artifactshare.link${path}`, {
          method: 'POST',
          body: new URLSearchParams({ consent: 'granted' }),
        }),
        productionEnv({ maintenance: false }),
        executionContext(),
      )

      expect(response.status).toBe(200)
      const forwarded = requestHandlerMock.mock.calls.at(-1)?.[0]
      expect(forwarded?.method).toBe('POST')
      expect(forwarded?.url).toBe(
        `https://abc123def4.artifactshare.link${path}`,
      )
    }

    requestHandlerMock.mockClear()
    const getResponse = await app.fetch(
      workerRequest(
        'https://abc123def4.artifactshare.link/set-analytics-consent',
      ),
      productionEnv({ maintenance: false }),
      executionContext(),
    )
    expect(getResponse.status).toBe(404)
    expect(requestHandlerMock).not.toHaveBeenCalled()
  })

  test('allows only the matching report action and its data route', async () => {
    for (const path of [
      '/api/shareables/abc123def4/report',
      '/api/shareables/abc123def4/report.data',
    ]) {
      requestHandlerMock.mockClear()
      const response = await app.fetch(
        workerRequest(`https://abc123def4.artifactshare.link${path}`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'phishing' }),
          headers: { 'content-type': 'application/json' },
        }),
        productionEnv({ maintenance: false }),
        executionContext(),
      )
      expect(response.status).toBe(200)
      expect(requestHandlerMock).toHaveBeenCalledTimes(1)
    }

    requestHandlerMock.mockClear()
    const rejected = await app.fetch(
      workerRequest(
        'https://abc123def4.artifactshare.link/api/shareables/other12345/report',
        { method: 'POST' },
      ),
      productionEnv({ maintenance: false }),
      executionContext(),
    )
    expect(rejected.status).toBe(404)
    expect(requestHandlerMock).not.toHaveBeenCalled()
  })

  test('validates viewer manifest paths against the host ID', async () => {
    const accepted = await app.fetch(
      workerRequest(
        'https://abc123def4.artifactshare.link/__manifest?paths=%2F%2C%2Fa%2C%2Fa%2Fabc123def4%2C%2Fapi%2Fshareables%2Fabc123def4%2Freport%2C%2Fset-analytics-consent',
      ),
      productionEnv({ maintenance: false }),
      executionContext(),
    )
    expect(accepted.status).toBe(200)
    expect(requestHandlerMock).toHaveBeenCalledTimes(1)

    requestHandlerMock.mockClear()
    const rejected = await app.fetch(
      workerRequest(
        'https://abc123def4.artifactshare.link/__manifest?paths=%2Fa%2Fother12345',
      ),
      productionEnv({ maintenance: false }),
      executionContext(),
    )
    expect(rejected.status).toBe(404)
    expect(rejected.headers.get('cache-control')).toBe('private, no-store')
    expect(requestHandlerMock).not.toHaveBeenCalled()
  })

  test.each([
    '/settings',
    '/settings.data',
    '/_root.data',
    '/other/_.data',
    '/a/other12345.data',
  ])(
    'returns a private no-store 404 for disallowed viewer path %s',
    async (path) => {
      const response = await app.fetch(
        workerRequest(`https://abc123def4.artifactshare.link${path}`),
        productionEnv({ maintenance: false }),
        executionContext(),
      )

      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(requestHandlerMock).not.toHaveBeenCalled()
    },
  )

  test('rejects allowed route shapes when the path ID differs', async () => {
    const response = await app.fetch(
      workerRequest(
        'https://abc123def4.artifactshare.link/api/shareables/other12345/sandbox-token',
      ),
      productionEnv({ maintenance: false }),
      executionContext(),
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(requestHandlerMock).not.toHaveBeenCalled()
  })

  test('marks every viewer-host response noindex for crawlers', async () => {
    for (const path of ['/', '/a/abc123def4/og-image', '/a/abc123def4.data']) {
      requestHandlerMock.mockClear()
      const response = await app.fetch(
        workerRequest(`https://abc123def4.artifactshare.link${path}`),
        productionEnv({ maintenance: false }),
        executionContext(),
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    }
  })

  test('serves a crawlable robots response without entering the app', async () => {
    const response = await app.fetch(
      workerRequest('https://abc123def4.artifactshare.link/robots.txt'),
      productionEnv({ maintenance: false }),
      executionContext(),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe(
      'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n',
    )
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(requestHandlerMock).not.toHaveBeenCalled()
  })
})

describe('app worker scheduled cleanup', () => {
  test('prunes signals only in the daily reconciliation branch', async () => {
    const waitUntil = vi.fn()
    app.scheduled?.(
      {
        cron: '0 0 * * *',
        scheduledTime: Date.parse('2026-09-06T00:00:00.000Z'),
      } as never,
      productionEnv({ maintenance: false }),
      { waitUntil } as never,
    )

    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined()
    expect(cleanupExpiredAnonymousViewSignalsMock).toHaveBeenCalledWith(
      {},
      new Date('2026-09-06T00:00:00.000Z'),
    )
    expect(cleanupExpiredLinkPublicationsMock).toHaveBeenCalledWith(
      {},
      '2026-09-06T00:00:00.000Z',
    )
    expect(runReconciliationMock).toHaveBeenCalledTimes(1)
    expect(processSlackNotificationOutboxMock).not.toHaveBeenCalled()

    const slackWaitUntil = vi.fn()
    app.scheduled?.(
      {
        cron: '*/5 * * * *',
        scheduledTime: Date.parse('2026-09-06T00:05:00.000Z'),
      } as never,
      productionEnv({ maintenance: false }),
      { waitUntil: slackWaitUntil } as never,
    )
    await expect(slackWaitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined()
    expect(processSlackNotificationOutboxMock).toHaveBeenCalledTimes(1)
    expect(cleanupExpiredAnonymousViewSignalsMock).toHaveBeenCalledTimes(1)
  })

  test('does not fail reconciliation when signal cleanup fails', async () => {
    cleanupExpiredAnonymousViewSignalsMock.mockRejectedValue(
      new Error('cleanup failed'),
    )
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const waitUntil = vi.fn()
    app.scheduled?.(
      {
        cron: '0 0 * * *',
        scheduledTime: Date.parse('2026-09-06T00:00:00.000Z'),
      } as never,
      productionEnv({ maintenance: false }),
      { waitUntil } as never,
    )

    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined()
    expect(runReconciliationMock).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(
      'link_abuse_signal_cleanup_failed',
      { error: 'Error', message: 'cleanup failed' },
    )
  })

  test('does not fail the scheduled job when publication cleanup fails', async () => {
    cleanupExpiredLinkPublicationsMock.mockRejectedValueOnce(
      new Error('publication cleanup failed'),
    )
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const waitUntil = vi.fn()
    app.scheduled?.(
      {
        cron: '0 0 * * *',
        scheduledTime: Date.parse('2026-09-06T00:00:00.000Z'),
      } as never,
      productionEnv({ maintenance: false }),
      { waitUntil } as never,
    )

    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined()
    expect(runReconciliationMock).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(
      'link_publication_cleanup_failed',
      { error: 'Error', message: 'publication cleanup failed' },
    )
  })

  test('does not fail the scheduled job when the CLI replay cleanup fails', async () => {
    cleanupExpiredCliRotationReplaysMock.mockRejectedValueOnce(
      new Error('replay cleanup failed'),
    )
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const waitUntil = vi.fn()
    app.scheduled?.(
      {
        cron: '0 0 * * *',
        scheduledTime: Date.parse('2026-09-06T00:00:00.000Z'),
      } as never,
      productionEnv({ maintenance: false }),
      { waitUntil } as never,
    )

    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined()
    expect(cleanupExpiredAnonymousViewSignalsMock).toHaveBeenCalledTimes(1)
    expect(runReconciliationMock).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(
      'cli_rotation_replay_cleanup_failed',
      { error: 'Error', message: 'replay cleanup failed' },
    )
  })

  test('runs signal cleanup before a failing reconciliation', async () => {
    const order: string[] = []
    cleanupExpiredAnonymousViewSignalsMock.mockImplementation(async () => {
      order.push('cleanup')
      return 0
    })
    runReconciliationMock.mockImplementation(async () => {
      order.push('reconciliation')
      throw new Error('reconciliation failed')
    })
    const waitUntil = vi.fn()
    app.scheduled?.(
      {
        cron: '0 0 * * *',
        scheduledTime: Date.parse('2026-09-06T00:00:00.000Z'),
      } as never,
      productionEnv({ maintenance: false }),
      { waitUntil } as never,
    )

    await expect(waitUntil.mock.calls[0]?.[0]).rejects.toThrow(
      'reconciliation failed',
    )
    expect(order).toEqual(['cleanup', 'reconciliation'])
  })
})

describe('app worker workflow spike route', () => {
  test('hides the workflow spike route in production', async () => {
    const response = await app.fetch(
      workerRequest('https://artifactshare.com/__workflows/post-upload-spike'),
      productionEnv({ maintenance: false }),
      executionContext(),
    )

    expect(response.status).toBe(404)
  })

  test('creates a workflow instance in development', async () => {
    const status = { status: 'running' }
    const workflow = {
      create: vi.fn(async () => ({
        id: 'instance-1',
        status: async () => status,
      })),
    }

    const response = await app.fetch(
      workerRequest('https://localhost:5173/__workflows/post-upload-spike', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shareable_id: 'shareable-1' }),
      }),
      {
        APP_ENV: 'development',
        POST_UPLOAD_WORKFLOW: workflow,
      } as unknown as Cloudflare.Env,
      executionContext(),
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      id: 'instance-1',
      status,
    })
    expect(workflow.create).toHaveBeenCalledWith({
      id: expect.any(String),
      params: { shareable_id: 'shareable-1' },
    })
  })

  test('rejects non-json workflow spike payloads in development', async () => {
    const workflow = {
      create: vi.fn(),
    }

    const response = await app.fetch(
      workerRequest('https://localhost:5173/__workflows/post-upload-spike', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ should_fail: true }),
      }),
      {
        APP_ENV: 'development',
        POST_UPLOAD_WORKFLOW: workflow,
      } as unknown as Cloudflare.Env,
      executionContext(),
    )

    expect(response.status).toBe(415)
    await expect(response.json()).resolves.toMatchObject({
      error: 'content-type must be application/json',
    })
    expect(workflow.create).not.toHaveBeenCalled()
  })

  test('returns json when workflow creation fails', async () => {
    const workflow = {
      create: vi.fn(async () => {
        throw new Error('workflow unavailable')
      }),
    }

    const response = await app.fetch(
      workerRequest('https://localhost:5173/__workflows/post-upload-spike', {
        method: 'POST',
      }),
      {
        APP_ENV: 'development',
        POST_UPLOAD_WORKFLOW: workflow,
      } as unknown as Cloudflare.Env,
      executionContext(),
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: 'workflow unavailable',
    })
  })

  test('reads a workflow instance status in development', async () => {
    const status = { status: 'complete', output: { ok: true } }
    const workflow = {
      get: vi.fn(async () => ({
        id: 'instance-1',
        status: async () => status,
      })),
    }

    const response = await app.fetch(
      workerRequest(
        'https://localhost:5173/__workflows/post-upload-spike?instance_id=instance-1',
      ),
      {
        APP_ENV: 'development',
        POST_UPLOAD_WORKFLOW: workflow,
      } as unknown as Cloudflare.Env,
      executionContext(),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      id: 'instance-1',
      status,
    })
    expect(workflow.get).toHaveBeenCalledWith('instance-1')
  })

  test('checks D1 and R2 bindings inside the workflow', async () => {
    const workflow = Object.create(
      PostUploadWorkflowSpike.prototype,
    ) as PostUploadWorkflowSpike
    Object.assign(workflow, {
      env: {
        DB: {
          prepare: vi.fn(() => ({
            first: vi.fn(async () => ({ count: 1 })),
          })),
        },
        BUCKET: {
          list: vi.fn(async () => ({ objects: [] })),
        },
      },
    })
    const step = {
      do: vi.fn(async (_name: string, configOrCallback, maybeCallback) => {
        const callback =
          typeof configOrCallback === 'function'
            ? configOrCallback
            : maybeCallback
        return await callback({})
      }),
    }

    const result = await workflow.run(
      {
        payload: {
          shareable_id: 'shareable-1',
          version_id: 'version-1',
          r2_prefix: 'artifacts/',
        },
      } as never,
      step as never,
    )

    expect(result).toMatchObject({
      received: {
        shareable_id: 'shareable-1',
        version_id: 'version-1',
        r2_prefix: 'artifacts/',
      },
      d1_ok: true,
      r2_ok: true,
    })
  })
})

describe('app worker viewer rate limit', () => {
  test.each(['/a/share123', '/a/share123/og-image'])(
    'rejects %s before the application handler',
    async (pathname) => {
      const limit = vi.fn().mockResolvedValue({ success: false })
      const response = await app.fetch(
        workerRequest(`https://artifactshare.com${pathname}`, {
          headers: { 'cf-connecting-ip': '203.0.113.10' },
        }),
        {
          ...productionEnv({ maintenance: false }),
          VIEWER_RATELIMIT: { limit },
        } as unknown as Cloudflare.Env,
        executionContext(),
      )

      expect(response.status).toBe(429)
      expect(requestHandlerMock).not.toHaveBeenCalled()
      expect(limit).toHaveBeenCalledWith({ key: '203.0.113.10' })
    },
  )

  test.each(['/', '/_.data'])(
    'rate limits the per-ID viewer path %s',
    async (path) => {
      const limit = vi.fn().mockResolvedValue({ success: false })
      const response = await app.fetch(
        workerRequest(`https://abc123def4.artifactshare.link${path}`, {
          headers: { 'cf-connecting-ip': '203.0.113.11' },
        }),
        {
          ...productionEnv({ maintenance: false }),
          VIEWER_RATELIMIT: { limit },
        } as unknown as Cloudflare.Env,
        executionContext(),
      )

      expect(response.status).toBe(429)
      expect(requestHandlerMock).not.toHaveBeenCalled()
      expect(limit).toHaveBeenCalledWith({ key: '203.0.113.11' })
    },
  )

  test('rate limits link-domain report actions before the application handler', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false })
    const response = await app.fetch(
      workerRequest(
        'https://abc123def4.artifactshare.link/api/shareables/abc123def4/report',
        {
          method: 'POST',
          headers: { 'cf-connecting-ip': '203.0.113.12' },
        },
      ),
      {
        ...productionEnv({ maintenance: false }),
        VIEWER_RATELIMIT: { limit },
      } as unknown as Cloudflare.Env,
      executionContext(),
    )

    expect(response.status).toBe(429)
    expect(requestHandlerMock).not.toHaveBeenCalled()
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.12' })
  })
})

describe('app worker D1 backup workflow route', () => {
  test('hides the D1 backup workflow route in production', async () => {
    const response = await app.fetch(
      workerRequest('https://artifactshare.com/__workflows/d1-backup', {
        method: 'POST',
      }),
      productionEnv({ maintenance: false }),
      executionContext(),
    )
    expect(response.status).toBe(404)
  })

  test('creates a D1 backup workflow instance in development', async () => {
    const workflow = {
      create: vi.fn(async () => ({
        id: 'backup-instance-1',
        status: async () => ({ status: 'queued' }),
      })),
    }
    const response = await app.fetch(
      workerRequest('https://localhost:5173/__workflows/d1-backup', {
        method: 'POST',
        body: JSON.stringify({ reason: 'integration-test' }),
      }),
      {
        APP_ENV: 'development',
        INTEGRATION_TEST: 'true',
        D1_BACKUP_WORKFLOW: workflow,
      } as unknown as Cloudflare.Env,
      executionContext(),
    )
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      id: 'backup-instance-1',
      status: { status: 'queued' },
    })
    expect(workflow.create).toHaveBeenCalledWith({
      id: expect.any(String),
      params: { reason: 'integration-test' },
    })
  })
})

describe('app worker development-only routes', () => {
  test('hides integration routes without the test-only flag', async () => {
    const env = {
      APP_ENV: 'development',
      D1_BACKUP_WORKFLOW: { create: vi.fn() },
    } as unknown as Cloudflare.Env
    await expect(
      app.fetch(
        workerRequest('https://localhost/__workflows/d1-backup', {
          method: 'POST',
        }),
        env,
        executionContext(),
      ),
    ).resolves.toMatchObject({ status: 404 })
    await expect(
      app.fetch(
        workerRequest('https://localhost/__integration/outbound'),
        env,
        executionContext(),
      ),
    ).resolves.toMatchObject({ status: 404 })
  })

  test('hides outbound integration route in production', async () => {
    const response = await app.fetch(
      workerRequest('https://artifactshare.com/__integration/outbound'),
      productionEnv({ maintenance: false }),
      executionContext(),
    )
    expect(response.status).toBe(404)
  })
})

describe('app worker lazy-init anchoring', () => {
  test('anchors auth initialization on every request', async () => {
    const ctx = executionContext()
    await app.fetch(
      workerRequest('https://artifactshare.com/some-page'),
      productionEnv({ maintenance: false }),
      ctx,
    )

    expect(anchorAuthInitMock).toHaveBeenCalledWith(ctx)
  })
})

describe('app worker artifact live route', () => {
  test('authenticates and proxies websocket upgrades to the live room', async () => {
    getSessionUserMock.mockResolvedValue({
      id: 'user-1',
      email: 'owner@example.com',
      name: 'Owner',
      image: 'https://example.com/avatar.png',
    })
    loadCommentAccessMock.mockResolvedValue({ shareableId: 'abc123def4' })
    const roomFetch = vi.fn(async (_request: Request) => new Response('live'))
    const getByName = vi.fn(() => ({ fetch: roomFetch }))

    const response = await app.fetch(
      workerRequest(
        'https://artifactshare.com/api/shareables/abc123def4/live',
        {
          headers: { upgrade: 'websocket' },
        },
      ),
      {
        ...productionEnv({ maintenance: false }),
        ARTIFACT_LIVE: { getByName },
      } as unknown as Cloudflare.Env,
      executionContext(),
    )

    expect(response.status).toBe(200)
    expect(getByName).toHaveBeenCalledWith('abc123def4')
    expect(roomFetch).toHaveBeenCalledOnce()
    const proxiedRequest = roomFetch.mock.calls[0]?.[0]
    if (!proxiedRequest) throw new Error('expected proxied request')
    const proxiedUrl = new URL(proxiedRequest.url)
    expect(proxiedUrl.searchParams.get('user_id')).toBe('user-1')
    expect(proxiedUrl.searchParams.get('name')).toBe('Owner')
    expect(proxiedUrl.searchParams.get('initial')).toBe('O')
    expect(proxiedUrl.searchParams.get('image')).toBe(
      'https://example.com/avatar.png',
    )
  })

  test('ignores a stale operator workspace cookie for live authorization', async () => {
    const user = {
      id: 'user-1',
      email: 'former-operator@example.com',
      name: 'Former operator',
      image: null,
      workspaceId: 'home-workspace',
    }
    getSessionUserMock.mockResolvedValue(user)
    loadCommentAccessMock.mockResolvedValue({ shareableId: 'abc123def4' })
    const roomFetch = vi.fn(async (_request: Request) => new Response('live'))
    const getByName = vi.fn(() => ({ fetch: roomFetch }))

    const response = await app.fetch(
      workerRequest(
        'https://artifactshare.com/api/shareables/abc123def4/live',
        {
          headers: {
            upgrade: 'websocket',
            cookie: '__operator_ws=other-workspace',
          },
        },
      ),
      {
        ...productionEnv({ maintenance: false }),
        // Hidden constraint: this legacy env is only here to make the old implementation fail;
        // it must not restore the setting in production/runtime.
        OPERATOR_EMAILS: 'former-operator@example.com',
        ARTIFACT_LIVE: { getByName },
      } as unknown as Cloudflare.Env & { OPERATOR_EMAILS: string },
      executionContext(),
    )

    expect(response.status).toBe(200)
    expect(loadCommentAccessMock).toHaveBeenCalledWith(
      expect.anything(),
      user,
      'abc123def4',
    )
    expect(getByName).toHaveBeenCalledWith('abc123def4')
  })

  test('hides absent or unauthorized artifacts on live upgrades', async () => {
    getSessionUserMock.mockResolvedValue({
      id: 'user-1',
      email: 'owner@example.com',
      name: 'Owner',
      image: null,
    })
    loadCommentAccessMock.mockResolvedValue(null)
    const getByName = vi.fn()

    const response = await app.fetch(
      workerRequest(
        'https://artifactshare.com/api/shareables/abc123def4/live',
        {
          headers: { upgrade: 'websocket' },
        },
      ),
      {
        ...productionEnv({ maintenance: false }),
        ARTIFACT_LIVE: { getByName },
      } as unknown as Cloudflare.Env,
      executionContext(),
    )

    expect(response.status).toBe(404)
    expect(getByName).not.toHaveBeenCalled()
  })
})

describe('app worker maintenance mode', () => {
  test('returns maintenance JSON for CLI API routes when maintenance is enabled', async () => {
    const response = await app.fetch(
      workerRequest('https://artifactshare.com/api/cli/whoami'),
      productionEnv({ maintenance: true }),
      executionContext(),
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('retry-after')).toBeTruthy()
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'maintenance',
        message: 'Artifact Share is currently under maintenance.',
      },
    })
  })

  test('returns JSON-RPC maintenance error for MCP when maintenance is enabled', async () => {
    const response = await app.fetch(
      workerRequest('https://artifactshare.com/mcp'),
      productionEnv({ maintenance: true }),
      executionContext(),
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('retry-after')).toBeTruthy()
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: 'Artifact Share is currently under maintenance.',
        data: {
          code: 'maintenance',
          retry_after_seconds: 300,
        },
      },
    })
  })

  test('blocks artifact live websocket upgrades before the durable object', async () => {
    const getByName = vi.fn()

    const response = await app.fetch(
      workerRequest(
        'https://artifactshare.com/api/shareables/abc123def4/live',
        { headers: { upgrade: 'websocket' } },
      ),
      productionEnv({ maintenance: true, ARTIFACT_LIVE: { getByName } }),
      executionContext(),
    )

    expect(response.status).toBe(503)
    expect(getByName).not.toHaveBeenCalled()
    expect(getSessionUserMock).not.toHaveBeenCalled()
  })

  test('passes cookie-less public pages through to the app handler', async () => {
    for (const path of ['/', '/connect', '/ja/terms/', '/tokushoho'] as const) {
      const response = await app.fetch(
        workerRequest(`https://artifactshare.com${path}`),
        productionEnv({ maintenance: true }),
        executionContext(),
      )

      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('app')
    }
  })

  test.each(['/', '/_.data'] as const)(
    'blocks link-host viewer path %s during maintenance',
    async (path) => {
      const response = await app.fetch(
        workerRequest(`https://abc123def4.artifactshare.link${path}`),
        productionEnv({ maintenance: true }),
        executionContext(),
      )

      expect(response.status).toBe(503)
      expect(requestHandlerMock).not.toHaveBeenCalled()
    },
  )

  test('strips auth cookies before passing public pages through', async () => {
    const response = await app.fetch(
      workerRequest('https://artifactshare.com/', {
        headers: {
          cookie:
            'theme=dark; __Secure-better-auth.session_token=secure; better-auth.session_token=secret; better-auth.session_data=cache; __Secure-better-auth.session_data.0=chunk-a; __Secure-better-auth.session_data.1=chunk-b',
        },
      }),
      productionEnv({ maintenance: true }),
      executionContext(),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('app')
    const forwarded = requestHandlerMock.mock.calls.at(-1)?.[0]
    expect(forwarded?.headers.get('cookie')).toBe('theme=dark')
    expect(forwarded?.headers.get('x-artifactshare-maintenance')).toBe('1')
  })

  test('passes public React Router data requests through without auth cookies', async () => {
    for (const path of ['/_.data', '/connect.data'] as const) {
      const response = await app.fetch(
        workerRequest(`https://artifactshare.com${path}`, {
          headers: {
            cookie:
              'theme=dark; __Secure-better-auth.session_token=secure; __Secure-better-auth.session_data.0=chunk-a',
          },
        }),
        productionEnv({ maintenance: true }),
        executionContext(),
      )

      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('app')
      const forwarded = requestHandlerMock.mock.calls.at(-1)?.[0]
      expect(forwarded?.headers.get('cookie')).toBe('theme=dark')
    }
  })

  test('blocks protected React Router data requests during maintenance', async () => {
    const response = await app.fetch(
      workerRequest('https://artifactshare.com/projects.data'),
      productionEnv({ maintenance: true }),
      executionContext(),
    )

    expect(response.status).toBe(503)
    await expect(response.text()).resolves.toContain('メンテナンス中')
  })

  test('passes public React Router manifest patches through', async () => {
    const response = await app.fetch(
      workerRequest(
        'https://artifactshare.com/__manifest?paths=%2F%2C%2Fconnect%2C%2Fja%2Fshare-with-ai&version=8e74ecb1',
      ),
      productionEnv({ maintenance: true }),
      executionContext(),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('app')
  })

  test('blocks protected React Router manifest patches during maintenance', async () => {
    const response = await app.fetch(
      workerRequest(
        'https://artifactshare.com/__manifest?paths=%2F%2C%2Fprojects&version=8e74ecb1',
      ),
      productionEnv({ maintenance: true }),
      executionContext(),
    )

    expect(response.status).toBe(503)
    await expect(response.text()).resolves.toContain('メンテナンス中')
  })

  test('passes discovery files through to the app handler', async () => {
    for (const path of ['/robots.txt', '/sitemap.xml'] as const) {
      const response = await app.fetch(
        workerRequest(`https://artifactshare.com${path}`),
        productionEnv({ maintenance: true }),
        executionContext(),
      )

      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('app')
    }
  })

  test('passes static assets with trailing slashes through to the app handler', async () => {
    for (const path of [
      '/favicon.ico',
      '/favicon.svg/',
      '/file-types/md.png',
    ] as const) {
      const response = await app.fetch(
        workerRequest(`https://artifactshare.com${path}`),
        productionEnv({ maintenance: true }),
        executionContext(),
      )

      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('app')
    }
  })

  test('keeps www public page redirects during maintenance', async () => {
    const response = await app.fetch(
      workerRequest('https://www.artifactshare.com/connect'),
      productionEnv({ maintenance: true }),
      executionContext(),
    )

    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe(
      'https://artifactshare.com/connect',
    )
  })

  test('returns maintenance JSON for www CLI routes during maintenance', async () => {
    const response = await app.fetch(
      workerRequest('https://www.artifactshare.com/api/cli/whoami'),
      productionEnv({ maintenance: true }),
      executionContext(),
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'maintenance',
        message: 'Artifact Share is currently under maintenance.',
      },
    })
  })

  test('passes requests through when maintenance is disabled', async () => {
    const response = await app.fetch(
      workerRequest('https://artifactshare.com/api/cli/whoami'),
      productionEnv({ maintenance: false }),
      executionContext(),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('app')
  })

  test('restores the development action port removed by the Vite bridge', async () => {
    const response = await app.fetch(
      workerRequest('https://localhost/projects/project-1.data', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://localhost:5173',
        },
        body: 'intent=seen',
      }),
      { APP_ENV: 'development' } as unknown as Cloudflare.Env,
      executionContext(),
    )

    expect(response.status).toBe(200)
    const forwarded = requestHandlerMock.mock.calls.at(-1)?.[0]
    expect(forwarded?.url).toBe(
      'https://localhost:5173/projects/project-1.data',
    )
    await expect(forwarded?.text()).resolves.toBe('intent=seen')
  })

  test('does not rewrite production or cross-host action requests', async () => {
    for (const sample of [
      {
        url: 'https://artifactshare.com/projects/project-1.data',
        origin: 'https://artifactshare.com:5173',
        env: { APP_ENV: 'production' },
      },
      {
        url: 'https://localhost/projects/project-1.data',
        origin: 'https://other.localhost:5173',
        env: { APP_ENV: 'development' },
      },
    ]) {
      await app.fetch(
        workerRequest(sample.url, {
          method: 'POST',
          headers: { origin: sample.origin },
        }),
        sample.env as unknown as Cloudflare.Env,
        executionContext(),
      )
      const forwarded = requestHandlerMock.mock.calls.at(-1)?.[0]
      expect(forwarded?.url).toBe(sample.url)
    }
  })

  test('does not forward spoofed maintenance markers when maintenance is disabled', async () => {
    const response = await app.fetch(
      workerRequest('https://artifactshare.com/', {
        headers: { 'x-artifactshare-maintenance': '1' },
      }),
      productionEnv({ maintenance: false }),
      executionContext(),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('app')
    const forwarded = requestHandlerMock.mock.calls.at(-1)?.[0]
    expect(forwarded?.headers.has('x-artifactshare-maintenance')).toBe(false)
  })

  test('falls back to the app handler when Flagship evaluation throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const getBooleanValue = vi.fn(async () => {
      throw new Error('flagship unavailable')
    })

    const response = await app.fetch(
      workerRequest('https://artifactshare.com/api/cli/whoami'),
      {
        APP_ENV: 'production',
        FLAGS: { getBooleanValue },
      } as unknown as Cloudflare.Env,
      executionContext(),
    )

    expect(response.status).toBe(200)
    expect(errorSpy).toHaveBeenCalledWith(
      'maintenance_flagship_evaluation_failed',
      expect.any(Error),
    )
    errorSpy.mockRestore()
  })

  test('falls back to the app handler in production when the binding is missing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await app.fetch(
      workerRequest('https://artifactshare.com/api/cli/whoami'),
      { APP_ENV: 'production' } as unknown as Cloudflare.Env,
      executionContext(),
    )

    expect(response.status).toBe(200)
    expect(errorSpy).toHaveBeenCalledWith(
      'maintenance_flagship_binding_missing_in_production',
    )
    errorSpy.mockRestore()
  })

  test('falls back silently in non-production when the binding is missing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await app.fetch(
      workerRequest('https://artifactshare.com/api/cli/whoami'),
      { APP_ENV: 'development' } as unknown as Cloudflare.Env,
      executionContext(),
    )

    expect(response.status).toBe(200)
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  test('returns maintenance JSON in non-production when DEV_FLAGS lists maintenance and binding is missing', async () => {
    const response = await app.fetch(
      workerRequest('https://artifactshare.com/api/cli/whoami'),
      {
        APP_ENV: 'development',
        DEV_FLAGS: 'maintenance',
      } as unknown as Cloudflare.Env,
      executionContext(),
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'maintenance',
        message: 'Artifact Share is currently under maintenance.',
      },
    })
  })
})

function productionEnv(options: {
  maintenance: boolean
  ARTIFACT_LIVE?: { getByName: ReturnType<typeof vi.fn> }
}): Cloudflare.Env {
  return {
    APP_ENV: 'production',
    FLAGS: {
      getBooleanValue: vi.fn(async () => options.maintenance),
    },
    ...(options.ARTIFACT_LIVE ? { ARTIFACT_LIVE: options.ARTIFACT_LIVE } : {}),
  } as unknown as Cloudflare.Env
}

function executionContext() {
  return { waitUntil: vi.fn() } as unknown as ExecutionContext
}

function workerRequest(input: string, init?: RequestInit) {
  return new Request(input, init) as Request<
    unknown,
    IncomingRequestCfProperties<unknown>
  >
}
