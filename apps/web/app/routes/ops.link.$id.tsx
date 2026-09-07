import { env } from 'cloudflare:workers'
import { Form, useLoaderData } from 'react-router'
import { isProduction, linkViewerUrl } from '~/lib/hosts'
import { verifyLinkOpsToken } from '~/lib/link-ops-token'
import { isSandboxArtifactId } from '~/lib/sandbox-block-report'
import { createDb } from '~/services/db.server'
import {
  LINK_SUSPENSION_REASON_MAX,
  linkSuspensionState,
  resumeLink,
  suspendLink,
  type LinkSuspensionState,
} from '~/services/link-suspension.server'
import type { Route } from './+types/ops.link.$id'

// Operator page reached from the Slack judgment notification. The signed
// token in the URL is the only credential; it names one shareable and
// expires. Every move here is a person's decision: the judgment never
// pauses a link by itself.

// The token travels in the query string: never leak it as a referrer.
const NO_STORE = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
} as const

async function authorize(
  request: Request,
  shareableId: string,
  formToken?: string,
) {
  const secret = env.LINK_OPS_ACTION_SECRET
  if (!secret || !isSandboxArtifactId(shareableId)) return null
  const token = new URL(request.url).searchParams.get('token') ?? formToken
  if (!token) return null
  const payload = await verifyLinkOpsToken(token, secret)
  if (!payload || payload.shareableId !== shareableId) return null
  return { token, judgmentId: payload.judgmentId }
}

function notFound() {
  return new Response('Not found', { status: 404, headers: NO_STORE })
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authorize(request, params.id)
  if (!auth) throw notFound()
  const state = await linkSuspensionState(createDb(), params.id)
  if (!state) throw notFound()
  const done = new URL(request.url).searchParams.get('done')
  return {
    state,
    token: auth.token,
    done: done ? doneText(done) : null,
    maxReason: LINK_SUSPENSION_REASON_MAX,
    anonymousUrl: linkViewerUrl(isProduction(env), params.id),
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== 'POST')
    return new Response('Method Not Allowed', { status: 405 })
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.startsWith('application/x-www-form-urlencoded'))
    throw notFound()
  const form = await request.formData()
  const auth = await authorize(
    request,
    params.id,
    String(form.get('token') ?? ''),
  )
  if (!auth) throw notFound()
  const move = String(form.get('move') ?? '')
  const db = createDb()
  const result =
    move === 'suspend'
      ? await suspendLink(db, {
          shareableId: params.id,
          reason: String(form.get('reason') ?? ''),
          judgmentId: auth.judgmentId,
        })
      : move === 'resume'
        ? await resumeLink(db, {
            shareableId: params.id,
            judgmentId: auth.judgmentId,
          })
        : { kind: 'none' as const }
  const done =
    'ownerNotice' in result
      ? `${result.kind}:${result.ownerNotice}`
      : result.kind
  const url = new URL(request.url)
  url.search = ''
  url.searchParams.set('token', auth.token)
  url.searchParams.set('done', done)
  return new Response(null, {
    status: 303,
    headers: { Location: url.toString(), ...NO_STORE },
  })
}

export function headers() {
  return NO_STORE
}

const NOTICE_TEXT = new Map<string, string>([
  ['sent', 'owner にメールしました / the owner was emailed'],
  [
    'skipped',
    'owner へのメールはありません（bot 所有、リンク共有でない、または送信未設定） / no owner email (bot-owned, no longer a link, or delivery not configured)',
  ],
  [
    'failed',
    'owner へのメール送信に失敗しました（ログ参照） / emailing the owner failed (see logs)',
  ],
])
const DONE_TEXT = new Map<string, string>([
  ['suspended', 'リンク共有を一時停止しました / Paused'],
  ['resumed', 'リンク共有を再開しました / Resumed'],
  ['already', 'すでにその状態です。 / Already in that state.'],
  [
    'not-link',
    'このファイルはリンク共有ではありません。 / This file is not link-shared.',
  ],
  ['not-found', '見つかりません。 / Not found.'],
  ['none', '操作していません。 / No action taken.'],
])

export function doneText(done: string): string {
  const [kind, notice] = done.split(':')
  const base = DONE_TEXT.get(kind ?? '') ?? '不明な結果 / Unknown result'
  const noticeText = notice ? NOTICE_TEXT.get(notice) : undefined
  return noticeText ? `${base}; ${noticeText}.` : base
}

export default function LinkOpsPage() {
  const { state, token, done, maxReason, anonymousUrl } =
    useLoaderData<typeof loader>()
  return (
    <main className="mx-auto max-w-xl space-y-6 p-6 text-sm">
      <h1 className="text-lg font-semibold">
        リンク共有の運営操作 / Link share operations
      </h1>
      <Summary state={state} anonymousUrl={anonymousUrl} />
      {done ? (
        <p className="border-l-2 pl-3" role="status">
          {done}
        </p>
      ) : null}
      {state.suspendedAt ? (
        <Form method="post" className="space-y-3">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="move" value="resume" />
          <button type="submit" className="rounded border px-3 py-1">
            復帰する / Resume link sharing
          </button>
        </Form>
      ) : (
        <Form method="post" className="space-y-3">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="move" value="suspend" />
          <label className="block">
            <span>理由（owner に届きます） / Reason (sent to the owner)</span>
            <textarea
              name="reason"
              maxLength={maxReason}
              rows={3}
              className="mt-1 w-full rounded border p-2"
            />
          </label>
          <button type="submit" className="rounded border px-3 py-1">
            一時停止する / Pause link sharing
          </button>
        </Form>
      )}
      <Form method="post">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="move" value="none" />
        <button type="submit" className="rounded border px-3 py-1">
          問題なし / No action
        </button>
      </Form>
    </main>
  )
}

function Summary({
  state,
  anonymousUrl,
}: {
  state: LinkSuspensionState
  anonymousUrl: string
}) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt>file</dt>
      <dd>
        {state.title} ({state.shareableId})
      </dd>
      <dt>visibility</dt>
      <dd>{state.visibility}</dd>
      <dt>anonymous link</dt>
      <dd>
        <a href={anonymousUrl} rel="noreferrer noopener" target="_blank">
          {anonymousUrl}
        </a>
      </dd>
      <dt>status</dt>
      <dd>
        {state.suspendedAt
          ? `一時停止中 / paused since ${state.suspendedAt}${state.suspendedReason ? ` — ${state.suspendedReason}` : ''}`
          : '配信中 / serving'}
      </dd>
    </dl>
  )
}
