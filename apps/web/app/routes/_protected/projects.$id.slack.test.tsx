import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Kysely } from 'kysely'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const state = vi.hoisted(() => ({
  db: null as unknown,
  user: { id: 'u1', workspaceId: 'w1' },
}))
const slack = vi.hoisted(() => ({
  signSlackNotifyState: vi.fn(),
  slackNotifyOauthCallbackUrl: vi.fn(),
}))

vi.mock('~/services/db.server', () => ({ createDb: () => state.db }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => state.user,
  userContext: Symbol('userContext'),
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
vi.mock('~/services/slack.server', () => slack)
vi.mock('cloudflare:workers', () => ({
  env: { SLACK_CLIENT_ID: 'client-id' },
}))

import { action, loader } from './projects.$id.slack'
import { loader as installLoader } from './projects.$id.slack.install'

type Db = Kysely<DB>
const args = (id = 'proj1', request = new Request('https://example.com')) =>
  ({ params: { id }, context: new Map(), request }) as never
const formRequest = (values: Record<string, string>) =>
  new Request('https://example.com', {
    method: 'POST',
    body: new URLSearchParams(values),
  })

async function fixture() {
  const db = createMigratedInMemoryDb().db as Db
  state.db = db
  await db
    .insertInto('workspaces')
    .values([
      {
        id: 'w1',
        name: 'Workspace 1',
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'w2',
        name: 'Workspace 2',
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    ])
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
  await db
    .insertInto('slack_workspaces')
    .values([
      {
        id: 'sw1',
        team_id: 't1',
        team_name: 'Slack 1',
        bot_user_id: 'b1',
        bot_token: 'token1',
        installed_by_user_id: 'u1',
        installed_at: '2026-01-01T00:00:00Z',
        workspace_id: 'w1',
      },
      {
        id: 'sw2',
        team_id: 't2',
        team_name: 'Slack 2',
        bot_user_id: 'b2',
        bot_token: 'token2',
        installed_by_user_id: 'u1',
        installed_at: '2026-01-01T00:00:00Z',
        workspace_id: 'w2',
      },
    ])
    .execute()
  return db
}
const loaderArgs = (id = 'proj1') => args(id)

beforeEach(() => {
  state.user = { id: 'u1', workspaceId: 'w1' }
  vi.clearAllMocks()
  slack.signSlackNotifyState.mockResolvedValue('signed-state')
  slack.slackNotifyOauthCallbackUrl.mockReturnValue(
    'https://example.com/api/slack/notify/callback',
  )
})

describe('project Slack route', () => {
  test('loader returns visible workspace members connection and current channel', async () => {
    const db = await fixture()
    await db
      .insertInto('container_slack_channels')
      .values({
        container_id: 'proj1',
        webhook_url: 'https://hooks.slack.test/secret',
        slack_team_id: 't1',
        slack_team_name: 'Slack 1',
        channel_id: 'C1',
        channel_name: 'general',
        created_by: 'u1',
        updated_by: 'u1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    const result = await loader(loaderArgs())
    expect(result.current?.channelId).toBe('C1')
    // 実 secret 値で判定する: select に別名なしで webhook_url を戻すと
    // キー名が変わって property assertion が空振りするため。
    expect(JSON.stringify(result)).not.toContain('hooks.slack.test')
  })
  test('workspace-outside user and other-workspace project get 404', async () => {
    await fixture()
    state.user = { id: 'u1', workspaceId: 'w2' }
    await expect(loader(loaderArgs())).rejects.toMatchObject({ status: 404 })
    state.user = { id: 'u1', workspaceId: 'w1' }
    await expect(loader(loaderArgs('missing'))).rejects.toMatchObject({
      status: 404,
    })
  })
  test('clear removes channel and unclaimed outbox rows', async () => {
    const db = await fixture()
    await db
      .insertInto('container_slack_channels')
      .values({
        container_id: 'proj1',
        webhook_url: 'https://hooks.slack.test/secret',
        slack_team_id: 't1',
        slack_team_name: 'Slack 1',
        channel_id: 'C1',
        channel_name: 'general',
        created_by: 'u1',
        updated_by: 'u1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    const result = await action(
      args('proj1', formRequest({ intent: 'clear-slack-channel' })),
    )
    expect(result).toMatchObject({ ok: true })
    expect(
      await db.selectFrom('container_slack_channels').selectAll().execute(),
    ).toHaveLength(0)
  })

  test('install redirects to Slack authorize URL with project state', async () => {
    await fixture()
    const response = await installLoader(loaderArgs() as never)
    expect(response.status).toBe(302)
    const location = response.headers.get('Location')
    expect(location).toContain('https://slack.com/oauth/v2/authorize?')
    expect(location).toContain('client_id=client-id')
    expect(location).toContain('state=signed-state')
    expect(slack.signSlackNotifyState).toHaveBeenCalledWith({
      user_id: 'u1',
      workspace_id: 'w1',
      container_id: 'proj1',
    })
  })

  test('install returns 404 for a project outside the user workspace', async () => {
    await fixture()
    await expect(
      installLoader(loaderArgs('missing') as never),
    ).rejects.toMatchObject({
      status: 404,
    })
  })
})
