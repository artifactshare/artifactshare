import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import {
  anonymousViewSignal,
  cleanupExpiredAnonymousViewSignals,
  recordAnonymousViewSignalAndMaybeJudge,
  startLinkAbuseJudgment,
} from './link-abuse-signals.server'

describe('anonymous link abuse signals', () => {
  beforeEach(() => vi.restoreAllMocks())

  test('keeps only a normalized referrer hostname and viewer ad parameter name', () => {
    const signal = anonymousViewSignal(
      new Request(
        'https://abc123def4.artifactshare.link/?fbclid=viewer-secret',
        {
          headers: {
            Referer:
              'https://SEARCH.Example.COM./results?q=private&gclid=referrer-secret',
          },
        },
      ),
    )
    expect(signal).toEqual({
      referrerHost: 'search.example.com',
      adClickParam: 'fbclid',
    })
    expect(JSON.stringify(signal)).not.toMatch(/private|secret/u)
  })

  test('does not treat an ad parameter on the referrer as a click signal', () => {
    expect(
      anonymousViewSignal(
        new Request('https://abc123def4.artifactshare.link/', {
          headers: { Referer: 'https://search.example.test/?gclid=secret' },
        }),
      ),
    ).toEqual({ referrerHost: 'search.example.test', adClickParam: null })
  })

  test.each([
    ['not a url', null],
    ['file:///private/path?gclid=secret', null],
    ['', null],
  ])('rejects non-http referrer %s', (referrer, expected) => {
    expect(
      anonymousViewSignal(
        new Request('https://abc123def4.artifactshare.link/', {
          headers: referrer ? { Referer: referrer } : undefined,
        }),
      ).referrerHost,
    ).toBe(expected)
  })

  test('persists counted views and uses the D1 rows for spike detection', async () => {
    const { db } = await fixture()
    await db
      .insertInto('anonymous_view_signals')
      .values({
        id: 'signal-before',
        shareable_id: 'abc123def4',
        workspace_id: 'ws-1',
        viewed_at: '2026-09-06T00:10:00.000Z',
        referrer_host: null,
        ad_click_param: null,
      })
      .execute()
    const create = vi.fn(async () => ({ id: 'workflow-1' }))

    await recordAnonymousViewSignalAndMaybeJudge(db, triggerEnv(create), {
      shareableId: 'abc123def4',
      workspaceId: 'ws-1',
      request: new Request('https://abc123def4.artifactshare.link/'),
      counted: true,
      now: new Date('2026-09-06T01:00:00.000Z'),
    })

    expect(
      await db
        .selectFrom('anonymous_view_signals')
        .selectAll()
        .orderBy('viewed_at')
        .execute(),
    ).toHaveLength(2)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          shareableId: 'abc123def4',
          kind: 'automatic',
          trigger: 'view_spike',
          detail: '2_views_in_60_minutes',
          expiresAt: '2026-09-06T07:00:00.000Z',
        },
      }),
    )
  })

  test('does not persist or judge a view rejected by the existing dedup', async () => {
    const { db } = await fixture()
    const create = vi.fn()
    await recordAnonymousViewSignalAndMaybeJudge(db, triggerEnv(create), {
      shareableId: 'abc123def4',
      workspaceId: 'ws-1',
      request: new Request(
        'https://abc123def4.artifactshare.link/?gclid=secret',
      ),
      counted: false,
    })
    expect(
      await db.selectFrom('anonymous_view_signals').selectAll().execute(),
    ).toEqual([])
    expect(create).not.toHaveBeenCalled()
  })

  test('acquires an atomic D1 gate and applies the shorter manual cooldown', async () => {
    const { db } = await fixture()
    const create = vi.fn(async () => ({ id: 'workflow-1' }))
    const env = triggerEnv(create)
    const at = (minute: number) => ({
      shareableId: 'abc123def4',
      trigger: 'manual' as const,
      detail: 'owner_requested',
      now: new Date(`2026-09-06T00:0${minute}:00.000Z`),
    })

    const results = await Promise.all([
      startLinkAbuseJudgment(db, env, at(0)),
      startLinkAbuseJudgment(db, env, at(0)),
    ])
    expect(results.map((result) => result.kind).sort()).toEqual([
      'cooldown',
      'started',
    ])
    await expect(startLinkAbuseJudgment(db, env, at(4))).resolves.toEqual({
      kind: 'cooldown',
      retryAfterSeconds: 60,
    })
    await expect(startLinkAbuseJudgment(db, env, at(6))).resolves.toEqual({
      kind: 'started',
    })
    expect(create).toHaveBeenCalledTimes(2)
  })

  test('keeps manual and automatic cooldowns independent', async () => {
    const { db } = await fixture()
    const create = vi.fn(async () => ({ id: 'workflow-1' }))
    const env = triggerEnv(create)
    const now = new Date('2026-09-06T00:00:00.000Z')

    await expect(
      startLinkAbuseJudgment(db, env, {
        shareableId: 'abc123def4',
        trigger: 'view_spike',
        detail: '200_views_in_60_minutes',
        now,
      }),
    ).resolves.toEqual({ kind: 'started' })
    await expect(
      startLinkAbuseJudgment(db, env, {
        shareableId: 'abc123def4',
        trigger: 'manual',
        detail: 'owner_requested',
        now,
      }),
    ).resolves.toEqual({ kind: 'started' })
    expect(create).toHaveBeenCalledTimes(2)
  })

  test('uses a safe retry delay when the stored gate expiry is invalid', async () => {
    const { db } = await fixture()
    await db
      .insertInto('link_abuse_judgment_gates')
      .values({
        shareable_id: 'abc123def4',
        kind: 'manual',
        expires_at: 'invalid',
      })
      .execute()

    await expect(
      startLinkAbuseJudgment(db, triggerEnv(vi.fn()), {
        shareableId: 'abc123def4',
        trigger: 'manual',
        detail: 'owner_requested',
        now: new Date('2026-09-06T00:00:00.000Z'),
      }),
    ).resolves.toEqual({ kind: 'cooldown', retryAfterSeconds: 60 })
  })

  test('short-circuits spike counting while the automatic gate is armed', async () => {
    const { db } = await fixture()
    await db
      .insertInto('anonymous_view_signals')
      .values({
        id: 'signal-before',
        shareable_id: 'abc123def4',
        workspace_id: 'ws-1',
        viewed_at: '2026-09-06T00:30:00.000Z',
        referrer_host: null,
        ad_click_param: null,
      })
      .execute()
    await db
      .insertInto('link_abuse_judgment_gates')
      .values({
        shareable_id: 'abc123def4',
        kind: 'automatic',
        expires_at: '2026-09-06T02:00:00.000Z',
      })
      .execute()
    const create = vi.fn()

    await recordAnonymousViewSignalAndMaybeJudge(db, triggerEnv(create), {
      shareableId: 'abc123def4',
      workspaceId: 'ws-1',
      request: new Request('https://abc123def4.artifactshare.link/'),
      counted: true,
      now: new Date('2026-09-06T01:00:00.000Z'),
    })

    expect(create).not.toHaveBeenCalled()
  })

  test('catches and logs signal persistence and automatic start failures', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const brokenDb = {
      insertInto: () => {
        throw new Error('db unavailable')
      },
    }
    await expect(
      recordAnonymousViewSignalAndMaybeJudge(
        brokenDb as never,
        triggerEnv(vi.fn()),
        {
          shareableId: 'abc123def4',
          workspaceId: 'ws-1',
          request: new Request('https://abc123def4.artifactshare.link/'),
          counted: true,
        },
      ),
    ).resolves.toBeUndefined()

    const { db } = await fixture()
    const create = vi.fn().mockRejectedValueOnce(new Error('offline'))
    const env = { ...triggerEnv(create), LINK_ABUSE_SPIKE_THRESHOLD: '999' }
    await recordAnonymousViewSignalAndMaybeJudge(db, env, {
      shareableId: 'abc123def4',
      workspaceId: 'ws-1',
      request: new Request(
        'https://abc123def4.artifactshare.link/?gclid=secret',
      ),
      counted: true,
      now: new Date('2026-09-06T00:00:00.000Z'),
    })
    expect(error).toHaveBeenCalledWith(
      'link_abuse_signal_failed',
      expect.objectContaining({ shareableId: 'abc123def4' }),
    )
  })

  test('returns failed and releases the gate when workflow creation fails', async () => {
    const { db } = await fixture()
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ id: 'workflow-2' })
    const env = triggerEnv(create)
    const args = {
      shareableId: 'abc123def4',
      trigger: 'manual' as const,
      detail: 'owner_requested',
      now: new Date('2026-09-06T00:00:00.000Z'),
    }
    await expect(startLinkAbuseJudgment(db, env, args)).resolves.toEqual({
      kind: 'failed',
    })
    await expect(startLinkAbuseJudgment(db, env, args)).resolves.toEqual({
      kind: 'started',
    })
  })

  test('prunes anonymous view signals older than 30 days', async () => {
    const { db } = await fixture()
    await db
      .insertInto('anonymous_view_signals')
      .values([
        {
          id: 'old',
          shareable_id: 'abc123def4',
          workspace_id: 'ws-1',
          viewed_at: '2026-08-06T23:59:59.999Z',
          referrer_host: null,
          ad_click_param: null,
        },
        {
          id: 'boundary',
          shareable_id: 'abc123def4',
          workspace_id: 'ws-1',
          viewed_at: '2026-08-07T00:00:00.000Z',
          referrer_host: null,
          ad_click_param: null,
        },
      ])
      .execute()
    await expect(
      cleanupExpiredAnonymousViewSignals(
        db,
        new Date('2026-09-06T00:00:00.000Z'),
      ),
    ).resolves.toBe(1)
    expect(
      await db.selectFrom('anonymous_view_signals').select('id').execute(),
    ).toEqual([{ id: 'boundary' }])
  })
})

