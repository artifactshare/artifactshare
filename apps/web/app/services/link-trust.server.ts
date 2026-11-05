import { env } from 'cloudflare:workers'
import { sql, type Kysely } from 'kysely'
import type { DB } from '~/types/db'
import { normalizePlan } from '~/lib/billing-plan.server'
import {
  isLowTrustLinkWorkspace,
  linkTrustThresholdsFromEnv,
} from '~/lib/link-trust-policy'

export async function anonymousLinkLowTrust(
  db: Kysely<DB>,
  shareable: {
    workspace_id: string
    owner_created_at: string | null
    artifact_workspace_plan: string | null
  },
): Promise<boolean> {
  const thresholds = linkTrustThresholdsFromEnv(env)
  let linkPublishCount = 0
  if (normalizePlan(shareable.artifact_workspace_plan) === 'free') {
    const boundedVisibilityEvents = db
      .selectFrom('events')
      .select(sql<number>`1`.as('present'))
      .where('workspace_id', '=', shareable.workspace_id)
      .where('type', '=', 'visibility_changed')
      .where(sql<boolean>`json_extract(payload, '$.to') = 'link'`)
      .groupBy('shareable_id')
      .limit(thresholds.linkPublishCount)
      .as('bounded_visibility_events')
    const boundedLinkShareables = db
      .selectFrom('shareables')
      .select(sql<number>`1`.as('present'))
      .where('workspace_id', '=', shareable.workspace_id)
      .where('visibility', '=', 'link')
      .limit(thresholds.linkPublishCount)
      .as('bounded_link_shareables')
    const [visibilityEventCount, currentLinkCount] = await Promise.all([
      db
        .selectFrom(boundedVisibilityEvents)
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirst(),
      db
        .selectFrom(boundedLinkShareables)
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirst(),
    ])
    linkPublishCount = Math.max(
      Number(visibilityEventCount?.count ?? 0),
      Number(currentLinkCount?.count ?? 0),
    )
  }
  return isLowTrustLinkWorkspace({
    plan: shareable.artifact_workspace_plan,
    ownerCreatedAt: shareable.owner_created_at ?? '',
    now: new Date().toISOString(),
    linkPublishCount,
    thresholds,
  })
}
