import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Kysely } from 'kysely'
import { MESSAGES } from '~/i18n/messages'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import {
  deleteWorkspaceSlackConnection,
  exchangeSlackWebhookOauthCode,
  processSlackLinkShared,
  signSlackInstallState,
  verifySlackInstallState,
  type SlackUnfurlPayload,
} from './slack.server'

const loadPreviewExcerptMock = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({
  env: {
    SLACK_LINK_STATE_SECRET: 'test-slack-link-secret',
    SLACK_CLIENT_ID: 'test-client-id',
    SLACK_CLIENT_SECRET: 'test-client-secret',
  },
}))

vi.mock('~/services/content.server', () => ({
  loadPreviewExcerpt: loadPreviewExcerptMock,
}))

describe('signSlackInstallState / verifySlackInstallState', () => {
  const secret = 'test-slack-link-secret'

  test('round-trips workspace_id through sign and verify', async () => {
    const state = await signSlackInstallState(
      { admin_user_id: 'user-1', workspace_id: 'ws-a' },
      secret,
    )
    const verified = await verifySlackInstallState(state, secret)
    expect(verified).toEqual({
      admin_user_id: 'user-1',
      workspace_id: 'ws-a',
    })
  })
})

describe('processSlackLinkShared', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    loadPreviewExcerptMock.mockReset()
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    await seedSlackUnfurl(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('eligible workspace markdown unfurl includes brand, title link, type icon, excerpt, meta, and open button', async () => {
    await seedEligibleMarkdownShareable(db)
    loadPreviewExcerptMock.mockResolvedValue('Preview body text for Slack.')

    const linkUrl = 'https://artifactshare.com/a/md123abc'
    const calls = await runUnfurl(db, linkUrl)
    expect(calls).toHaveLength(1)

    const blocks = getUnfurlBlocks(calls[0], linkUrl)
    const serialized = JSON.stringify(blocks)

    expect(blocks[0]).toMatchObject({ type: 'context' })
    expect(serialized).toContain('apple-touch-icon.png')
    expect(serialized).toContain('Artifact Share')
    expect(serialized).toContain(
      '*<https://artifactshare.com/a/md123abc|README>*',
    )
    expect(serialized).toContain('Preview body text for Slack.')
    expect(serialized).toContain('/file-types/md.png')
    expect(serialized).toContain('Design Docs')
    expect(serialized).toContain('Markdown')
    expect(serialized).toContain('Owner')
    expect(serialized).not.toContain('owner@example.com')
    expect(serialized).toContain('Open')
    expect(loadPreviewExcerptMock).toHaveBeenCalledWith(
      'artifacts/md123abc/version-md/index.md',
      'markdown_page',
    )
  })

  test('prefers the display title (title_override) over the filename', async () => {
    await seedEligibleMarkdownShareable(db)
    await db
      .updateTable('shareables')
      .set({ title_override: '手入力タイトル' })
      .where('id', '=', 'md123abc')
      .execute()
    loadPreviewExcerptMock.mockResolvedValue(null)

    const linkUrl = 'https://artifactshare.com/a/md123abc'
    const calls = await runUnfurl(db, linkUrl)
    const serialized = JSON.stringify(getUnfurlBlocks(calls[0], linkUrl))
    expect(serialized).toContain('|手入力タイトル>')
  })

  test('escapes mrkdwn in container name and owner display name', async () => {
    await seedEligibleMarkdownShareable(db)
    await db
      .updateTable('artifact_containers')
      .set({ name: '*Bold* <https://evil|x>' })
      .where('id', '=', 'project-docs')
      .execute()
    await db
      .updateTable('users')
      .set({ name: '_Italic_ <https://evil|y>' })
      .where('id', '=', 'owner-1')
      .execute()
    loadPreviewExcerptMock.mockResolvedValue(null)

    const linkUrl = 'https://artifactshare.com/a/md123abc'
    const calls = await runUnfurl(db, linkUrl)
    const serialized = JSON.stringify(getUnfurlBlocks(calls[0], linkUrl))

    expect(serialized).toContain('*Bold* &lt;https://evil|x&gt;')
    expect(serialized).toContain('_Italic_ &lt;https://evil|y&gt;')
    expect(serialized).not.toContain('<https://evil|x>')
    expect(serialized).not.toContain('<https://evil|y>')
  })

  test('ineligible private shareables omit the excerpt but still show the type icon', async () => {
    const linkUrl = 'https://artifactshare.com/a/site123abc'
    const calls = await runUnfurl(db, linkUrl)
    expect(calls).toHaveLength(1)

    const blocks = getUnfurlBlocks(calls[0], linkUrl)
    const serialized = JSON.stringify(blocks)

    // 本文抜粋は出さない (private)。種別アイコンは中身を晒さないので全共有範囲で出す。
    expect(loadPreviewExcerptMock).not.toHaveBeenCalled()
    expect(serialized).not.toContain('preview.png')
    expect(serialized).toContain('/file-types/site.png')
    expect(serialized).toContain('Static Site')
    expect(serialized).toContain('Site')
    expect(serialized).toContain('Open')
  })

  test('uses owner locale for open button and kind label', async () => {
    await db
      .updateTable('users')
      .set({ locale: 'ja' })
      .where('id', '=', 'owner-1')
      .execute()
    await seedEligibleMarkdownShareable(db)
    loadPreviewExcerptMock.mockResolvedValue(null)

    const linkUrl = 'https://artifactshare.com/a/md123abc'
    const calls = await runUnfurl(db, linkUrl)
    const serialized = JSON.stringify(getUnfurlBlocks(calls[0], linkUrl))

    expect(serialized).toContain(MESSAGES.ja['slack.open'])
    expect(serialized).toContain(MESSAGES.ja['slack.kind.markdown_page'])
  })

  test('labels static site bundles as Site in rich unfurls', async () => {
    const linkUrl = 'https://artifactshare.com/a/site123abc'
    const calls = await runUnfurl(db, linkUrl)
    const serialized = JSON.stringify(getUnfurlBlocks(calls[0], linkUrl))

    expect(serialized).toContain('Site')
    expect(serialized).not.toContain('preview.png')
  })

  test('rich-unfurls for an email-matched user without a slack_user_links row, case-insensitively', async () => {
    const calls: SlackUnfurlPayload[] = []
    await processSlackLinkShared(
      db,
      {
        team_id: 'T123',
        user: 'U-unlinked',
        channel: 'C123',
        message_ts: '1710000000.000000',
        links: [{ url: 'https://artifactshare.com/a/site123abc' }],
      },
      'https://artifactshare.com/api/slack/events',
      () => ({
        chatUnfurl: async (payload) => {
          calls.push(payload)
        },
        usersInfo: vi.fn(async () => ({
          ok: true,
          email: 'Owner@Example.com',
        })),
      }),
    )

    expect(calls).toHaveLength(1)
    const serialized = JSON.stringify(
      getUnfurlBlocks(calls[0], 'https://artifactshare.com/a/site123abc'),
    )
    expect(serialized).toContain('Site')
  })

  test('falls back to Connect CTA when users.info returns no email (missing users:read.email scope)', async () => {
    const calls: SlackUnfurlPayload[] = []
    await processSlackLinkShared(
      db,
      {
        team_id: 'T123',
        user: 'U-unlinked',
        channel: 'C123',
        message_ts: '1710000000.000000',
        links: [{ url: 'https://artifactshare.com/a/site123abc' }],
      },
      'https://artifactshare.com/api/slack/events',
      () => ({
        chatUnfurl: async (payload) => {
          calls.push(payload)
        },
        usersInfo: vi.fn(async () => ({ ok: true, email: null })),
      }),
    )

    expect(calls).toHaveLength(1)
    const payload = calls[0]
    expect(payload.user_auth_required).toBe(true)
    if (!('user_auth_required' in payload) || !payload.user_auth_required) {
      throw new Error('expected Connect CTA payload')
    }
    expect(payload.user_auth_message).toBe(MESSAGES.en['slack.connect.text'])
    expect(JSON.stringify(payload.user_auth_blocks)).toContain(
      MESSAGES.en['slack.connect.text'],
    )
    expect(JSON.stringify(payload.user_auth_blocks)).toContain(
      MESSAGES.en['slack.connect.button'],
    )
  })

  test('does not rich-unfurl private artifacts for linked users without access', async () => {
    await db
      .insertInto('workspaces')
      .values({
        id: 'ws-b',
        hd: 'other.example',
        name: 'Other Workspace',
        created_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('users')
      .values({
        id: 'viewer-1',
        email: 'viewer@other.example',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
        workspace_id: 'ws-b',
        locale: null,
      })
      .execute()
    await db
      .updateTable('slack_user_links')
      .set({ artifactshare_user_id: 'viewer-1' })
      .where('id', '=', 'slack-link-1')
      .execute()

    const calls = await runUnfurl(db, 'https://artifactshare.com/a/site123abc')
    expect(calls).toHaveLength(0)
  })

  test('type icon accessory uses the per-kind icon url and the kind label as alt_text', async () => {
    await seedEligibleMarkdownShareable(db)
    loadPreviewExcerptMock.mockResolvedValue(null)

    const linkUrl = 'https://artifactshare.com/a/md123abc'
    const calls = await runUnfurl(db, linkUrl)
    const blocks = getUnfurlBlocks(calls[0], linkUrl)
    const titleSection = blocks.find(
      (block) => block.type === 'section' && 'accessory' in block,
    )
    expect(titleSection).toMatchObject({
      accessory: {
        type: 'image',
        image_url: expect.stringContaining('/file-types/md.png'),
        alt_text: MESSAGES.en['slack.kind.markdown_page'],
      },
    })
  })
})

async function runUnfurl(
  db: Kysely<DB>,
  linkUrl: string,
): Promise<SlackUnfurlPayload[]> {
  const calls: SlackUnfurlPayload[] = []
  await processSlackLinkShared(
    db,
    {
      team_id: 'T123',
      user: 'U123',
      channel: 'C123',
      message_ts: '1710000000.000000',
      links: [{ url: linkUrl }],
    },
    'https://artifactshare.com/api/slack/events',
    () => ({
      chatUnfurl: async (payload) => {
        calls.push(payload)
      },
      usersInfo: vi.fn(),
    }),
  )
  return calls
}

function getUnfurlBlocks(payload: SlackUnfurlPayload, linkUrl: string) {
  expect(payload.user_auth_required).toBeUndefined()
  if ('user_auth_required' in payload) {
    throw new Error('expected rich unfurl payload')
  }
  return payload.unfurls[linkUrl]?.blocks ?? []
}

async function seedEligibleMarkdownShareable(db: Kysely<DB>) {
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'project-docs',
      workspace_id: 'ws-a',
      kind: 'project',
      owner_user_id: 'owner-1',
      created_by_id: 'owner-1',
      name: 'Design Docs',
      description: null,
      base_visibility: 'workspace',
      archived_at: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: 'md123abc',
      workspace_id: 'ws-a',
      owner_user_id: 'owner-1',
      slug: null,
      name: 'README.md',
      derived_title: 'README',
      title_override: null,
      description: null,
      artifact_kind: 'markdown_page',
      visibility: 'workspace',
      current_version_id: 'version-md',
      container_id: 'project-docs',
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      last_accessed_at: null,
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: 'version-md',
      shareable_id: 'md123abc',
      artifact_kind: 'markdown_page',
      status: 'published',
      entrypoint_path: 'README.md',
      r2_key: 'artifacts/md123abc/version-md/index.md',
      size_bytes: 64,
      sha256: 'sha-md',
      created_by_id: 'owner-1',
      created_at: '2026-05-22T00:00:00.000Z',
      published_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}

async function seedSlackUnfurl(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values({
      id: 'ws-a',
      hd: 'example.com',
      name: 'Workspace',
      created_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('users')
    .values({
      id: 'owner-1',
      email: 'owner@example.com',
      email_verified: 1,
      name: 'Owner',
      image: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      workspace_id: 'ws-a',
      locale: null,
    })
    .execute()
  await db
    .insertInto('slack_workspaces')
    .values({
      id: 'slack-ws-1',
      team_id: 'T123',
      team_name: 'Slack Workspace',
      bot_user_id: 'B123',
      bot_token: 'xoxb-test',
      installed_by_user_id: 'owner-1',
      installed_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('slack_user_links')
    .values({
      id: 'slack-link-1',
      slack_team_id: 'T123',
      slack_user_id: 'U123',
      artifactshare_user_id: 'owner-1',
      linked_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'owner-inbox',
      workspace_id: 'ws-a',
      kind: 'inbox',
      owner_user_id: 'owner-1',
      created_by_id: 'owner-1',
      name: '未整理',
      description: null,
      archived_at: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: 'site123abc',
      workspace_id: 'ws-a',
      owner_user_id: 'owner-1',
      slug: null,
      name: 'index.html',
      derived_title: 'Static Site',
      title_override: null,
      description: null,
      artifact_kind: 'static_site',
      visibility: 'private',
      current_version_id: 'version-1',
      container_id: 'owner-inbox',
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      last_accessed_at: null,
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: 'version-1',
      shareable_id: 'site123abc',
      artifact_kind: 'static_site',
      status: 'published',
      entrypoint_path: 'index.html',
      r2_key: 'artifacts/site123abc/version-1/index.html',
      size_bytes: 128,
      sha256: 'sha',
      created_by_id: 'owner-1',
      created_at: '2026-05-22T00:00:00.000Z',
      published_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}

describe('deleteWorkspaceSlackConnection', () => {
  let db: Kysely<DB>
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    await seedDeleteConnectionBase(db)
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, revoked: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await db.destroy()
  })

  test('admin can delete a connection in their workspace', async () => {
    await seedAdmin(db, 'u1', 'ws1')
    await seedSlackWorkspaceRow(db, 'sw1', 'ws1')

    const result = await deleteWorkspaceSlackConnection(
      db,
      actor('u1', 'ws1'),
      'sw1',
    )

    expect(result).toEqual({ kind: 'ok' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/auth.revoke',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer xoxb-test',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({}),
      },
    )
    const remaining = await db
      .selectFrom('slack_workspaces')
      .select('id')
      .execute()
    expect(remaining).toEqual([])
  })

  test('keeps the connection when Slack token revoke fails', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'fatal_error' }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    await seedAdmin(db, 'u1', 'ws1')
    await seedSlackWorkspaceRow(db, 'sw1', 'ws1')

    const result = await deleteWorkspaceSlackConnection(
      db,
      actor('u1', 'ws1'),
      'sw1',
    )

    expect(result).toEqual({ kind: 'external-failed' })
    const remaining = await db
      .selectFrom('slack_workspaces')
      .select('id')
      .execute()
    expect(remaining).toEqual([{ id: 'sw1' }])
  })

  test('non-admin cannot delete a connection', async () => {
    await seedAdmin(db, 'u1', 'ws1')
    await seedSlackWorkspaceRow(db, 'sw1', 'ws1')

    const result = await deleteWorkspaceSlackConnection(
      db,
      actor('u2', 'ws1'),
      'sw1',
    )

    expect(result).toEqual({ kind: 'forbidden' })
    expect(fetchMock).not.toHaveBeenCalled()
    const remaining = await db
      .selectFrom('slack_workspaces')
      .select('id')
      .execute()
    expect(remaining).toEqual([{ id: 'sw1' }])
  })

  test('admin cannot delete a connection from another workspace', async () => {
    await seedAdmin(db, 'u1', 'ws1')
    await seedSlackWorkspaceRow(db, 'sw2', 'ws2')

    const result = await deleteWorkspaceSlackConnection(
      db,
      actor('u1', 'ws1'),
      'sw2',
    )

    expect(result).toEqual({ kind: 'not-found' })
    expect(fetchMock).not.toHaveBeenCalled()
    const remaining = await db
      .selectFrom('slack_workspaces')
      .select('id')
      .execute()
    expect(remaining).toEqual([{ id: 'sw2' }])
  })
})

function actor(id: string, workspaceId: string) {
  return { id, workspaceId }
}

async function seedDeleteConnectionBase(db: Kysely<DB>) {
  const now = '2026-06-01T00:00:00.000Z'
  await db
    .insertInto('workspaces')
    .values([
      {
        id: 'ws1',
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        name: 'One',
        created_at: now,
      },
      {
        id: 'ws2',
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        name: 'Two',
        created_at: now,
      },
    ])
    .execute()
  await db
    .insertInto('users')
    .values([
      {
        id: 'u1',
        email: 'u1@example.com',
        email_verified: 1,
        name: 'User 1',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: 'ws1',
        locale: null,
      },
      {
        id: 'u2',
        email: 'u2@example.com',
        email_verified: 1,
        name: 'User 2',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: 'ws1',
        locale: null,
      },
    ])
    .execute()
}

async function seedAdmin(db: Kysely<DB>, userId: string, workspaceId: string) {
  const now = '2026-06-01T00:00:00.000Z'
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: workspaceId,
      user_id: userId,
      role: 'admin',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute()
}

async function seedSlackWorkspaceRow(
  db: Kysely<DB>,
  id: string,
  workspaceId: string,
) {
  await db
    .insertInto('slack_workspaces')
    .values({
      id,
      team_id: `T-${id}`,
      team_name: `Slack ${id}`,
      bot_user_id: 'B123',
      bot_token: 'xoxb-test',
      installed_by_user_id: 'u1',
      installed_at: '2026-06-20T12:00:00.000Z',
      workspace_id: workspaceId,
    })
    .execute()
}

describe('exchangeSlackWebhookOauthCode', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('maps the incoming_webhook payload and strips the leading # from the channel name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            incoming_webhook: {
              url: 'https://hooks.slack.test/T0/B0/x',
              channel: '#general',
              channel_id: 'C1',
              configuration_url: 'https://slack.test/config',
            },
            team: { id: 'T0', name: 'Team' },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    await expect(
      exchangeSlackWebhookOauthCode('code', 'https://app.test/cb'),
    ).resolves.toEqual({
      webhookUrl: 'https://hooks.slack.test/T0/B0/x',
      channelId: 'C1',
      channelName: 'general',
      configurationUrl: 'https://slack.test/config',
      teamId: 'T0',
      teamName: 'Team',
    })
  })

  test('throws when the response has no incoming_webhook', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, team: { id: 'T0' } }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    await expect(
      exchangeSlackWebhookOauthCode('code', 'https://app.test/cb'),
    ).rejects.toThrow()
  })
})
