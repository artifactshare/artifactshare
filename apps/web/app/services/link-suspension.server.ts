import { env } from 'cloudflare:workers'
import type { Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { nowIso } from '~/lib/datetime'
import { APEX_HOST } from '~/lib/hosts'
import type { DB } from '~/types/db'

// An operator pauses a link share while reviewing it (from the Slack judgment
// notification) and resumes it afterwards; the owner is told by email and by
// a banner on the file, and can appeal from that banner. Nothing here runs
// without a person: the judgment workflow only announces, and the pause is
// an explicit operator action on the signed ops page.

export const LINK_SUSPENSION_REASON_MAX = 300
export const LINK_APPEAL_MESSAGE_MAX = 1000
const APPEAL_COOLDOWN_MS = 60 * 60 * 1000

export type LinkSuspensionState = {
  shareableId: string
  workspaceId: string
  visibility: string
  title: string
  suspendedAt: string | null
  suspendedReason: string | null
}

export type OwnerNotice = {
  kind: 'suspended' | 'resumed'
  shareableId: string
  title: string
  ownerEmail: string
  reason: string | null
}

export type LinkSuspensionResult = {
  kind: 'suspended' | 'resumed' | 'already' | 'not-link' | 'not-found'
}

export type LinkAppealResult =
  | { kind: 'appealed' }
  | { kind: 'not-found' | 'forbidden' | 'not-suspended' | 'cooldown' }

export async function linkSuspensionState(
  db: Kysely<DB>,
  shareableId: string,
): Promise<LinkSuspensionState | null> {
  const row = await db
    .selectFrom('shareables')
    .select([
      'id',
      'workspace_id',
      'visibility',
      'name',
      'derived_title',
      'title_override',
      'link_suspended_at',
      'link_suspended_reason',
    ])
    .where('id', '=', shareableId)
    .executeTakeFirst()
  if (!row) return null
  return {
    shareableId: row.id,
    workspaceId: row.workspace_id,
    visibility: row.visibility,
    title: row.title_override ?? row.derived_title ?? row.name,
    suspendedAt: row.link_suspended_at,
    suspendedReason: row.link_suspended_reason,
  }
}

function ownerOf(db: Kysely<DB>, shareableId: string) {
  return db
    .selectFrom('shareables')
    .innerJoin('users', 'users.id', 'shareables.owner_user_id')
    .select([
      'shareables.id',
      'shareables.workspace_id',
      'shareables.visibility',
      'shareables.link_suspended_at',
      'shareables.name',
      'shareables.derived_title',
      'shareables.title_override',
      'users.email as owner_email',
    ])
    .where('shareables.id', '=', shareableId)
    .executeTakeFirst()
}

export async function suspendLink(
  db: Kysely<DB>,
  args: {
    shareableId: string
    reason: string
    judgmentId?: string | null
    now?: string
    notify?: (notice: OwnerNotice) => Promise<void>
  },
): Promise<LinkSuspensionResult> {
  const row = await ownerOf(db, args.shareableId)
  if (!row) return { kind: 'not-found' }
  if (row.visibility !== 'link') return { kind: 'not-link' }
  if (row.link_suspended_at) return { kind: 'already' }
  const now = args.now ?? nowIso()
  const reason = args.reason.trim().slice(0, LINK_SUSPENSION_REASON_MAX)
  await db
    .updateTable('shareables')
    .set({
      link_suspended_at: now,
      link_suspended_reason: reason || null,
      updated_at: now,
    })
    .where('id', '=', args.shareableId)
    .where('link_suspended_at', 'is', null)
    .execute()
  await db
    .insertInto('events')
    .values({
      id: nanoid(),
      workspace_id: row.workspace_id,
      type: 'link_suspended',
      shareable_id: row.id,
      actor_user_id: null,
      subject_id: nanoid(),
      payload: JSON.stringify({
        reason: reason || null,
        judgmentId: args.judgmentId ?? null,
      }),
      created_at: now,
    })
    .execute()
  console.warn('artifactshare_link_suspension', {
    action: 'suspend',
    shareableId: row.id,
    workspaceId: row.workspace_id,
  })
  await (args.notify ?? sendOwnerNotice)({
    kind: 'suspended',
    shareableId: row.id,
    title: row.title_override ?? row.derived_title ?? row.name,
    ownerEmail: row.owner_email,
    reason: reason || null,
  })
  return { kind: 'suspended' }
}

export async function resumeLink(
  db: Kysely<DB>,
  args: {
    shareableId: string
    judgmentId?: string | null
    now?: string
    notify?: (notice: OwnerNotice) => Promise<void>
  },
): Promise<LinkSuspensionResult> {
  const row = await ownerOf(db, args.shareableId)
  if (!row) return { kind: 'not-found' }
  if (!row.link_suspended_at) return { kind: 'already' }
  const now = args.now ?? nowIso()
  await db
    .updateTable('shareables')
    .set({
      link_suspended_at: null,
      link_suspended_reason: null,
      updated_at: now,
    })
    .where('id', '=', args.shareableId)
    .execute()
  await db
    .insertInto('events')
    .values({
      id: nanoid(),
      workspace_id: row.workspace_id,
      type: 'link_resumed',
      shareable_id: row.id,
      actor_user_id: null,
      subject_id: nanoid(),
      payload: JSON.stringify({ judgmentId: args.judgmentId ?? null }),
      created_at: now,
    })
    .execute()
  console.warn('artifactshare_link_suspension', {
    action: 'resume',
    shareableId: row.id,
    workspaceId: row.workspace_id,
  })
  await (args.notify ?? sendOwnerNotice)({
    kind: 'resumed',
    shareableId: row.id,
    title: row.title_override ?? row.derived_title ?? row.name,
    ownerEmail: row.owner_email,
    reason: null,
  })
  return { kind: 'resumed' }
}

export async function appealLinkSuspension(
  db: Kysely<DB>,
  user: { id: string },
  args: { shareableId: string; message: string; now?: string },
): Promise<LinkAppealResult> {
  const row = await db
    .selectFrom('shareables')
    .select(['id', 'workspace_id', 'owner_user_id', 'link_suspended_at'])
    .where('id', '=', args.shareableId)
    .executeTakeFirst()
  if (!row) return { kind: 'not-found' }
  if (row.owner_user_id !== user.id) return { kind: 'forbidden' }
  if (!row.link_suspended_at) return { kind: 'not-suspended' }
  const now = args.now ?? nowIso()
  const since = new Date(Date.parse(now) - APPEAL_COOLDOWN_MS).toISOString()
  const recent = await db
    .selectFrom('events')
    .select('id')
    .where('shareable_id', '=', row.id)
    .where('type', '=', 'link_appealed')
    .where('created_at', '>=', since)
    .executeTakeFirst()
  if (recent) return { kind: 'cooldown' }
  const message = args.message.trim().slice(0, LINK_APPEAL_MESSAGE_MAX)
  await db
    .insertInto('events')
    .values({
      id: nanoid(),
      workspace_id: row.workspace_id,
      type: 'link_appealed',
      shareable_id: row.id,
      actor_user_id: user.id,
      subject_id: nanoid(),
      payload: JSON.stringify({ message }),
      created_at: now,
    })
    .execute()
  console.warn('artifactshare_link_appeal', {
    shareableId: row.id,
    workspaceId: row.workspace_id,
    manageUrl: `https://${APEX_HOST}/a/${row.id}`,
  })
  return { kind: 'appealed' }
}

/** Email the owner; a delivery failure is logged and never fails the action. */
export async function sendOwnerNotice(notice: OwnerNotice): Promise<void> {
  const email: SendEmail | undefined = env.EMAIL
  if (!email) return
  const manageUrl = `https://${APEX_HOST}/a/${notice.shareableId}`
  const subject =
    notice.kind === 'suspended'
      ? `リンク共有を一時停止しました / Link sharing paused: ${notice.title}`
      : `リンク共有を再開しました / Link sharing resumed: ${notice.title}`
  const text =
    notice.kind === 'suspended'
      ? [
          `「${notice.title}」のリンク共有を、運営が確認のため一時停止しました。`,
          `Link sharing for “${notice.title}” was paused by the operators while they review it.`,
          '',
          notice.reason ? `理由 / Reason: ${notice.reason}` : null,
          notice.reason ? '' : null,
          `停止中もあなたと個別共有の相手は開けます。異議はファイルのページから送れます: ${manageUrl}`,
          `You and the people you shared it with can still open it. You can appeal from the file's page: ${manageUrl}`,
        ]
      : [
          `「${notice.title}」のリンク共有を再開しました。`,
          `Link sharing for “${notice.title}” has been resumed.`,
          '',
          `ファイル: ${manageUrl}`,
          `File: ${manageUrl}`,
        ]
  try {
    await email.send({
      to: notice.ownerEmail,
      from: `noreply@${APEX_HOST}`,
      subject,
      text: text.filter((line) => line !== null).join('\n'),
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'link_suspension_email_failed',
        shareableId: notice.shareableId,
        kind: notice.kind,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
