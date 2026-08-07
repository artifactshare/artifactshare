import type { Kysely } from 'kysely'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const state = vi.hoisted(() => ({ db: null as Kysely<DB> | null }))
const slack = vi.hoisted(() => ({
  signSlackNotifyState: vi.fn(),
  slackNotifyOauthCallbackUrl: vi.fn(),
}))
vi.mock('cloudflare:workers', () => ({ env: { SLACK_CLIENT_ID: 'client-id' } }))
vi.mock('~/services/db.server', () => ({ createDb: () => state.db }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'u1', workspaceId: 'w1' }),
}))
vi.mock('~/services/slack.server', () => slack)
vi.mock('~/services/projects.server', () => ({
  findWorkspaceProject: async (
    db: Kysely<DB>,
    workspaceId: string,
    id: string,
  ) =>
    db
      .selectFrom('artifact_containers')
      .select('id')
      .where('id', '=', id)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst(),
}))

import { loader } from './projects.$id.slack.install'

async function fixture() {
  const db = createMigratedInMemoryDb().db as Kysely<DB>
  state.db = db
  await db
    .insertInto('workspaces')
    .values({
      id: 'w1',
      name: 'W',
      hd: null,
      ms_tenant_id: null,
      email_domain: null,
      created_at: '2026-01-01T00:00:00Z',
    })
    .execute()
  await db
    .insertInto('users')
    .values({
      id: 'u1',
      email: 'u@example.com',
      name: 'U',
      email_verified: 1,
      image: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      workspace_id: 'w1',
      locale: null,
    })
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'proj1',
      workspace_id: 'w1',
      kind: 'project',
      owner_user_id: null,
      created_by_id: 'u1',
      name: 'P',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })
    .execute()
}

beforeEach(async () => {
  await fixture()
  vi.clearAllMocks()
  slack.signSlackNotifyState.mockResolvedValue('signed-state')
  slack.slackNotifyOauthCallbackUrl.mockReturnValue(
    'https://example.com/api/slack/notify/callback',
  )
})

describe('project Slack install loader', () => {
  test('redirects to Slack authorize URL', async () => {
    const response = await loader({
      request: new Request('https://example.com/projects/proj1/slack/install'),
      params: { id: 'proj1' },
      context: new Map(),
    } as never)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('client_id=client-id')
    expect(response.headers.get('Location')).toContain('state=signed-state')
  })

  test('returns 404 for an unknown project', async () => {
    await expect(
      loader({
        request: new Request('https://example.com'),
        params: { id: 'missing' },
        context: new Map(),
      } as never),
    ).rejects.toMatchObject({ status: 404 })
  })
})