function triggerEnv(create: ReturnType<typeof vi.fn>) {
  return {
    LINK_ABUSE_JUDGMENT_WORKFLOW: { create } as unknown as Workflow,
    LINK_ABUSE_SPIKE_WINDOW_MINUTES: '60',
    LINK_ABUSE_SPIKE_THRESHOLD: '2',
    LINK_ABUSE_JUDGMENT_COOLDOWN_MINUTES: '360',
    LINK_ABUSE_MANUAL_COOLDOWN_MINUTES: '5',
  }
}

async function fixture() {
  const result = createMigratedInMemoryDb()
  const { db } = result
  await db
    .insertInto('workspaces')
    .values({
      id: 'ws-1',
      name: 'Workspace',
      hd: null,
      ms_tenant_id: null,
      email_domain: null,
      created_at: '2026-01-01T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('users')
    .values({
      id: 'owner-1',
      email: 'owner@example.test',
      name: 'Owner',
      email_verified: 1,
      image: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      workspace_id: 'ws-1',
      locale: null,
    })
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'container-1',
      workspace_id: 'ws-1',
      kind: 'inbox',
      owner_user_id: 'owner-1',
      created_by_id: 'owner-1',
      name: 'Inbox',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: 'abc123def4',
      workspace_id: 'ws-1',
      owner_user_id: 'owner-1',
      name: 'Artifact',
      artifact_kind: 'html_page',
      visibility: 'link',
      container_id: 'container-1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    .execute()
  return result
}
