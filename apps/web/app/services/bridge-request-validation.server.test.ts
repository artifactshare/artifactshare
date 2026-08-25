import { describe, expect, test } from 'vitest'
import {
  parseBridgeIntent,
  parseTrustedBridgeContext,
} from './bridge-request-validation.server'

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

function metadata() {
  return {
    schema_version: 1,
    request_id: 'request-1',
    operation: 'publish',
    requested_audience: 'workspace',
    source: {
      kind: 'qm',
      installation_id: 'install-1',
      external_workspace_id: 'slack-ws-1',
    },
    conversation: {
      current_id: 'channel-1',
      ids: ['channel-old', 'channel-1'],
      kind: 'public_channel',
      name: 'design',
      privacy_checked_at: '2026-08-26T00:00:00.000Z',
    },
    requester: {
      stable_id: 'person-1',
      verified_email: 'Person@Example.com',
      display_name: 'Person',
    },
    content: {
      kind: 'file',
      files: [
        {
          index: 0,
          path: 'note.md',
          media_type: 'text/markdown',
          size: 5,
          sha256: 'a'.repeat(64),
        },
      ],
    },
  }
}

describe('trusted bridge request validation', () => {
  test('validates and normalizes the host-owned context separately', () => {
    const result = parseTrustedBridgeContext(
      metadata(),
      authority,
      new Date('2026-08-26T00:00:30.000Z'),
    )
    expect(result).toEqual({
      kind: 'ok',
      context: {
        requestId: 'request-1',
        source: {
          kind: 'qm',
          installationId: 'install-1',
          externalWorkspaceId: 'slack-ws-1',
        },
        conversation: {
          currentId: 'channel-1',
          ids: ['channel-old', 'channel-1'],
          kind: 'public_channel',
          name: 'design',
          privacyCheckedAt: '2026-08-26T00:00:00.000Z',
        },
        requester: {
          stableId: 'person-1',
          verifiedEmail: 'person@example.com',
          displayName: 'Person',
        },
      },
    })
  })

  test('rejects a source outside the credential namespace', () => {
    const value = metadata()
    value.source.external_workspace_id = 'other-workspace'
    expect(
      parseTrustedBridgeContext(
        value,
        authority,
        new Date('2026-08-26T00:00:30.000Z'),
      ),
    ).toEqual({ kind: 'invalid-context' })
  })

  test('rejects stale or future public privacy evidence', () => {
    expect(
      parseTrustedBridgeContext(
        metadata(),
        authority,
        new Date('2026-08-26T00:01:00.001Z'),
      ),
    ).toEqual({ kind: 'stale-context' })
    expect(
      parseTrustedBridgeContext(
        metadata(),
        authority,
        new Date('2026-08-25T23:59:54.999Z'),
      ),
    ).toEqual({ kind: 'stale-context' })
  })

  test('accepts private context without public freshness evidence', () => {
    const value = metadata()
    value.conversation.kind = 'private_channel'
    delete (value.conversation as Partial<typeof value.conversation>)
      .privacy_checked_at
    expect(
      parseTrustedBridgeContext(
        value,
        authority,
        new Date('2026-08-26T01:00:00.000Z'),
      ).kind,
    ).toBe('ok')
  })

  test('validates operation shape and exact file descriptors', () => {
    expect(parseBridgeIntent(metadata())).toMatchObject({
      kind: 'ok',
      intent: {
        operation: 'publish',
        requestedAudience: 'workspace',
        contentKind: 'file',
      },
    })
    const value = metadata()
    value.content.files[0]!.index = 1
    expect(parseBridgeIntent(value)).toEqual({ kind: 'invalid-context' })
  })

  test('preserves valid edge whitespace in a file path', () => {
    const value = metadata()
    value.content.files[0]!.path = ' report.md'

    expect(parseBridgeIntent(value)).toMatchObject({
      kind: 'ok',
      intent: { files: [{ path: ' report.md' }] },
    })
  })
})
