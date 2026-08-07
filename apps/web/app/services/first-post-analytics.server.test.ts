import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  env: { BETTER_AUTH_SECRET: 'test-secret' },
}))

const sendMock = vi.fn().mockResolvedValue(undefined)
const configuredMock = vi.fn().mockReturnValue(true)
vi.mock('~/lib/analytics/measurement-protocol.server', () => ({
  isMeasurementProtocolConfigured: (...args: unknown[]) =>
    configuredMock(...args),
  sendFirstArtifactPosted: (...args: unknown[]) => sendMock(...args),
}))

import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { hmacSha256Base64Url } from '~/lib/hmac'
import { recordFirstArtifactPost } from './first-post-analytics.server'

async function seedUser(
  db: Awaited<ReturnType<typeof createMigratedInMemoryDb>>['db'],
  id: string,
) {
  await db
    .insertInto('workspaces')
    .values({
      id: `ws-${id}`,
      hd: null,
      ms_tenant_id: null,
      email_domain: null,
      name: 'Workspace',
      created_at: '2026-07-24T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('users')
    .values({
      id,
      email: `${id}@example.com`,
      email_verified: 1,
      name: 'User',
      image: null,
      created_at: '2026-07-24T00:00:00.000Z',
      updated_at: '2026-07-24T00:00:00.000Z',
      workspace_id: `ws-${id}`,
      locale: null,
    })
    .execute()
}

function countRows(
  db: Awaited<ReturnType<typeof createMigratedInMemoryDb>>['db'],
  userId: string,
) {
  return db
    .selectFrom('first_post_analytics')
    .select('user_id')
    .where('user_id', '=', userId)
    .execute()
}

describe('recordFirstArtifactPost', () => {
  beforeEach(() => {
    sendMock.mockClear().mockResolvedValue(undefined)
    configuredMock.mockClear().mockReturnValue(true)
  })

  it('claims once and sends on the first post, and is a no-op on the second', async () => {
    const { db } = createMigratedInMemoryDb()
    await seedUser(db, 'user-1')

    await recordFirstArtifactPost(
      db,
      { id: 'user-1' },
      { channel: 'cli', sendToGa: true },
    )
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(await countRows(db, 'user-1')).toHaveLength(1)

    await recordFirstArtifactPost(
      db,
      { id: 'user-1' },
      { channel: 'web', sendToGa: true },
    )
    // second post: claim conflicts, so no additional send and still one row
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(await countRows(db, 'user-1')).toHaveLength(1)
  })

  it('claims but does not send when consent is not granted (web, sendToGa false), so a later post is not mislabeled as first', async () => {
    const { db } = createMigratedInMemoryDb()
    await seedUser(db, 'user-consent')

    await recordFirstArtifactPost(
      db,
      { id: 'user-consent' },
      { channel: 'web', sendToGa: false },
    )
    // nothing sent to Google, but the row is claimed for dedup
    expect(sendMock).not.toHaveBeenCalled()
    expect(await countRows(db, 'user-consent')).toHaveLength(1)

    // a later post (even with consent) must not fire, since it is not the first
    await recordFirstArtifactPost(
      db,
      { id: 'user-consent' },
      { channel: 'web', sendToGa: true },
    )
    expect(sendMock).not.toHaveBeenCalled()
    expect(await countRows(db, 'user-consent')).toHaveLength(1)
  })

  it('does not claim (or send) when the measurement protocol is unconfigured — fail-closed before the claim', async () => {
    configuredMock.mockReturnValue(false)
    const { db } = createMigratedInMemoryDb()
    await seedUser(db, 'user-2')

    await recordFirstArtifactPost(
      db,
      { id: 'user-2' },
      { channel: 'cli', sendToGa: true },
    )
    expect(sendMock).not.toHaveBeenCalled()
    // the one-time claim must not be burned when we never attempt a send
    expect(await countRows(db, 'user-2')).toHaveLength(0)
  })

  it('derives a stable user_id and a distinct client_id, sending no raw account id', async () => {
    const { db } = createMigratedInMemoryDb()
    await seedUser(db, 'user-3')

    await recordFirstArtifactPost(
      db,
      { id: 'user-3' },
      { channel: 'mcp', sendToGa: true },
    )
    const arg = sendMock.mock.calls[0][0] as {
      userId: string
      clientId: string
      channel: string
    }
    const expectedUserId = await hmacSha256Base64Url(
      'test-secret',
      'ga4:user-3',
    )
    expect(arg.userId).toBe(expectedUserId)
    expect(arg.clientId).toBe(
      await hmacSha256Base64Url('test-secret', 'ga4:cid:user-3'),
    )
    expect(arg.userId).not.toBe(arg.clientId)
    expect(arg.userId).not.toContain('user-3')
    expect(arg.clientId).not.toContain('user-3')
    expect(arg.channel).toBe('mcp')
  })

  it('never throws even if the send fails — analytics must not break publishing', async () => {
    sendMock.mockRejectedValue(new Error('boom'))
    const { db } = createMigratedInMemoryDb()
    await seedUser(db, 'user-4')

    await expect(
      recordFirstArtifactPost(
        db,
        { id: 'user-4' },
        { channel: 'web', sendToGa: true },
      ),
    ).resolves.toBeUndefined()
  })
})
