import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const loadAgentApprovalContextMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiMiddleware: requireUserApiMiddlewareMock,
}))

vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
}))

vi.mock('~/services/cli-device-authority.server', () => ({
  loadAgentApprovalContext: loadAgentApprovalContextMock,
}))

const { loader, middleware } = await import('./api.cli.device-approval')

const user = {
  id: 'user1',
  workspaceId: 'workspace1',
  email: 'user1@example.com',
}

describe('/api/cli/device-approval', () => {
  beforeEach(() => {
    requireUserMock.mockReset()
    loadAgentApprovalContextMock.mockReset()
    requireUserMock.mockReturnValue(user)
  })

  test('requires session middleware', () => {
    expect(middleware).toEqual([requireUserApiMiddlewareMock])
  })

  test('returns the shared approval response for a normalized code', async () => {
    loadAgentApprovalContextMock.mockResolvedValue({
      preset: 'agent',
      deviceName: 'Codex',
      projectSelector: 'Launch',
      fixedProject: {
        id: 'project1',
        name: 'Launch',
        baseVisibility: 'workspace',
        updatedAt: '2026-12-31T00:00:00.000Z',
      },
      fixedProjectError: false,
    })

    const response = await loader({
      context: {},
      request: new Request(
        'https://artifactshare.test/api/cli/device-approval?user_code=ab12-cd34',
      ),
    } as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      agentApproval: {
        preset: 'agent',
        deviceName: 'Codex',
        projectSelector: 'Launch',
        fixedProject: {
          id: 'project1',
          name: 'Launch',
          baseVisibility: 'workspace',
          updatedAt: '2026-12-31T00:00:00.000Z',
        },
        fixedProjectError: false,
      },
    })
    expect(loadAgentApprovalContextMock).toHaveBeenCalledWith(
      'AB12CD34',
      'user1',
      'workspace1',
      'user1@example.com',
    )
  })

  test('returns the legacy null response when no agent approval exists', async () => {
    loadAgentApprovalContextMock.mockResolvedValue(null)

    const response = await loader({
      context: {},
      request: new Request(
        'https://artifactshare.test/api/cli/device-approval?user_code=EF56GH78',
      ),
    } as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ agentApproval: null })
  })

  test('returns the shared null response for malformed query values', async () => {
    for (const query of ['', 'short', 'AB12-CD3!', 'あいうえおおおお']) {
      const response = await loader({
        context: {},
        request: new Request(
          `https://artifactshare.test/api/cli/device-approval?user_code=${encodeURIComponent(query)}`,
        ),
      } as never)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ agentApproval: null })
    }
    expect(loadAgentApprovalContextMock).not.toHaveBeenCalled()
  })
})
