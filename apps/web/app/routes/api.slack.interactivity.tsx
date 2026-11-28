import { env } from 'cloudflare:workers'
import { verifySlackRequestSignature } from '~/services/slack.server'
import type { Route } from './+types/api.slack.interactivity'

export const loader = () => new Response('Not found', { status: 404 })

// URL button (navigation only) は Slack に payload を送らないが、actions block
// を含む ephemeral を出す App には Slack が Interactivity Request URL の登録を
// 要求する (未登録だと Connect ボタンに警告ダイアログが出る)。署名検証 + 200 ACK。
export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (!env.SLACK_SIGNING_SECRET) {
    return Response.json(
      { error: 'missing-slack-signing-secret' },
      { status: 500 },
    )
  }
  const body = await request.text()
  const ok = await verifySlackRequestSignature(
    body,
    request.headers,
    env.SLACK_SIGNING_SECRET,
  )
  if (!ok) return new Response('Invalid signature', { status: 401 })
  return new Response('', { status: 200 })
}
