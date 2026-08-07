import type { Kysely } from 'kysely'
import type { DB } from '~/types/db'

export type SignupMethod = 'google' | 'microsoft' | 'email'
// Default claim lease. Module-private: claimPendingSignup applies it internally
// and callers rely on the default, so it is not part of the module's API.
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

// When an OAuth user is moved off their just-created personal workspace into an
// existing (domain-claimed) one, that is a domain-join rather than a self-serve
// creation, so workspace_created must not fire. Returns whether a move was seen.
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
