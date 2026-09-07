import { beforeEach, describe, expect, test, vi } from 'vitest'
import { signLinkOpsToken } from '~/lib/link-ops-token'

const state = vi.hoisted(() => ({
  suspended: null as null | { at: string; reason: string | null },
}))
const suspendLink = vi.hoisted(() => vi.fn())
const resumeLink = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({
  env: {
    APP_ENV: 'production',
    BETTER_AUTH_URL: 'https://artifactshare.com',
    LINK_OPS_ACTION_SECRET: 'ops-secret',
  },
}))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/services/link-suspension.server', () => ({
  LINK_SUSPENSION_REASON_MAX: 300,
  linkSuspensionState: async (_db: unknown, id: string) =>
    id === 'abc123def4'
      ? {
          shareableId: id,
          workspaceId: 'w'.repeat(21),
          visibility: 'link',
          title: 'report.html',
          suspendedAt: state.suspended?.at ?? null,
          suspendedReason: state.suspended?.reason ?? null,
        }
      : null,
  suspendLink,
  resumeLink,
}))

import { action, doneText, loader } from './ops.link.$id'

const params = { id: 'abc123def4' }
const base = 'https://artifactshare.com/ops/link/abc123def4'

async function token(shareableId = 'abc123def4') {
  return signLinkOpsToken({ shareableId, judgmentId: 'judg-1' }, 'ops-secret')
}

function post(
  body: URLSearchParams,
  contentType = 'application/x-www-form-urlencoded',
) {
  return new Request(base, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  })
}

describe('link ops route', () => {
  beforeEach(() => {
    state.suspended = null
    suspendLink.mockReset().mockResolvedValue({
      kind: 'suspended',
      ownerNotice: 'sent',
    })
    resumeLink.mockReset().mockResolvedValue({
      kind: 'resumed',
      ownerNotice: 'skipped',
    })
  })

  test('the page is not found without a valid token for this shareable', async () => {
    for (const url of [
      base,
      `${base}?token=garbage`,
      `${base}?token=${encodeURIComponent(await token('zzzz123456'))}`,
    ]) {
      await expect(
        loader({ request: new Request(url), params, context: {} } as never),
      ).rejects.toMatchObject({ status: 404 })
    }
  })

  test('a valid token shows the state and lets an operator pause, then resume', async () => {
    const t = await token()
    const data = await loader({
      request: new Request(`${base}?token=${encodeURIComponent(t)}`),
      params,
      context: {},
    } as never)
    expect(data).toMatchObject({
      state: { shareableId: 'abc123def4', suspendedAt: null },
      token: t,
      done: null,
      anonymousUrl: 'https://abc123def4.artifactshare.link/',
    })

    const paused = await action({
      request: post(
        new URLSearchParams({ token: t, move: 'suspend', reason: 'Phishing' }),
      ),
      params,
      context: {},
    } as never)
    expect(paused.status).toBe(303)
    expect(
      new URL(paused.headers.get('Location')!).searchParams.get('done'),
    ).toBe('suspended:sent')
    expect(suspendLink).toHaveBeenCalledWith(expect.anything(), {
      shareableId: 'abc123def4',
      reason: 'Phishing',
      judgmentId: 'judg-1',
    })

    const resumed = await action({
      request: post(new URLSearchParams({ token: t, move: 'resume' })),
      params,
      context: {},
    } as never)
    expect(
      new URL(resumed.headers.get('Location')!).searchParams.get('done'),
    ).toBe('resumed:skipped')
    expect(doneText('resumed:skipped')).toContain('no owner email')
    expect(doneText('__proto__')).toBe('不明な結果 / Unknown result')
  })

  test('a POST without a form body or token is not found and moves nothing', async () => {
    await expect(
      action({
        request: post(new URLSearchParams({ move: 'suspend' }), 'text/plain'),
        params,
        context: {},
      } as never),
    ).rejects.toMatchObject({ status: 404 })
    expect(suspendLink).not.toHaveBeenCalled()
  })
})
