import type { CliAuthority } from '~/services/cli-authority.server'
type Variant<K extends CliAuthority['kind']> = Extract<
  CliAuthority,
  { kind: K }
>
export const cliAuthority = {
  unrestricted(
    overrides: Partial<Omit<Variant<'unrestricted'>, 'kind'>> = {},
  ): Variant<'unrestricted'> {
    return { ...overrides, kind: 'unrestricted' }
  },
  bootstrap(
    overrides: Partial<Omit<Variant<'bootstrap'>, 'kind'>> = {},
  ): Variant<'bootstrap'> {
    return {
      preset: 'agent',
      workspaceId: 'ws1',
      projectId: 'project-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      ...overrides,
      kind: 'bootstrap',
    }
  },
  publisher(
    overrides: Partial<Omit<Variant<'publisher'>, 'kind'>> = {},
  ): Variant<'publisher'> {
    return {
      familyId: 'family-1',
      workspaceId: 'ws1',
      publisherClientId: 'publisher-1',
      publisherClientName: 'Publisher',
      ...overrides,
      kind: 'publisher',
    }
  },
  agent(
    overrides: Partial<Omit<Variant<'agent'>, 'kind'>> = {},
  ): Variant<'agent'> {
    return {
      familyId: 'family-1',
      workspaceId: 'ws1',
      projectId: 'project-1',
      projectNameSnapshot: 'Agent output',
      agentProfileId: 'agent-1',
      ...overrides,
      kind: 'agent',
    }
  },
  bridge(
    overrides: Partial<Omit<Variant<'bridge'>, 'kind'>> = {},
  ): Variant<'bridge'> {
    return {
      familyId: 'family-bridge',
      bridgeAuthorityId: 'bridge-1',
      workspaceId: 'ws1',
      fallbackProjectId: 'fallback-1',
      agentProfileId: 'agent-bridge',
      sourceKind: 'qm',
      sourceInstallationId: 'install-1',
      externalWorkspaceId: 'slack-ws-1',
      ...overrides,
      kind: 'bridge',
    }
  },
}
