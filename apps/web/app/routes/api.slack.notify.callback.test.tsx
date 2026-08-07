import type { Kysely } from 'kysely'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const state = vi.hoisted(() => ({
  db: null as Kysely<DB> | null,
  user: { id: 'u1', workspaceId: 'w1' },
}))
const slack = vi.hoisted(() => ({
  verifySlackNotifyState: vi.fn(),
  exchangeSlackWebhookOauthCode: vi.fn(),
  slackNotifyOauthCallbackUrl: vi.fn(),
}))
const setChannel = vi.hoisted(() => vi.fn())

vi.mock('~/services/db.server', () => ({ createDb: () => state.db }))
vi.mock('~/middleware/auth', () => ({ requireUserMiddleware: {} }))
vi.mock('~/middleware/context', () => ({ requireUser: () => state.user }))
vi.mock('~/services/slack.server', () => slack)
vi.mock('~/services/slack-notifications.server', () => ({
  setContainerSlackChannel: setChannel,
}))
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

import { loader } from './api.slack.notify.callback'

const callback = (query: string) =>
  loader({
    request: new Request(
      `https://example.com/api/slack/notify/callback?${query}`,
    ),
    context: new Map(),
  } as never)

async function fixture() {
  const db = createMigratedInMemoryDb().db as Kysely<DB>
  state.db = db
  await db
    .insertInto('workspaces')
    .values({
      id: 'w1',
      name: 'Workspace',
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
      email: 'u1@example.com',
      name: 'User',
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
      name: 'Project',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })
    .execute()
  return db
}

beforeEach(async () => {
  await fixture()
  state.user = { id: 'u1', workspaceId: 'w1' }
  vi.clearAllMocks()
  slack.verifySlackNotifyState.mockResolvedValue({
    user_id: 'u1',
    workspace_id: 'w1',
    container_id: 'proj1',
    nonce: 'nonce-1',
  })
  slack.slackNotifyOauthCallbackUrl.mockReturnValue(
    'https://example.com/api/slack/notify/callback',
  )
  slack.exchangeSlackWebhookOauthCode.mockResolvedValue({
    webhookUrl: 'https://hooks.slack.test/x',
    channelId: 'C1',
    channelName: 'general',
    teamId: 'T1',
    teamName: 'Team',
    configurationUrl: null,
  })
})

describe('/api/slack/notify/callback loader', () => {
  test('正常系 stores nonce, exchanges code, and redirects connected', async () => {
    const response = await callback('state=valid&code=code')
    expect(response.headers.get('Location')).toContain('slack=connected')
    expect(setChannel).toHaveBeenCalledOnce()
    expect(
      await state.db!.selectFrom('slack_notify_nonces').selectAll().execute(),
    ).toHaveLength(1)
  })

  test('malformed state redirects to the generic error page', async () => {
    slack.verifySlackNotifyState.mockResolvedValue(null)
    expect((await callback('state=%25')).headers.get('Location')).toBe(
      '/projects?slack=error',
    )
  })

  test('ユーザー不一致 redirects without touching the project', async () => {
    slack.verifySlackNotifyState.mockResolvedValue({
      user_id: 'other',
      workspace_id: 'w1',
      container_id: 'proj1',
      nonce: 'n2',
    })
    expect(
      (await callback('state=valid&code=code')).headers.get('Location'),
    ).toBe('/projects?slack=error')
    expect(slack.exchangeSlackWebhookOauthCode).not.toHaveBeenCalled()
  })

  test('nonce 再利用 redirects and does not exchange again', async () => {
    await callback('state=valid&code=code')
    const response = await callback('state=valid&code=code')
    expect(response.headers.get('Location')).toBe('/projects?slack=error')
    expect(slack.exchangeSlackWebhookOauthCode).toHaveBeenCalledOnce()
  })

  test('権限喪失 redirects to the generic error page', async () => {
    state.user = { id: 'u1', workspaceId: 'w2' }
    expect(
      (await callback('state=valid&code=code')).headers.get('Location'),
    ).toBe('/projects?slack=error')
  })

  test('認可拒否 / exchange 失敗 redirects to project error', async () => {
    expect(
      (await callback('state=valid&error=access_denied')).headers.get(
        'Location',
      ),
    ).toContain('/projects/proj1?slack=error')
    slack.verifySlackNotifyState.mockResolvedValue({
      user_id: 'u1',
      workspace_id: 'w1',
      container_id: 'proj1',
      nonce: 'n3',
    })
    slack.exchangeSlackWebhookOauthCode.mockRejectedValue(new Error('failed'))
    expect(
      (await callback('state=valid&code=code')).headers.get('Location'),
    ).toContain('/projects/proj1?slack=error')
  })
})
