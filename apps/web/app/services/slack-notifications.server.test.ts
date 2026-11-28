import { describe, expect, test, vi } from 'vitest'
import { sql } from 'kysely'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import {
  slackNotificationEnqueueQuery,
  processSlackNotificationOutbox,
  scheduledJobForCron,
} from './slack-notifications.server'

const postSlackWebhook = vi.fn()
vi.mock('./slack.server', () => ({ postSlackWebhook }))
vi.mock('cloudflare:workers', () => ({ env: {} }))

type OutboxRow = {
  id: string
  container_id: string
  shareable_id: string
  created_at: string
  claimed_at: string | null
  claim_token: string | null
}
type JoinedRow = OutboxRow & {
  channel_id: string
  webhook_url: string
  derived_title: string | null
  title_override: string | null
  name: string
  owner_name: string | null
  project_name: string
}

function outboxDb(input: { outbox: OutboxRow[]; joined: JoinedRow[] }) {
  const claimExpired = '2026-05-21T23:45:00.000Z'
  const outbox = input.outbox
  const deleted: OutboxRow[] = []
  const expiryUpdates: Array<Record<string, unknown>> = []
  const db: any = {
    deleted,
    expiryUpdates,
    deleteFrom: () => {
      const conditions: Array<[string, string, unknown]> = []
      const builder: any = {
        where: (column: string, op: string, value: unknown) => {
          conditions.push([column, op, value])
          return builder
        },
        execute: async () => {
          const remaining: OutboxRow[] = []
          for (const row of outbox) {
            const matches = conditions.every(([column, op, value]) =>
              op === '='
                ? row[column as keyof OutboxRow] === value
                : op === 'in'
                  ? (value as string[]).includes(
                      row[column as keyof OutboxRow] as string,
                    )
                  : op === '<'
                    ? (row[column as keyof OutboxRow] as string) <
                      (value as string)
                    : true,
            )
            if (matches) deleted.push(row)
            else remaining.push(row)
          }
          outbox.length = 0
          outbox.push(...remaining)
        },
      }
      return builder
    },
    updateTable: (table: string) => ({
      set: (values: Partial<OutboxRow>) => {
        if (table === 'container_slack_channels') {
          const builder: any = {
            where: () => builder,
            execute: async () => {
              expiryUpdates.push(values)
              return [{ numUpdatedRows: 1n }]
            },
          }
          return builder
        }
        return {
          where: () => ({
            returningAll: () => ({
              execute: async () => {
                const eligible = outbox.filter(
                  (r) => r.claimed_at === null || r.claimed_at! < claimExpired,
                )
                eligible.forEach((r) => Object.assign(r, values))
                return eligible
              },
            }),
          }),
        }
      },
    }),
    selectFrom: () => ({
      innerJoin: function (this: any) {
        return this
      },
      leftJoin: function (this: any) {
        return this
      },
      select: function (this: any) {
        return this
      },
      where: function (this: any) {
        return this
      },
      execute: async () =>
        input.joined.filter((r) =>
          outbox.some((o) => o.id === r.id && o.claim_token === 'token-a'),
        ),
    }),
  }
  return db
}

const joined = (
  id: string,
  container = 'project-a',
  created_at = '2026-05-21T23:00:00.000Z',
): JoinedRow => ({
  id,
  container_id: container,
  shareable_id: `share-${id}`,
  created_at,
  claimed_at: null,
  claim_token: null,
  channel_id: 'C1',
  webhook_url: 'https://hooks.slack.test/secret',
  derived_title: `Title ${id}`,
  title_override: null,
  name: `name-${id}`,
  owner_name: 'Owner',
  project_name: 'Project',
})
async function process(
  outbox: OutboxRow[],
  rows: JoinedRow[] = outbox.map((r) => joined(r.id)),
  result: { ok: boolean; error?: string } = { ok: true },
) {
  postSlackWebhook.mockResolvedValue(
    result.ok
      ? { ok: true }
      : { ok: false, status: result.error === 'channel_not_found' ? 404 : 500 },
  )
  const db = outboxDb({ outbox, joined: rows })
  await processSlackNotificationOutbox(db, {
    origin: 'https://example.test',
    now: new Date('2026-05-22T00:00:00.000Z'),
    claimToken: 'token-a',
  })
  return db
}

