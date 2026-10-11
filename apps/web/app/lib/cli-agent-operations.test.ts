import type { CliAuthority } from '~/services/cli-authority.server'
import { describe, expect, test } from 'vitest'
import {
  allowsCliOperation,
  cliScopeDeniedResponse,
} from './cli-agent-operations'

const agent = {
  kind: 'agent' as const,
  familyId: 'family-1',
  workspaceId: 'ws1',
  projectId: 'project-1',
  projectNameSnapshot: 'Agent output',
  agentProfileId: 'agent-1',
}

const bridge = {
  kind: 'bridge' as const,
  familyId: 'family-bridge',
  bridgeAuthorityId: 'bridge-1',
  workspaceId: 'ws1',
  fallbackProjectId: 'fallback-1',
  agentProfileId: 'agent-bridge',
  sourceKind: 'qm',
  sourceInstallationId: 'install-1',
  externalWorkspaceId: 'slack-ws-1',
}

describe('agent operation declaration', () => {
  test('allows the bounded read, publish, append and comment surface', () => {
    expect(allowsCliOperation(agent, 'GET', '/api/cli/artifacts')).toBe(true)
    expect(
      allowsCliOperation(agent, 'POST', '/api/cli/artifacts/a1/comments'),
    ).toBe(true)
    expect(allowsCliOperation(agent, 'POST', '/api/shareables/uploads')).toBe(
      true,
    )
  })

  test('denies edit, move, project management and unknown routes', () => {
    expect(
      allowsCliOperation(agent, 'POST', '/api/cli/shareables/a1/edit'),
    ).toBe(false)
    expect(
      allowsCliOperation(agent, 'POST', '/api/cli/shareables/a1/move'),
    ).toBe(false)
    expect(allowsCliOperation(agent, 'POST', '/api/cli/projects')).toBe(false)
    expect(allowsCliOperation(agent, 'GET', '/api/cli/resolve')).toBe(false)
    expect(allowsCliOperation(agent, 'GET', '/api/cli/future')).toBe(false)
  })

  test('limits bootstrap sessions to diagnosis and credential creation', () => {
    const bootstrap = {
      kind: 'bootstrap' as const,
      preset: 'agent' as const,
      workspaceId: 'ws1',
      projectId: 'project-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }
    expect(allowsCliOperation(bootstrap, 'GET', '/api/cli/whoami')).toBe(true)
    expect(allowsCliOperation(bootstrap, 'GET', '/api/cli/artifacts')).toBe(
      false,
    )
  })

  test('limits bridge credentials to the bridge health and request endpoints', () => {
    expect(allowsCliOperation(bridge, 'GET', '/api/bridge/v1/health')).toBe(
      true,
    )
    expect(allowsCliOperation(bridge, 'POST', '/api/bridge/v1/requests')).toBe(
      true,
    )
    expect(allowsCliOperation(bridge, 'POST', '/api/shareables/uploads')).toBe(
      false,
    )
    expect(allowsCliOperation(bridge, 'GET', '/api/cli/artifacts')).toBe(false)
  })

  test('returns the stable default-deny envelope', async () => {
    const response = cliScopeDeniedResponse()
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'scope-denied',
        recovery: { kind: 'ask_human' },
      },
      agent_recoverable: false,
      requires_human: true,
    })
  })
})

test.each([
  ['GET', '/api/cli/artifacts'],
  ['GET', '/api/cli/doctor'],
  ['GET', '/api/cli/resolve'],
  ['POST', '/api/cli/projects'],
  ['GET', '/api/bridge/v1/health'],
  ['POST', '/api/bridge/v1/requests'],
])('denies unknown authority for %s %s', (method, path) => {
  expect(
    allowsCliOperation(
      { kind: 'unknown' } as unknown as CliAuthority,
      method,
      path,
    ),
  ).toBe(false)
})

const publisher = {
  kind: 'publisher' as const,
  familyId: 'family-1',
  workspaceId: 'ws1',
  publisherClientId: 'client-1',
  publisherClientName: 'Reports',
}
test.each([
  ['GET', '/api/cli/whoami'],
  ['GET', '/api/cli/doctor'],
  ['POST', '/api/cli/auth/refresh-credentials'],
  ['POST', '/api/shareables/uploads'],
  ['POST', '/api/shareables/abc123def4/versions'],
  ['GET', '/api/cli/artifacts/abc123def4/download'],
  ['GET', '/api/cli/artifacts/abc123def4'],
  ['DELETE', '/api/cli/artifacts/abc123def4'],
  ['POST', '/api/cli/shareables/abc123def4/edit'],
  ['PATCH', '/api/cli/shareables/abc123def4/edit'],
])('publisher allows %s %s', (method, path) =>
  expect(allowsCliOperation(publisher, method, path)).toBe(true),
)
test.each([
  ['GET', '/api/cli/artifacts'],
  ['GET', '/api/cli/artifacts/abc123def4/download/index.html'],
  ['GET', '/api/cli/artifacts/abc123def4/download/'],
  ['POST', '/api/cli/artifacts/abc123def4/comments'],
  ['GET', '/api/cli/artifacts/abc123def4/comments'],
  ['POST', '/api/cli/artifacts/abc123def4/append'],
  ['GET', '/api/cli/resolve'],
  ['GET', '/api/cli/projects'],
  ['POST', '/api/cli/projects'],
  ['DELETE', '/api/shareables/abc123def4'],
  ['PATCH', '/api/shareables/abc123def4'],
  ['GET', '/api/shareables/abc123def4/versions'],
  ['POST', '/api/cli/shareables/abc123def4/move'],
  ['POST', '/api/bridge/v1/requests'],
  ['PUT', '/api/shareables/uploads'],
])('publisher denies %s %s', (method, path) =>
  expect(allowsCliOperation(publisher, method, path)).toBe(false),
)
