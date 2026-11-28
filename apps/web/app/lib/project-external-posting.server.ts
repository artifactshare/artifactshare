import { sql, type Kysely, type RawBuilder } from 'kysely'
import { canUseExternalPosting } from './link-sharing-policy'
import { loadWorkspaceLinkPolicy } from '~/services/link-sharing.server'
import type { DB } from '~/types/db'
import { PAID_TIERS } from '~/lib/plan-tier'
import { planInTierSql } from '~/lib/plan-tier-sql.server'

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

export function externalPostingAllowedSql(
  workspaceId: string | RawBuilder<unknown>,
): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM workspaces posting_workspace
    WHERE posting_workspace.id = ${workspaceId}
      AND ${planInTierSql('posting_workspace.plan', PAID_TIERS)}
      AND posting_workspace.external_posting_enabled = 1)`
}
