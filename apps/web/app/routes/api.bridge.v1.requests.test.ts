import { beforeEach, describe, expect, test, vi } from 'vitest'

const getCliAuthorityMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const executeBridgeRequestMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireBridgeBearerMiddleware: vi.fn(),
}))
vi.mock('~/middleware/context', () => ({
  getCliAuthority: getCliAuthorityMock,
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({ createDb: createDbMock }))
vi.mock('~/services/bridge-publishing.server', () => ({
  executeBridgeRequest: executeBridgeRequestMock,
}))

import { action } from './api.bridge.v1.requests'

const authority = {
  kind: 'bridge' as const,
  familyId: 'family-1',
  bridgeAuthorityId: 'bridge-1',
  workspaceId: 'ws1',
  fallbackProjectId: 'fallback-1',
  agentProfileId: 'agent-1',
  sourceKind: 'qm',
  sourceInstallationId: 'install-1',
  externalWorkspaceId: 'slack-ws-1',
}

beforeEach(() => {
  getCliAuthorityMock.mockReset().mockReturnValue(authority)
  requireUserMock.mockReset().mockReturnValue({
    id: 'bot1',
    workspaceId: 'ws1',
    emailVerified: true,
    hd: 'example.com',
  })
  createDbMock.mockReset().mockReturnValue({})
  executeBridgeRequestMock.mockReset().mockResolvedValue({
    kind: 'ok',
    result: {
      artifact: {
        id: 'artifact-1',
        url: 'https://artifactshare.test/a/artifact-1',
        title: 'Report',
      },
      project: { id: 'project-1', name: 'Design' },
      visibility: 'private',
      versionId: 'version-1',
      replayed: false,
      mappingCreated: true,
      projectCreated: true,
    },
  })
})

describe('/api/bridge/v1/requests', () => {
  test('passes the bounded multipart request to the bridge service', async () => {
    const metadata = { schema_version: 1, request_id: 'request-1' }
    const form = new FormData()
    form.set('metadata', JSON.stringify(metadata))
    form.append(
      'file',
      new File(['hello'], 'file-0', { type: 'text/markdown' }),
    )

    const response = await action({
      context: new Map(),
      request: new Request(
        'https://artifactshare.test/api/bridge/v1/requests',
        {
          method: 'POST',
          body: form,
        },
      ),
    } as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      schema_version: 1,
      ok: true,
      data: {
        artifact: {
          id: 'artifact-1',
          url: 'https://artifactshare.test/a/artifact-1',
          title: 'Report',
        },
        project: { id: 'project-1', name: 'Design' },
        visibility: 'private',
        version_id: 'version-1',
        replayed: false,
        mapping_created: true,
        project_created: true,
      },
    })
    expect(executeBridgeRequestMock).toHaveBeenCalledWith(
      expect.anything(),
      authority,
      expect.objectContaining({ id: 'bot1' }),
      metadata,
      [expect.any(File)],
      'https://artifactshare.test',
    )
  })

  test('rejects non-bridge credentials before parsing the body', async () => {
    getCliAuthorityMock.mockReturnValue({ kind: 'unrestricted' })
    const response = await action({
      context: new Map(),
      request: new Request(
        'https://artifactshare.test/api/bridge/v1/requests',
        {
          method: 'POST',
          body: 'not multipart',
        },
      ),
    } as never)
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'unsupported-authority' },
    })
    expect(executeBridgeRequestMock).not.toHaveBeenCalled()
  })

  test('returns a bounded 413 for an oversized multipart header', async () => {
    const boundary = 'bridge-boundary'
    const body = [
      `--${boundary}`,
      `X-Oversized: ${'a'.repeat(8_200)}`,
      'Content-Disposition: form-data; name="metadata"',
      '',
      '{}',
      `--${boundary}--`,
      '',
    ].join('\r\n')
    const response = await action({
      context: new Map(),
      request: new Request(
        'https://artifactshare.test/api/bridge/v1/requests',
        {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body,
        },
      ),
    } as never)

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'payload-too-large' },
    })
    expect(executeBridgeRequestMock).not.toHaveBeenCalled()
  })

  test('returns bridge JSON for malformed multipart input', async () => {
    const response = await action({
      context: new Map(),
      request: new Request(
        'https://artifactshare.test/api/bridge/v1/requests',
        {
          method: 'POST',
          headers: { 'Content-Type': 'multipart/form-data' },
          body: 'missing boundary',
        },
      ),
    } as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      schema_version: 1,
      ok: false,
      error: { code: 'invalid-context' },
    })
    expect(executeBridgeRequestMock).not.toHaveBeenCalled()
  })

  test('returns a retryable bridge error for unexpected service failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    executeBridgeRequestMock.mockRejectedValue(new Error('D1 unavailable'))
    const form = new FormData()
    form.set('metadata', JSON.stringify({ schema_version: 1 }))

    const response = await action({
      context: new Map(),
      request: new Request(
        'https://artifactshare.test/api/bridge/v1/requests',
        { method: 'POST', body: form },
      ),
    } as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      schema_version: 1,
      ok: false,
      error: {
        code: 'internal-error',
        retryable: true,
        retry_after_ms: 1_000,
      },
    })
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  test('preserves retry metadata for an in-progress idempotency lease', async () => {
    executeBridgeRequestMock.mockResolvedValue({
      kind: 'idempotency-in-progress',
    })
    const form = new FormData()
    form.set('metadata', JSON.stringify({ schema_version: 1 }))
    const response = await action({
      context: new Map(),
      request: new Request(
        'https://artifactshare.test/api/bridge/v1/requests',
        {
          method: 'POST',
          body: form,
        },
      ),
    } as never)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'idempotency-in-progress',
        retryable: true,
        retry_after_ms: 1_000,
      },
    })
  })
})