function dbWithChannel(
  connected: boolean,
  lastErrorStatus: number | null = null,
) {
  const insert = { onConflict: vi.fn(() => insert) }
  const expression = vi.fn(() => insert)
  const db = {
    selectFrom: vi.fn(() => ({
      select: vi.fn(() => ({
        where: vi.fn(() => ({
          executeTakeFirst: vi.fn(async () =>
            connected
              ? {
                  container_id: 'project-a',
                  last_error_status: lastErrorStatus,
                }
              : undefined,
          ),
        })),
      })),
    })),
    insertInto: vi.fn(() => ({
      columns: vi.fn(() => ({ expression })),
    })),
  }
  return db as never
}

const args = {
  containerId: 'project-a',
  visibility: 'project' as const,
  slackNotify: true,
  shareableId: 'shareable-a',
  now: '2026-05-22T00:00:00.000Z',
}

describe('slackNotificationEnqueueQuery', () => {
  test('紐付けありプロジェクトへの visibility=project 投稿で query が返る', async () => {
    await expect(
      slackNotificationEnqueueQuery(dbWithChannel(true), args),
    ).resolves.toMatchObject({ query: expect.anything(), suppressed: false })
  })

  test('slackNotify=false では null', async () => {
    await expect(
      slackNotificationEnqueueQuery(dbWithChannel(true), {
        ...args,
        slackNotify: false,
      }),
    ).resolves.toEqual({ query: null, suppressed: false })
  })

  test('visibility=private では null', async () => {
    await expect(
      slackNotificationEnqueueQuery(dbWithChannel(true), {
        ...args,
        visibility: 'private',
      }),
    ).resolves.toEqual({ query: null, suppressed: false })
  })

  test('containerId=null（ホーム投稿）では null', async () => {
    await expect(
      slackNotificationEnqueueQuery(dbWithChannel(true), {
        ...args,
        containerId: null,
      }),
    ).resolves.toEqual({ query: null, suppressed: false })
  })

  test('紐付けなしプロジェクトでは null', async () => {
    await expect(
      slackNotificationEnqueueQuery(dbWithChannel(false), args),
    ).resolves.toEqual({ query: null, suppressed: false })
  })

  test('404 失効中は enqueue を抑止する', async () => {
    await expect(
      slackNotificationEnqueueQuery(dbWithChannel(true, 404), args),
    ).resolves.toEqual({ query: null, suppressed: true })
  })
})

