import { env } from 'cloudflare:workers'
import { APEX_HOST } from '~/lib/hosts'
import { deliverAuditedAccessRequestNotification } from './access-request-audit.server'
import type { AccessRequestApprover } from './access-requests.server'
import type { Db } from './db.server'

export async function sendAccessRequestNotifications(
  db: Db,
  input: {
    requestId: string
    requesterName: string | null
    requesterEmail: string
    shareableTitle: string
    approvers: ReadonlyArray<AccessRequestApprover>
    origin?: string
  },
): Promise<void> {
  const email: SendEmail | undefined = env.EMAIL
  if (!email || input.approvers.length === 0) return

  const requester = input.requesterName?.trim() || input.requesterEmail
  const origin = input.origin ?? `https://${APEX_HOST}`
  const url = new URL('/access-requests', origin)
  url.searchParams.set('request', input.requestId)
  const subject = `閲覧リクエスト / Access request from ${requester}`
  const text = [
    `${requester}さん（${input.requesterEmail}）が「${input.shareableTitle}」の閲覧を希望しています。`,
    `${requester} (${input.requesterEmail}) wants to view “${input.shareableTitle}”.`,
    '',
    `リクエストを確認: ${url.toString()}`,
    `Review the request: ${url.toString()}`,
    '',
    '判断と共有範囲の変更はArtifact Shareで行います。このメールから権限が自動的に付与されることはありません。',
    'Review the request and choose who can view in Artifact Share. This email does not grant access automatically.',
  ].join('\n')

  const results = await Promise.all(
    input.approvers.map((approver) =>
      deliverAuditedAccessRequestNotification(
        db,
        {
          requestId: input.requestId,
          channel: 'email',
          endpointKey: approver.userId,
          recipientUserId: approver.userId,
          recipientEmail: approver.email,
        },
        async () => {
          await email.send({
            to: approver.email,
            from: `noreply@${APEX_HOST}`,
            subject,
            text,
          })
        },
      ),
    ),
  )
  const failed = results.filter((result) => result === 'failed').length
  if (failed > 0) {
    console.error(
      JSON.stringify({
        event: 'access_request_email_failed',
        requestId: input.requestId,
        failed,
        attempted: results.filter((result) => result !== 'not-attempted')
          .length,
      }),
    )
  }
}
