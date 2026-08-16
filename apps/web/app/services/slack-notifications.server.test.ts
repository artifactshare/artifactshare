import { describe, expect, test, vi } from 'vitest'
import {
  slackNotificationEnqueueQuery,
  processSlackNotificationOutbox,
  scheduledJobForCron,
} from './slack-notifications.server'

const postSlackWebhook = vi.fn()
vi.mock('./slack.server', () => ({ postSlackWebhook }))

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
  const db: any = {
    deleted,
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
    updateTable: () => ({
      set: (values: Partial<OutboxRow>) => ({
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
      }),
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
      values: vi.fn(() => insert),
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
    ).resolves.not.toBeNull()
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
  test('scheduledJobForCron が cron を振り分ける', () => {
    expect(scheduledJobForCron('*/5 * * * *')).toBe('slack-notifications')
    expect(scheduledJobForCron('0 17 * * *')).toBe('reconciliation')
  })

  test.skipIf(globalThis.process.env.PUBLIC_TEST === '1')(
    'wrangler.jsonc の crons が両 job を 1 つずつ覆う',
    async () => {
      // 設定と振り分けの契約: wrangler.jsonc の cron 式が変わったときに、
      // Slack 通知が止まったり日次リコンサイルが 5 分間隔で走ったりする
      // 事故をテストで検知する。
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(
        new URL('../../wrangler.jsonc', import.meta.url),
        'utf8',
      )
      const cronsBlock = raw.match(/"crons":\s*\[([^\]]*)\]/)?.[1] ?? ''
      const crons = [...cronsBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1])
      expect(crons.length).toBeGreaterThan(0)
      const jobs = crons.map((cron) => scheduledJobForCron(cron))
      expect(jobs.filter((j) => j === 'slack-notifications')).toHaveLength(1)
      expect(jobs.filter((j) => j === 'reconciliation')).toHaveLength(1)
    },
  )

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
