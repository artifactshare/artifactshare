import { beforeEach, describe, expect, test, vi } from 'vitest'

const getSessionUserMock = vi.hoisted(() => vi.fn())
const loadCommentAccessMock = vi.hoisted(() => vi.fn())
const requestHandlerMock = vi.hoisted(() =>
  vi.fn((_request: Request) => new Response('app')),
)

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
    set() {}
  },
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
  runReconciliation: vi.fn(),
}))

import app from './app'
import { PostUploadWorkflowSpike } from './post-upload-workflow-spike'

beforeEach(() => {
  getSessionUserMock.mockReset()
  loadCommentAccessMock.mockReset()
  requestHandlerMock.mockClear()
  requestHandlerMock.mockImplementation(
    (_request: Request) => new Response('app'),
  )
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
    for (const path of ['/_root.data', '/connect.data'] as const) {
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
