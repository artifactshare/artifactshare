import type { Kysely } from 'kysely'
import { canUseExternalPosting } from './link-sharing-policy'
import { loadWorkspaceLinkPolicy } from '~/services/link-sharing.server'
import type { DB } from '~/types/db'

export async function isExternalPostingEnabledForWorkspace(
  db: Kysely<DB>,
  workspaceId: string,
): Promise<boolean> {
  const policy = await loadWorkspaceLinkPolicy(db, workspaceId)
  return policy ? canUseExternalPosting(policy) : false
}

export function isExternalPostingAllowedForWorkspace(
  db: Kysely<DB>,
  workspaceId: string,
): Promise<boolean> {
  return isExternalPostingEnabledForWorkspace(db, workspaceId)
}
