import type { Kysely } from 'kysely'
import type { DB } from '~/types/db'
import type { AnalyticsAuthMethod } from '~/lib/analytics/events'

export type SignupMethod = AnalyticsAuthMethod
const PENDING_SIGNUP_LEASE_MS = 5 * 60 * 1000

export async function insertPendingSignup(
  db: Kysely<DB>,
  input: {
    userId: string
    method: SignupMethod
    workspaceCreated: boolean
    now: string
  },
): Promise<void> {
  await db
    .insertInto('pending_signup_analytics')
    .values({
      user_id: input.userId,
      method: input.method,
      workspace_created: input.workspaceCreated ? 1 : 0,
      created_at: input.now,
      claimed_at: null,
      tracked_at: null,
    })
    .onConflict((oc) => oc.column('user_id').doNothing())
    .execute()
}

export async function clearPendingSignupWorkspaceCreated(
  db: Kysely<DB>,
  userId: string,
): Promise<void> {
  await db
    .updateTable('pending_signup_analytics')
    .set({ workspace_created: 0 })
    .where('user_id', '=', userId)
    .execute()
}

export async function clearWorkspaceCreatedIfMoved(
  db: Kysely<DB>,
  input: {
    userId: string
    originalWorkspaceId: string | null
    finalWorkspaceId: string | null
  },
): Promise<boolean> {
  const moved = Boolean(
    input.finalWorkspaceId &&
    input.originalWorkspaceId &&
    input.finalWorkspaceId !== input.originalWorkspaceId,
  )
  if (moved) await clearPendingSignupWorkspaceCreated(db, input.userId)
  return moved
}

export async function claimPendingSignup(
  db: Kysely<DB>,
  userId: string,
  opts: { now: string; leaseMs?: number },
): Promise<{
  method: SignupMethod
  workspace_created: number
  created_at: string
} | null> {
  const cutoff = new Date(
    Date.parse(opts.now) - (opts.leaseMs ?? PENDING_SIGNUP_LEASE_MS),
  ).toISOString()
  const row = await db
    .updateTable('pending_signup_analytics')
    .set({ claimed_at: opts.now })
    .where('user_id', '=', userId)
    .where('tracked_at', 'is', null)
    .where((eb) =>
      eb.or([eb('claimed_at', 'is', null), eb('claimed_at', '<', cutoff)]),
    )
    .returning(['method', 'workspace_created', 'created_at'])
    .executeTakeFirst()
  return row ?? null
}

export async function markPendingSignupTracked(
  db: Kysely<DB>,
  userId: string,
  now: string,
): Promise<void> {
  await db
    .updateTable('pending_signup_analytics')
    .set({ tracked_at: now })
    .where('user_id', '=', userId)
    .execute()
}
