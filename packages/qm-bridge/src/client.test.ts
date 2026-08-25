import { describe, expect, it, vi } from 'vitest'
import { ArtifactShareBridgeClient } from './client.js'
import type { OwnedBridgeRequest } from './types.js'

const request: OwnedBridgeRequest = {
  intent: {
    operation: 'publish',
    requested_audience: 'workspace',
    content_kind: 'file',
  },
  context: {
    source: {
      kind: 'qm',
      installation_id: 'install-1',
      external_workspace_id: 'workspace-1',
    },
    conversation: {
      current_id: 'channel-1',
      ids: ['channel-1'],
      kind: 'public_channel',
      privacy_checked_at: '2026-08-25T05:00:00.000Z',
    },
    requester: {
      stable_id: 'person-1',
      verified_email: 'person@example.com',
    },
    request_id: 'request-1',
  },
  files: [
    {
      index: 0,
      path: 'report.md',
      media_type: 'text/markdown',
      bytes: new Uint8Array([65, 66]),
      size: 2,
      sha256: '0'.repeat(64),
    },
  ],
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

describe('ArtifactShareBridgeClient', () => {
  it('rejects a malformed credential without attempting a request', async () => {
    const fetchMock = vi.fn()
    const client = new ArtifactShareBridgeClient({
      baseUrl: 'https://artifactshare.com',
      fetch: fetchMock as typeof fetch,
    })
    await expect(
      client.health({ bearer_token: 'token\n' }),
    ).resolves.toMatchObject({
      code: 'credential_unavailable',
      retryable: false,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports an invalid boundary source as a non-retryable internal error', async () => {
    const fetchMock = vi.fn()
    const client = new ArtifactShareBridgeClient({
      baseUrl: 'https://artifactshare.com',
      fetch: fetchMock as typeof fetch,
      randomBytes: () => {
        throw new TypeError('broken random source')
      },
    })
    await expect(
      client.request(request, { bearer_token: 'token' }),
    ).resolves.toMatchObject({ code: 'internal_error', retryable: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('builds deterministic multipart and validates success', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({ authorization: 'Bearer token' })
        expect(init?.headers).toMatchObject({
          'content-type':
            'multipart/form-data; boundary=artifactshare-bridge-11111111111111111111111111111111',
        })
        const body = new TextDecoder().decode(init?.body as ArrayBuffer)
        expect(body).toContain('Content-Type: application/json\r\n\r\n')
        expect(body).toContain(
          'filename="file-0"\r\nContent-Type: text/markdown',
        )
        return json({
          schema_version: 1,
          ok: true,
          data: {
            artifact: {
              id: 'artifact-1',
              url: 'https://artifactshare.com/artifacts/artifact-1',
              title: 'Report',
            },
            project: { id: 'project-1', name: 'Project' },
            visibility: 'workspace',
            version_id: 'version-1',
            replayed: false,
            mapping_created: true,
            project_created: true,
          },
        })
      },
    )
    const client = new ArtifactShareBridgeClient({
      baseUrl: 'https://artifactshare.com',
      fetch: fetchMock as typeof fetch,
      randomBytes: (length) => new Uint8Array(length).fill(0x11),
    })
    await expect(
      client.request(request, { bearer_token: 'token' }),
    ).resolves.toMatchObject({
      ok: true,
      visibility: 'workspace',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('accepts a duplicate-free health operation subset in any order', async () => {
    const client = new ArtifactShareBridgeClient({
      baseUrl: 'https://artifactshare.com',
      fetch: vi.fn(async () =>
        json({
          schema_version: 1,
          ok: true,
          data: { authority: 'available', operations: ['update', 'publish'] },
        }),
      ) as typeof fetch,
    })
    await expect(
      client.health({ bearer_token: 'token' }),
    ).resolves.toMatchObject({
      authority: 'available',
      operations: ['update', 'publish'],
    })
  })

  it.each([202, 206])(
    'rejects a success-shaped response with non-final status %s',
    async (status) => {
      const client = new ArtifactShareBridgeClient({
        baseUrl: 'https://artifactshare.com',
        fetch: vi.fn(async () =>
          json(
            {
              schema_version: 1,
              ok: true,
              data: { authority: 'available', operations: ['publish'] },
            },
            { status },
          ),
        ) as typeof fetch,
      })
      await expect(
        client.health({ bearer_token: 'token' }),
      ).resolves.toMatchObject({ code: 'invalid_server_response' })
    },
  )

  it('redacts application messages and preserves bounded retry metadata', async () => {
    const client = new ArtifactShareBridgeClient({
      baseUrl: 'https://artifactshare.com',
      fetch: vi.fn(async () =>
        json(
          {
            schema_version: 1,
            ok: false,
            error: {
              code: 'rate-limited',
              message: 'server detail that must not escape',
              retryable: true,
              retry_after_ms: 500,
            },
          },
          { status: 429 },
        ),
      ) as typeof fetch,
    })
    const result = await client.request(request, { bearer_token: 'token' })
    expect(result).toMatchObject({
      ok: false,
      code: 'bridge_rejected',
      server_code: 'rate-limited',
      retryable: true,
      retry_after_ms: 500,
    })
    expect(JSON.stringify(result)).not.toContain('server detail')
  })

  it('accepts valid multibyte artifact and project labels', async () => {
    const title = 'あ'.repeat(200)
    const projectName = '日'.repeat(120)
    const client = new ArtifactShareBridgeClient({
      baseUrl: 'https://artifactshare.com',
      fetch: vi.fn(async () =>
        json({
          schema_version: 1,
          ok: true,
          data: {
            artifact: {
              id: 'artifact-1',
              url: 'https://artifactshare.com/artifacts/artifact-1',
              title,
            },
            project: { id: 'project-1', name: projectName },
            visibility: 'workspace',
            version_id: 'version-1',
            replayed: false,
            mapping_created: true,
            project_created: true,
          },
        }),
      ) as typeof fetch,
    })
    await expect(
      client.request(request, { bearer_token: 'token' }),
    ).resolves.toMatchObject({
      ok: true,
      artifact: { title },
      project: { name: projectName },
    })
  })

  it('rejects control characters in server-returned labels', async () => {
    const client = new ArtifactShareBridgeClient({
      baseUrl: 'https://artifactshare.com',
      fetch: vi.fn(async () =>
        json({
          schema_version: 1,
          ok: true,
          data: {
            artifact: {
              id: 'artifact-1',
              url: 'https://artifactshare.com/artifacts/artifact-1',
              title: 'Report\nforged',
            },
            project: { id: 'project-1', name: 'Project' },
            visibility: 'workspace',
            version_id: 'version-1',
            replayed: false,
            mapping_created: true,
            project_created: true,
          },
        }),
      ) as typeof fetch,
    })
    await expect(
      client.request(request, { bearer_token: 'token' }),
    ).resolves.toMatchObject({ code: 'invalid_server_response' })
  })

  it('rejects ill-formed Unicode in server-returned fields', async () => {
    const client = new ArtifactShareBridgeClient({
      baseUrl: 'https://artifactshare.com',
      fetch: vi.fn(async () =>
        json({
          schema_version: 1,
          ok: true,
          data: {
            artifact: {
              id: '\ud800',
              url: 'https://artifactshare.com/artifacts/artifact-1',
              title: 'Report',
            },
            project: { id: 'project-1', name: 'Project' },
            visibility: 'workspace',
            version_id: 'version-1',
            replayed: false,
            mapping_created: true,
            project_created: true,
          },
        }),
      ) as typeof fetch,
    })
    await expect(
      client.request(request, { bearer_token: 'token' }),
    ).resolves.toMatchObject({ code: 'invalid_server_response' })
  })

  it.each([
    'https://artifactshare.com/\nforged',
    'https://user:pass@artifactshare.com/artifacts/artifact-1',
  ])('rejects a malformed same-origin artifact URL', async (url) => {
    const client = new ArtifactShareBridgeClient({
      baseUrl: 'https://artifactshare.com',
      fetch: vi.fn(async () =>
        json({
          schema_version: 1,
          ok: true,
          data: {
            artifact: { id: 'artifact-1', url, title: 'Report' },
            project: { id: 'project-1', name: 'Project' },
            visibility: 'workspace',
            version_id: 'version-1',
            replayed: false,
            mapping_created: true,
            project_created: true,
          },
        }),
      ) as typeof fetch,
    })
    await expect(
      client.request(request, { bearer_token: 'token' }),
    ).resolves.toMatchObject({
      code: 'invalid_server_response',
    })
  })

  it('cancels a body whose declared response length is too large', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    const client = new ArtifactShareBridgeClient({
      baseUrl: 'https://artifactshare.com',
      fetch: vi.fn(
        async () =>
          new Response(body, {
            headers: {
              'content-type': 'application/json',
              'content-length': '65537',
            },
          }),
      ) as typeof fetch,
    })
    await expect(
      client.health({ bearer_token: 'token' }),
    ).resolves.toMatchObject({
      code: 'invalid_server_response',
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([
    ['redirect', { status: 302 }],
    ['non-JSON', { headers: { 'content-type': 'text/plain' } }],
  ])('cancels a %s response body before rejecting it', async (_name, init) => {
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    const client = new ArtifactShareBridgeClient({
      baseUrl: 'https://artifactshare.com',
      fetch: vi.fn(async () => new Response(body, init)) as typeof fetch,
    })
    await expect(
      client.health({ bearer_token: 'token' }),
    ).resolves.toMatchObject({
      code: 'invalid_server_response',
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('treats a non-JSON 503 response as a retryable transport failure', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    const client = new ArtifactShareBridgeClient({
      baseUrl: 'https://artifactshare.com',
      fetch: vi.fn(
        async () =>
          new Response(body, {
            status: 503,
            headers: { 'content-type': 'text/html' },
          }),
      ) as typeof fetch,
    })
    await expect(
      client.health({ bearer_token: 'token' }),
    ).resolves.toMatchObject({
      code: 'transport_error',
      retryable: true,
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([
    ['malformed JSON', { body: '{', headers: {} }],
    ['non-protocol JSON', { body: '{"error":"unavailable"}', headers: {} }],
    ['oversized JSON', { body: '{}', headers: { 'content-length': '65537' } }],
  ])(
    'treats a %s 503 response as a retryable transport failure',
    async (_name, init) => {
      const client = new ArtifactShareBridgeClient({
        baseUrl: 'https://artifactshare.com',
        fetch: vi.fn(
          async () =>
            new Response(init.body, {
              status: 503,
              headers: {
                'content-type': 'application/json',
                ...init.headers,
              },
            }),
        ) as typeof fetch,
      })
      await expect(
        client.health({ bearer_token: 'token' }),
      ).resolves.toMatchObject({
        code: 'transport_error',
        retryable: true,
      })
    },
  )
})
