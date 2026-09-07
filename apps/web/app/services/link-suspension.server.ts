import { env } from 'cloudflare:workers'
import { sql, type Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { runD1Batch } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import { APEX_HOST } from '~/lib/hosts'
import { linkOpsUrl, signLinkOpsToken } from '~/lib/link-ops-token'
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

export type OwnerNoticeOutcome = 'sent' | 'skipped' | 'failed'

export type LinkSuspensionResult =
  | { kind: 'suspended' | 'resumed'; ownerNotice: OwnerNoticeOutcome }
  | { kind: 'already' | 'not-link' | 'not-found' }

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
      'users.kind as owner_kind',
    ])
    .where('shareables.id', '=', shareableId)
    .executeTakeFirst()
}

/** Clip to `max` code points so a surrogate pair is never split. */
function clipCodePoints(value: string, max: number): string {
  return Array.from(value.trim()).slice(0, max).join('')
}

type OwnerRow = NonNullable<Awaited<ReturnType<typeof ownerOf>>>

/**
 * Pause or resume in one D1 batch: the event is inserted only while the
 * shareable is in the state the move leaves, the flag update carries the same
 * guard, and an audit row records the operator action (no actor: the signed
 * token names the judgment, not a person). Whether the event landed decides
 * "already". `updated_at` is left alone: a moderation action is not an edit
 * and must not reorder the owner's lists.
 */
async function transitionLink(
  db: Kysely<DB>,
  row: OwnerRow,
  move: 'suspend' | 'resume',
  args: {
    reason: string | null
    judgmentId: string | null
    now: string
    notify: (notice: OwnerNotice) => Promise<OwnerNoticeOutcome>
  },
): Promise<LinkSuspensionResult> {
  const suspending = move === 'suspend'
  const eventId = nanoid()
  const payload = JSON.stringify(
    suspending
      ? { reason: args.reason, judgmentId: args.judgmentId }
      : { judgmentId: args.judgmentId },
  )
  await runD1Batch(
    db,
    db
      .insertInto('events')
      .columns([
        'id',
        'workspace_id',
        'type',
        'shareable_id',
        'actor_user_id',
        'subject_id',
        'payload',
        'created_at',
      ])
      .expression((eb) =>
        eb
          .selectFrom('shareables')
          .select([
            eb.val(eventId).as('id'),
            eb.val(row.workspace_id).as('workspace_id'),
            eb.val(suspending ? 'link_suspended' : 'link_resumed').as('type'),
            eb.val(row.id).as('shareable_id'),
            eb.val(null).as('actor_user_id'),
            eb.val(nanoid()).as('subject_id'),
            eb.val(payload).as('payload'),
            eb.val(args.now).as('created_at'),
          ])
          .where('id', '=', row.id)
          .$if(suspending, (q) =>
            q
              .where('visibility', '=', 'link')
              .where('link_suspended_at', 'is', null),
          )
          .$if(!suspending, (q) =>
            q.where('link_suspended_at', 'is not', null),
          ),
      ),
    db
      .updateTable('shareables')
      .set(
        suspending
          ? { link_suspended_at: args.now, link_suspended_reason: args.reason }
          : { link_suspended_at: null, link_suspended_reason: null },
      )
      .where('id', '=', row.id)
      .$if(suspending, (q) =>
        q
          .where('visibility', '=', 'link')
          .where('link_suspended_at', 'is', null),
      )
      .$if(!suspending, (q) => q.where('link_suspended_at', 'is not', null)),
    db.insertInto('audit_events').values({
      id: nanoid(16),
      workspace_id: row.workspace_id,
      actor_user_id: null,
      action: suspending ? 'shareable.link.suspend' : 'shareable.link.resume',
      subject_type: 'shareable',
      subject_id: row.id,
      detail: payload,
      created_at: args.now,
    }),
  )
  const recorded = await db
    .selectFrom('events')
    .select('id')
    .where('id', '=', eventId)
    .executeTakeFirst()
  if (!recorded) return { kind: 'already' }
  // A bot-owned share has no human inbox; a share that is no longer a link
  // gets its flag cleared without a "resumed" email that would be untrue.
  const ownerNotice =
    row.owner_kind === 'bot' || (!suspending && row.visibility !== 'link')
      ? 'skipped'
      : await args.notify({
          kind: suspending ? 'suspended' : 'resumed',
          shareableId: row.id,
          title: row.title_override ?? row.derived_title ?? row.name,
          ownerEmail: row.owner_email,
          reason: suspending ? args.reason : null,
        })
  console.warn('artifactshare_link_suspension', {
    action: move,
    shareableId: row.id,
    workspaceId: row.workspace_id,
    ownerNotice,
  })
  return { kind: suspending ? 'suspended' : 'resumed', ownerNotice }
}

