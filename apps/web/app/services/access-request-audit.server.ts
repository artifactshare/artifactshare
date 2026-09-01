import { sql, type Kysely } from 'kysely'
import { nowIso } from '~/lib/datetime'
import type { DB } from '~/types/db'

export type AccessRequestNotificationChannel = 'email' | 'slack'
export type AccessRequestNotificationOutcome = 'succeeded' | 'failed'
export type AccessRequestNotificationPurpose = 'request' | 'resolution'

interface AccessRequestCreatedSnapshot {
  access_request_id: string
  artifact_id: string
  artifact_title: string
  project_id: string | null
  project_name: string | null
  requester_id: string
  requester_name: string | null
  requester_email: string
  handler_id: string
  handler_name: string | null
  handler_email: string
  actor_id: string
  actor_name: string | null
  actor_email: string
}

export async function deliverAuditedAccessRequestNotification(
  db: Kysely<DB>,
  input: {
    requestId: string
    channel: AccessRequestNotificationChannel
    endpointKey: string
    recipientUserId: string
    recipientEmail: string
    purpose?: AccessRequestNotificationPurpose
  },
  deliver: () => Promise<void>,
): Promise<AccessRequestNotificationOutcome | 'not-attempted'> {
  const reservation = await reserveNotificationAttempt(db, input)
  if (!reservation) return 'not-attempted'

  let outcome: AccessRequestNotificationOutcome = 'succeeded'
  try {
    await deliver()
  } catch {
    outcome = 'failed'
  }
  await persistNotificationOutcome(db, reservation.eventId, input, outcome)
  return outcome
}

async function reserveNotificationAttempt(
  db: Kysely<DB>,
  input: {
    requestId: string
    channel: AccessRequestNotificationChannel
    endpointKey: string
    recipientUserId: string
    recipientEmail: string
    purpose?: AccessRequestNotificationPurpose
  },
): Promise<{ eventId: string } | null> {
  try {
    const eventId = await notificationEventId(input)
    const sourceEventId =
      (input.purpose ?? 'request') === 'resolution'
        ? decisionEventId(input.requestId)
        : createdEventId(input.requestId)
    const source = await db
      .selectFrom('audit_events')
      .select(['workspace_id', 'detail'])
      .where('id', '=', sourceEventId)
      .where(
        'action',
        'in',
        (input.purpose ?? 'request') === 'resolution'
          ? ['access_request.approved', 'access_request.rejected']
          : ['access_request.created'],
      )
      .executeTakeFirst()
    if (!source?.detail) {
      logReservationFailure(input)
      return null
    }

    const snapshot = parseCreatedSnapshot(source.detail, input.requestId)
    if (!snapshot) {
      logReservationFailure(input)
      return null
    }
    const detail = JSON.stringify({
      ...snapshot,
      recipient_id: input.recipientUserId,
      recipient_email: input.recipientEmail,
      notification_channel: input.channel,
      notification_purpose: input.purpose ?? 'request',
      delivery_outcome: 'attempting',
    })
    const inserted = await db
      .insertInto('audit_events')
      .values({
        id: eventId,
        workspace_id: source.workspace_id,
        actor_user_id: null,
        action: `access_request.${input.channel}.attempting`,
        subject_type: 'access_request',
        subject_id: input.requestId,
        detail,
        created_at: nowIso(),
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .returning('id')
      .executeTakeFirst()
    return inserted ? { eventId } : null
  } catch {
    logReservationFailure(input)
    return null
  }
}

function logReservationFailure(input: {
  requestId: string
  channel: AccessRequestNotificationChannel
}): void {
  console.error(
    JSON.stringify({
      event: 'access_request_notification_audit_reservation_failed',
      requestId: input.requestId,
      channel: input.channel,
    }),
  )
}

async function persistNotificationOutcome(
  db: Kysely<DB>,
  eventId: string,
  input: {
    requestId: string
    channel: AccessRequestNotificationChannel
  },
  outcome: AccessRequestNotificationOutcome,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await db
        .updateTable('audit_events')
        .set({
          action: `access_request.${input.channel}.${outcome}`,
          detail: sql<string>`json_set(detail, '$.delivery_outcome', ${outcome})`,
        })
        .where('id', '=', eventId)
        .where('action', '=', `access_request.${input.channel}.attempting`)
        .execute()
      return
    } catch {
      // The provider delivery is never retried. Only this idempotent audit
      // update is repeated; a reserved row becomes "unknown" in the UI when
      // it remains attempting beyond the bounded window.
    }
  }
  console.error(
    JSON.stringify({
      event: 'access_request_notification_audit_outcome_failed',
      requestId: input.requestId,
      channel: input.channel,
      outcome,
    }),
  )
}

function parseCreatedSnapshot(
  detail: string,
  requestId: string,
): AccessRequestCreatedSnapshot | null {
  try {
    const value = JSON.parse(detail) as Partial<AccessRequestCreatedSnapshot>
    if (
      value.access_request_id !== requestId ||
      typeof value.artifact_id !== 'string' ||
      typeof value.artifact_title !== 'string' ||
      typeof value.requester_id !== 'string' ||
      typeof value.requester_email !== 'string' ||
      typeof value.handler_id !== 'string' ||
      typeof value.handler_email !== 'string' ||
      typeof value.actor_id !== 'string' ||
      typeof value.actor_email !== 'string'
    ) {
      return null
    }
    return value as AccessRequestCreatedSnapshot
  } catch {
    return null
  }
}

function createdEventId(requestId: string): string {
  return `access-request-created:${requestId}`
}

function decisionEventId(requestId: string): string {
  return `access-request-decision:${requestId}`
}

async function notificationEventId(input: {
  requestId: string
  channel: AccessRequestNotificationChannel
  endpointKey: string
  purpose?: AccessRequestNotificationPurpose
}): Promise<string> {
  const purpose = input.purpose ?? 'request'
  const identity =
    purpose === 'request'
      ? `${input.requestId}\u0000${input.channel}\u0000${input.endpointKey}`
      : `${input.requestId}\u0000${purpose}\u0000${input.channel}\u0000${input.endpointKey}`
  const bytes = new TextEncoder().encode(identity)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  return `access-request-notification:${hex}`
}