describe('processSlackNotificationOutbox', () => {
  test('scheduledJobForCron は表にある cron だけを振り分ける', () => {
    expect(scheduledJobForCron('*/5 * * * *')).toBe('slack-notifications')
    expect(scheduledJobForCron('0 17 * * *')).toBe('reconciliation')
    // 表にない cron を reconciliation とみなすと、reconciliation の cron を
    // 書き換えてもこのテストが通ってしまう。
    expect(scheduledJobForCron('0 18 * * *')).toBeNull()
    expect(scheduledJobForCron('*/10 * * * *')).toBeNull()
    expect(scheduledJobForCron('')).toBeNull()
    // Object の prototype のキーも cron ではない。
    expect(scheduledJobForCron('toString')).toBeNull()
    expect(scheduledJobForCron('constructor')).toBeNull()
  })

  test('wrangler.production.jsonc の crons が両 job を 1 つずつ覆う', async () => {
    // 設定と振り分けの契約: 本番デプロイが読む wrangler.production.jsonc の
    // cron 式が変わったときに、Slack 通知が止まったり日次リコンサイルが
    // 5 分間隔で走ったりする事故をテストで検知する。既定の wrangler.jsonc は
    // ローカルとプレビューの設定で、日次リコンサイルを持たない。
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(
      new URL('../../wrangler.production.jsonc', import.meta.url),
      'utf8',
    )
    const cronsBlock = raw.match(/"crons":\s*\[([^\]]*)\]/)?.[1] ?? ''
    const crons = [...cronsBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(crons.length).toBeGreaterThan(0)
    const jobs = crons.map((cron) => scheduledJobForCron(cron))
    expect(jobs.filter((j) => j === 'slack-notifications')).toHaveLength(1)
    expect(jobs.filter((j) => j === 'reconciliation')).toHaveLength(1)
    // 本番の cron に、どの job にも対応しないものがない。
    expect(jobs.filter((j) => j === null)).toHaveLength(0)
  })

  test('タイトルと投稿者名の Slack 制御列がエスケープされる', async () => {
    postSlackWebhook.mockClear()
    const row = { ...joined('1'), claim_token: null }
    await process(
      [row],
      [
        {
          ...joined('1'),
          title_override: 'ping <!channel> & <@U123>',
          owner_name: '<b>owner</b>',
        },
      ],
    )
    const text = postSlackWebhook.mock.calls[0][1] as string
    expect(text).toContain('ping &lt;!channel&gt; &amp; &lt;@U123&gt;')
    expect(text).toContain('&lt;b&gt;owner&lt;/b&gt;')
    expect(text).not.toContain('<!channel>')
  })

  test('未処理 1 件を単票 postMessage し、成功後に行が消える', async () => {
    postSlackWebhook.mockClear()
    const row = { ...joined('1'), claim_token: null }
    const db = await process([row])
    expect(postSlackWebhook).toHaveBeenCalledWith(
      'https://hooks.slack.test/secret',
      expect.stringContaining('Title 1'),
    )
    expect(db.deleted).toHaveLength(1)
  })

  test('同一 container の複数行を 1 回の postMessage にまとめる', async () => {
    postSlackWebhook.mockClear()
    await process([joined('1'), joined('2')])
    expect(postSlackWebhook).toHaveBeenCalledTimes(1)
    expect(postSlackWebhook.mock.calls[0][1]).toContain('2 件の新着')
  })

  test('21 件以上では 20 件と「ほか N 件」を送る', async () => {
    postSlackWebhook.mockClear()
    await process(Array.from({ length: 21 }, (_, i) => joined(String(i))))
    const text = postSlackWebhook.mock.calls[0][1]
    expect(text).toContain('21 件の新着')
    expect(text).toContain('ほか 1 件')
    expect(text.match(/https:\/\/example\.test\/a\//g)).toHaveLength(20)
  })

  test('claim 済み（15 分以内）の行は処理対象にならない', async () => {
    postSlackWebhook.mockClear()
    const row = { ...joined('1'), claimed_at: '2026-05-21T23:50:00.000Z' }
    await process([row])
    expect(postSlackWebhook).not.toHaveBeenCalled()
  })

  test('claim 時点で紐付けが消失した行は送信せず削除する', async () => {
    postSlackWebhook.mockClear()
    const db = await process([joined('1')], [])
    expect(postSlackWebhook).not.toHaveBeenCalled()
    expect(db.deleted).toHaveLength(1)
  })

  test('恒久エラー channel_not_found では行を削除する', async () => {
    postSlackWebhook.mockClear()
    const db = await process([joined('1')], undefined, {
      ok: false,
      error: 'channel_not_found',
    })
    expect(db.deleted).toHaveLength(1)
    expect(db.expiryUpdates).toEqual([
      {
        last_error_at: '2026-05-22T00:00:00.000Z',
        last_error_status: 404,
      },
    ])
  })

  test('HTTP 404 では同じ project の未 claim 行も破棄する', async () => {
    postSlackWebhook.mockClear()
    const claimed = joined('1')
    const pending = {
      ...joined('2'),
      claimed_at: '2026-05-21T23:50:00.000Z',
      claim_token: 'token-b',
    }
    const db = await process([claimed, pending], [claimed], {
      ok: false,
      error: 'channel_not_found',
    })
    expect(db.deleted.map((row: OutboxRow) => row.id).sort()).toEqual([
      '1',
      '2',
    ])
  })

  test('HTTP 410 (アーカイブ済み) も恒久エラーとして行を削除する', async () => {
    postSlackWebhook.mockClear()
    postSlackWebhook.mockResolvedValue({ ok: false, status: 410 })
    const db = outboxDb({ outbox: [joined('1')], joined: [joined('1')] })
    await processSlackNotificationOutbox(db, {
      origin: 'https://example.test',
      now: new Date('2026-05-22T00:00:00.000Z'),
      claimToken: 'token-a',
    })
    expect(db.deleted.filter((r: { id: string }) => r.id === '1')).toHaveLength(
      1,
    )
  })

  test('ネットワーク断 (status 0) では行を残して再試行に回す', async () => {
    postSlackWebhook.mockClear()
    postSlackWebhook.mockResolvedValue({ ok: false, status: 0 })
    const db = outboxDb({ outbox: [joined('1')], joined: [joined('1')] })
    await processSlackNotificationOutbox(db, {
      origin: 'https://example.test',
      now: new Date('2026-05-22T00:00:00.000Z'),
      claimToken: 'token-a',
    })
    expect(db.deleted.filter((r: { id: string }) => r.id === '1')).toHaveLength(
      0,
    )
  })

  test('一時エラー ratelimited では行を残す', async () => {
    postSlackWebhook.mockClear()
    const row = joined('1')
    const db = await process([row], undefined, {
      ok: false,
      error: 'ratelimited',
    })
    expect(db.deleted).toHaveLength(0)
    expect(row.claim_token).toBe('token-a')
  })

  test('created_at から 24 時間超の行を破棄する', async () => {
    postSlackWebhook.mockClear()
    const db = await process(
      [{ ...joined('old'), created_at: '2026-05-20T23:59:59.000Z' }],
      [],
    )
    expect(db.deleted).toHaveLength(1)
  })

  test('行削除は claim_token で限定し、別 token の行を消さない', async () => {
    postSlackWebhook.mockClear()
    const row = joined('1')
    const other = {
      ...joined('2'),
      claimed_at: '2026-05-21T23:50:00.000Z',
      claim_token: 'token-b',
    }
    const db = await process([row, other], [row])
    expect(db.deleted.map((r: OutboxRow) => r.id)).toEqual(['1'])
    expect(other.claim_token).toBe('token-b')
  })
})

describe('processSlackNotificationOutbox は送信時点の公開範囲で判断する', () => {
  const now = new Date('2026-05-22T00:00:00.000Z')

  async function seed(state: {
    visibility?: string
    containerId?: string
    linkSuspendedAt?: string | null
    linkExpiresAt?: string | null
    linkSharingEnabled?: number
  }) {
    const { db } = createMigratedInMemoryDb()
    const at = '2026-05-21T23:00:00.000Z'
    await sql`INSERT INTO workspaces (id, hd, name, created_at, link_sharing_enabled)
      VALUES ('ws1', 'example.com', 'Example', ${at}, ${state.linkSharingEnabled ?? 1})`.execute(
      db,
    )
    await sql`INSERT INTO users (id, email, email_verified, name, created_at, updated_at, workspace_id)
      VALUES ('owner', 'owner@example.com', 1, 'Owner', ${at}, ${at}, 'ws1')`.execute(
      db,
    )
    for (const project of ['project-a', 'project-b']) {
      await sql`INSERT INTO artifact_containers (id, workspace_id, kind, created_by_id, name, created_at, updated_at)
        VALUES (${project}, 'ws1', 'project', 'owner', ${project}, ${at}, ${at})`.execute(
        db,
      )
      await sql`INSERT INTO container_slack_channels (container_id, webhook_url, channel_id, channel_name, slack_team_id, slack_team_name, created_at, updated_at)
        VALUES (${project}, ${`https://hooks.slack.test/${project}`}, ${`C-${project}`}, ${project}, 'T1', 'Team', ${at}, ${at})`.execute(
        db,
      )
    }
    await sql`INSERT INTO shareables (id, workspace_id, owner_user_id, name, derived_title, artifact_kind, visibility, created_at, updated_at, container_id, link_suspended_at, link_expires_at)
      VALUES ('share-1', 'ws1', 'owner', 'plan.md', 'Launch plan', 'markdown_page',
        ${state.visibility ?? 'workspace'}, ${at}, ${at}, ${state.containerId ?? 'project-a'},
        ${state.linkSuspendedAt ?? null}, ${state.linkExpiresAt ?? null})`.execute(
      db,
    )
    await sql`INSERT INTO slack_notification_outbox (id, container_id, shareable_id, created_at)
      VALUES ('row-1', 'project-a', 'share-1', ${at})`.execute(db)
    return db
  }

  async function send(
    db: Awaited<ReturnType<typeof seed>>,
    at: Date,
    status = 200,
  ) {
    postSlackWebhook.mockReset()
    postSlackWebhook.mockResolvedValue({ ok: status === 200, status })
    await processSlackNotificationOutbox(db, {
      origin: 'https://example.test',
      now: at,
      claimToken: `token-${at.getTime()}`,
    })
    return {
      posts: postSlackWebhook.mock.calls.map(([url, text]) => ({ url, text })),
      remaining: await db
        .selectFrom('slack_notification_outbox')
        .select('id')
        .execute(),
    }
  }

  async function outboxAfterSend(state: Parameters<typeof seed>[0]) {
    const db = await seed(state)
    const result = await send(db, now)
    await db.destroy()
    return result
  }

  test.each([
    ['workspace', {}],
    ['project', { visibility: 'project' }],
    [
      '有効なリンク',
      { visibility: 'link', linkExpiresAt: '2026-06-01T00:00:00.000Z' },
    ],
  ])('%s の作品はタイトルを送る', async (_label, state) => {
    const { posts, remaining } = await outboxAfterSend(state)
    expect(posts).toEqual([
      {
        url: 'https://hooks.slack.test/project-a',
        text: expect.stringContaining('Launch plan'),
      },
    ])
    expect(remaining).toEqual([])
  })

  test.each([
    ['private に変わった', { visibility: 'private' }],
    [
      'リンクが停止された',
      { visibility: 'link', linkSuspendedAt: '2026-05-21T23:30:00.000Z' },
    ],
    [
      'リンクの期限が切れた',
      { visibility: 'link', linkExpiresAt: '2026-05-21T23:59:00.000Z' },
    ],
    [
      'ワークスペースがリンク共有を止めた',
      { visibility: 'link', linkSharingEnabled: 0 },
    ],
    ['別のプロジェクトへ移動した', { containerId: 'project-b' }],
  ])('%s作品は送らず、行を消す', async (_label, state) => {
    const { posts, remaining } = await outboxAfterSend(state)
    expect(posts).toEqual([])
    expect(remaining).toEqual([])
  })

  test('再試行に回った行も、次の送信時点で private なら送らない', async () => {
    const db = await seed({})
    const first = await send(db, now, 500)
    expect(first.posts).toHaveLength(1)
    expect(first.remaining).toEqual([{ id: 'row-1' }])

    await db
      .updateTable('shareables')
      .set({ visibility: 'private' })
      .where('id', '=', 'share-1')
      .execute()
    const retry = await send(db, new Date(now.getTime() + 20 * 60 * 1000))
    await db.destroy()
    expect(retry.posts).toEqual([])
    expect(retry.remaining).toEqual([])
  })
})