export async function suspendLink(
  db: Kysely<DB>,
  args: {
    shareableId: string
    reason: string
    judgmentId?: string | null
    now?: string
    notify?: (notice: OwnerNotice) => Promise<OwnerNoticeOutcome>
  },
): Promise<LinkSuspensionResult> {
  const row = await ownerOf(db, args.shareableId)
  if (!row) return { kind: 'not-found' }
  if (row.visibility !== 'link') return { kind: 'not-link' }
  if (row.link_suspended_at) return { kind: 'already' }
  const reason = clipCodePoints(args.reason, LINK_SUSPENSION_REASON_MAX)
  return transitionLink(db, row, 'suspend', {
    reason: reason || null,
    judgmentId: args.judgmentId ?? null,
    now: args.now ?? nowIso(),
    notify: args.notify ?? sendOwnerNotice,
  })
}

export async function resumeLink(
  db: Kysely<DB>,
  args: {
    shareableId: string
    judgmentId?: string | null
    now?: string
    notify?: (notice: OwnerNotice) => Promise<OwnerNoticeOutcome>
  },
): Promise<LinkSuspensionResult> {
  const row = await ownerOf(db, args.shareableId)
  if (!row) return { kind: 'not-found' }
  if (!row.link_suspended_at) return { kind: 'already' }
  return transitionLink(db, row, 'resume', {
    reason: null,
    judgmentId: args.judgmentId ?? null,
    now: args.now ?? nowIso(),
    notify: args.notify ?? sendOwnerNotice,
  })
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
  const message = clipCodePoints(args.message, LINK_APPEAL_MESSAGE_MAX)
  const eventId = nanoid()
  // The insert carries the preconditions (still paused, no appeal in the
  // last hour), so two simultaneous appeals cannot both pass the cooldown.
  await db
    .insertInto('events')
    .columns([
      'id',
      'workspace_id',
      'type',
      'shareable_id',
      'actor_user_id',
      'subject_id',
      'payload',
      'created_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('shareables')
        .select([
          eb.val(eventId).as('id'),
          eb.val(row.workspace_id).as('workspace_id'),
          eb.val('link_appealed').as('type'),
          eb.val(row.id).as('shareable_id'),
          eb.val(user.id).as('actor_user_id'),
          eb.val(nanoid()).as('subject_id'),
          eb.val(JSON.stringify({ message })).as('payload'),
          eb.val(now).as('created_at'),
        ])
        .where('id', '=', row.id)
        .where('link_suspended_at', 'is not', null)
        .where(
          sql<boolean>`NOT EXISTS (
            SELECT 1 FROM events AS recent
            WHERE recent.shareable_id = shareables.id
              AND recent.type = 'link_appealed'
              AND recent.created_at >= ${since}
          )`,
        ),
    )
    .execute()
  const recorded = await db
    .selectFrom('events')
    .select('id')
    .where('id', '=', eventId)
    .executeTakeFirst()
  if (!recorded) return { kind: 'cooldown' }
  // Operators get the text and a signed link to resume from the alert.
  const secret = env.LINK_OPS_ACTION_SECRET
  console.warn('artifactshare_link_appeal', {
    shareableId: row.id,
    workspaceId: row.workspace_id,
    manageUrl: `https://${APEX_HOST}/a/${row.id}`,
    message: clipCodePoints(message, 300),
    actionUrl: secret
      ? linkOpsUrl(
          `https://${APEX_HOST}`,
          row.id,
          await signLinkOpsToken({ shareableId: row.id }, secret),
        )
      : null,
  })
  return { kind: 'appealed' }
}

/** Email the owner; a delivery failure is logged and never fails the action. */
export async function sendOwnerNotice(
  notice: OwnerNotice,
): Promise<OwnerNoticeOutcome> {
  const email: SendEmail | undefined = env.EMAIL
  if (!email) return 'skipped'
  const manageUrl = `https://${APEX_HOST}/a/${notice.shareableId}`
  // The title is user content: keep it out of header injection.
  const title = notice.title.replace(/[\r\n]+/g, ' ')
  const subject =
    notice.kind === 'suspended'
      ? `リンク共有を一時停止しました / Link sharing paused: ${title}`
      : `リンク共有を再開しました / Link sharing resumed: ${title}`
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
    return 'sent'
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'link_suspension_email_failed',
        shareableId: notice.shareableId,
        kind: notice.kind,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return 'failed'
  }
}
