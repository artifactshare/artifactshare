import { sql, type Kysely } from 'kysely'
import { nowIso } from '~/lib/datetime'
import { workspaceAccessRevokedSql } from '~/modules/access'
import type { DB } from '~/types/db'
import type { CliAuthority } from './cli-authority.server'

export type PublisherAuthority = Extract<CliAuthority, { kind: 'publisher' }>

/** Live membership, client ownership and credential liveness are commit-time facts. */
export function publisherAuthoritySql(
  userId: string,
  authority: PublisherAuthority,
) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM publisher_clients pc
    JOIN users pu ON pu.id = pc.user_id AND pu.workspace_id = pc.workspace_id AND pu.kind = 'human'
    JOIN cli_family_authorities pf ON pf.publisher_client_id = pc.id AND pf.user_id = pu.id
    WHERE pc.id = ${authority.publisherClientId} AND pc.user_id = ${userId}
      AND pc.workspace_id = ${authority.workspaceId}
      AND pf.family_id = ${authority.familyId} AND pf.status = 'active' AND pf.preset = 'publisher'
      AND pf.workspace_id = pc.workspace_id
      AND EXISTS (SELECT 1 FROM cli_refresh_credentials pr WHERE pr.family_id = pf.family_id
        AND pr.user_id = pu.id AND pr.revoked_at IS NULL AND pr.expires_at > ${nowIso()})
  ) AND NOT ${workspaceAccessRevokedSql(sql.val(authority.workspaceId), userId)}`
}

export function publisherArtifactSql(
  userId: string,
  authority: PublisherAuthority,
) {
  return sql<boolean>`(${publisherAuthoritySql(userId, authority)})
    AND shareables.workspace_id = ${authority.workspaceId}
    AND shareables.owner_user_id = ${userId}
    AND COALESCE(shareables.assigned_publisher_client_id, shareables.created_by_publisher_client_id) = ${authority.publisherClientId}
    AND shareables.artifact_kind IN ('html_page', 'markdown_page', 'static_site')`
}

export async function isPublisherArtifact(
  db: Kysely<DB>,
  userId: string,
  authority: PublisherAuthority,
  artifactId: string,
) {
  return Boolean(
    await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', artifactId)
      .where(publisherArtifactSql(userId, authority))
      .executeTakeFirst(),
  )
}

/** Authorize before exposing metadata or following storage references. */
export function loadPublisherArtifact(
  db: Kysely<DB>,
  userId: string,
  authority: PublisherAuthority,
  id: string,
) {
  return db
    .selectFrom('shareables')
    .leftJoin('versions', 'versions.id', 'shareables.current_version_id')
    .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
    .select([
      'shareables.id',
      'shareables.artifact_kind',
      'shareables.visibility',
      'shareables.current_version_id',
      sql<
        string | null
      >`CASE WHEN c.kind = 'project' THEN shareables.container_id ELSE NULL END`.as(
        'container_id',
      ),
      'shareables.link_expires_at',
      'shareables.retain_versions',
      'versions.r2_key',
    ])
    .where('shareables.id', '=', id)
    .where(publisherArtifactSql(userId, authority))
    .executeTakeFirst()
}
