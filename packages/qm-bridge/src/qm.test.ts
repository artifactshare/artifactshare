import { describe, expect, it } from 'vitest'
import { normalizeQmAuthenticatedContext } from './qm.js'

describe('qm seam', () => {
  it('normalizes only explicitly supplied authenticated fields', () => {
    expect(
      normalizeQmAuthenticatedContext({
        installationId: 'install-1',
        workspaceId: 'workspace-1',
        conversation: {
          currentId: 'new-id',
          formerIds: ['old-id'],
          kind: 'private_channel',
        },
        requester: {
          stableId: 'person-1',
          verifiedEmail: 'person@example.com',
        },
        requestId: 'request-1',
      }),
    ).toMatchObject({
      source: { kind: 'qm' },
      conversation: { ids: ['new-id', 'old-id'] },
    })
  })

  it('deduplicates rename history while keeping the current id first', () => {
    expect(
      normalizeQmAuthenticatedContext({
        installationId: 'install-1',
        workspaceId: 'workspace-1',
        conversation: {
          currentId: 'channel-a',
          formerIds: ['channel-b', 'channel-a', 'channel-b'],
          kind: 'private_channel',
        },
        requester: {
          stableId: 'person-1',
          verifiedEmail: 'person@example.com',
        },
        requestId: 'request-1',
      }).conversation.ids,
    ).toEqual(['channel-a', 'channel-b'])
  })

  it('keeps the current id and the first fifteen distinct former ids', () => {
    const formerIds = Array.from({ length: 20 }, (_, index) => `old-${index}`)
    expect(
      normalizeQmAuthenticatedContext({
        installationId: 'install-1',
        workspaceId: 'workspace-1',
        conversation: {
          currentId: 'current',
          formerIds,
          kind: 'private_channel',
        },
        requester: {
          stableId: 'person-1',
          verifiedEmail: 'person@example.com',
        },
        requestId: 'request-1',
      }).conversation.ids,
    ).toEqual(['current', ...formerIds.slice(0, 15)])
  })
})
