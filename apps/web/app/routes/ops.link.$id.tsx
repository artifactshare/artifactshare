import { env } from 'cloudflare:workers'
import { Form, useLoaderData } from 'react-router'
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

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

async function authorize(request: Request, shareableId: string) {
  const secret = env.LINK_OPS_ACTION_SECRET
  if (!secret || !isSandboxArtifactId(shareableId)) return null
  const url = new URL(request.url)
  const token =
    url.searchParams.get('token') ??
    (request.method === 'POST'
      ? String((await request.clone().formData()).get('token') ?? '')
      : '')
  if (!token) return null
  const payload = await verifyLinkOpsToken(token, secret)
  if (!payload || payload.shareableId !== shareableId) return null
  return { token, judgmentId: payload.judgmentId }
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authorize(request, params.id)
  if (!auth) throw new Response('Not found', { status: 404, headers: NO_STORE })
  const state = await linkSuspensionState(createDb(), params.id)
  if (!state)
    throw new Response('Not found', { status: 404, headers: NO_STORE })
  const done = new URL(request.url).searchParams.get('done')
  return {
    state,
    token: auth.token,
    done,
    maxReason: LINK_SUSPENSION_REASON_MAX,
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== 'POST')
    return new Response('Method Not Allowed', { status: 405 })
  const auth = await authorize(request, params.id)
  if (!auth) throw new Response('Not found', { status: 404, headers: NO_STORE })
  const form = await request.formData()
  const move = String(form.get('move') ?? '')
  const db = createDb()
  let done: string
  if (move === 'suspend') {
    const result = await suspendLink(db, {
      shareableId: params.id,
      reason: String(form.get('reason') ?? ''),
      judgmentId: auth.judgmentId,
    })
    done = result.kind
  } else if (move === 'resume') {
    const result = await resumeLink(db, {
      shareableId: params.id,
      judgmentId: auth.judgmentId,
    })
    done = result.kind
  } else {
    done = 'none'
  }
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

const DONE_TEXT: Record<string, string> = {
  suspended:
    'リンク共有を一時停止し、owner にメールしました。 / Paused; the owner was emailed.',
  resumed:
    'リンク共有を再開し、owner にメールしました。 / Resumed; the owner was emailed.',
  already: 'すでにその状態です。 / Already in that state.',
  'not-link':
    'このファイルはリンク共有ではありません。 / This file is not link-shared.',
  'not-found': '見つかりません。 / Not found.',
  none: '操作していません。 / No action taken.',
}

export default function LinkOpsPage() {
  const { state, token, done, maxReason } = useLoaderData<typeof loader>()
  return (
    <main className="mx-auto max-w-xl space-y-6 p-6 text-sm">
      <h1 className="text-lg font-semibold">
        リンク共有の運営操作 / Link share operations
      </h1>
      <Summary state={state} />
      {done ? (
        <p className="border-l-2 pl-3" role="status">
          {DONE_TEXT[done] ?? done}
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

function Summary({ state }: { state: LinkSuspensionState }) {
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
        <a href={`https://${state.shareableId}.artifactshare.link/`}>
          {state.shareableId}.artifactshare.link
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
