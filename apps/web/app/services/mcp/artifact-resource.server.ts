import {
  ResourceTemplate,
  type McpServer,
  type RegisteredResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { displayTitle } from '~/lib/display-title'
import { lowerEmail } from '~/lib/grant-emails.server'
import { grantMatchEmail, isTeamWorkspaceAdmin } from '~/services/access.server'
import { MAX_ARTIFACT_SOURCE_CHARS } from '~/services/artifact-readback.server'
import { getArtifactReadback } from '~/services/artifact-readback-service.server'
import {
  visibleShareableToViewerSql,
  visibleSharedProjectShareableToViewerSql,
} from '~/services/projects.server'
import {
  loadMcpUser,
  mcpUserAsSessionUser,
  type McpRequestContext,
} from './identity.server'

const ARTIFACT_RESOURCE_UNAVAILABLE = 'Artifact resource is not available.'
const ARTIFACT_RESOURCE_UNSUPPORTED = 'Artifact resource type is not supported.'
const ARTIFACT_RESOURCE_TOO_LARGE =
  'Artifact resource exceeds the supported size.'
const ARTIFACT_RESOURCE_SOURCE_UNAVAILABLE =
  'Artifact resource content is unavailable.'
const ARTIFACT_RESOURCE_LIST_LIMIT = 50
const ARTIFACT_RESOURCE_SCAN_LIMIT = 100
const ARTIFACT_RESOURCE_VALIDATION_LIMIT = 10
const UTF8_BOM_BYTES = 3
const MAX_UTF8_BYTES_FOR_ARTIFACT_SOURCE =
  MAX_ARTIFACT_SOURCE_CHARS * 3 + UTF8_BOM_BYTES

export function artifactResourceTemplate(appOrigin: string): string {
  return `${appOrigin.replace(/\/$/, '')}/a/{id}`
}

async function enforcePerUserLimit(ctx: McpRequestContext): Promise<void> {
  const limiter = ctx.rateLimiters.perUser
  if (!limiter) return

  let success: boolean
  try {
    const result = await limiter.limit({
      key: `mcp:user:${ctx.identity.userId}`,
    })
    success = result.success
  } catch (error) {
    console.error('mcp_rate_limit_failed', error)
    return
  }

  if (!success) {
    throw new McpError(
      ErrorCode.RequestTimeout,
      'Artifact resource read is rate limited.',
    )
  }
}

export function registerArtifactResource(
  server: McpServer,
  ctx: McpRequestContext,
): RegisteredResourceTemplate {
  const appOrigin = new URL(ctx.baseUrl).origin

  return server.registerResource(
    'artifact',
    new ResourceTemplate(artifactResourceTemplate(appOrigin), {
      list: async () => {
        await enforcePerUserLimit(ctx)

        const user = await loadMcpUser(ctx.db, ctx.identity.userId)
        if (!user) {
          throw new McpError(
            ErrorCode.InternalError,
            'Artifact resource user is unavailable.',
          )
        }

        const viewer = mcpUserAsSessionUser(user)
        const isWorkspaceAdmin = await isTeamWorkspaceAdmin(
          ctx.db,
          viewer,
          viewer.workspaceId,
        )
        const resources: Array<{
          uri: string
          name: string
          title: string
          description: string
          mimeType: string
        }> = []
        let cursor: { updatedAt: string; id: string } | null = null
        let scannedCount = 0
        let validationCount = 0

        while (
          resources.length < ARTIFACT_RESOURCE_LIST_LIMIT &&
          scannedCount < ARTIFACT_RESOURCE_SCAN_LIMIT
        ) {
          let query = ctx.db
            .selectFrom('shareables')
            .innerJoin('versions', (join) =>
              join
                .onRef('versions.id', '=', 'shareables.current_version_id')
                .onRef('versions.shareable_id', '=', 'shareables.id'),
            )
            .select([
              'shareables.id',
              'shareables.name',
              'shareables.derived_title',
              'shareables.title_override',
              'shareables.updated_at',
              'versions.artifact_kind',
              'versions.size_bytes',
            ])
            .where('versions.status', '=', 'published')
            .where('versions.artifact_kind', 'in', [
              'markdown_page',
              'html_page',
            ])
            .where(
              'versions.size_bytes',
              '<=',
              MAX_UTF8_BYTES_FOR_ARTIFACT_SOURCE,
            )
            .where((eb) =>
              eb.or([
                eb('shareables.owner_user_id', '=', viewer.id),
                eb.exists(
                  eb
                    .selectFrom('shareable_grants')
                    .select('shareable_grants.shareable_id')
                    .whereRef(
                      'shareable_grants.shareable_id',
                      '=',
                      'shareables.id',
                    )
                    .where(
                      lowerEmail('shareable_grants.granted_email'),
                      '=',
                      grantMatchEmail(viewer),
                    ),
                ),
                eb.and([
                  eb('shareables.workspace_id', '=', viewer.workspaceId),
                  eb('shareables.visibility', '!=', 'link'),
                  visibleShareableToViewerSql(viewer),
                ]),
                eb.and([
                  eb('shareables.workspace_id', '!=', viewer.workspaceId),
                  eb('shareables.visibility', '!=', 'link'),
                  eb.exists(
                    eb
                      .selectFrom('project_members')
                      .select('project_members.user_id')
                      .whereRef(
                        'project_members.container_id',
                        '=',
                        'shareables.container_id',
                      )
                      .where('project_members.user_id', '=', viewer.id),
                  ),
                  eb.exists(
                    eb
                      .selectFrom('project_share_defaults')
                      .select('project_share_defaults.id')
                      .whereRef(
                        'project_share_defaults.project_container_id',
                        '=',
                        'shareables.container_id',
                      )
                      .where(
                        lowerEmail('project_share_defaults.email'),
                        '=',
                        grantMatchEmail(viewer),
                      ),
                  ),
                  visibleSharedProjectShareableToViewerSql(viewer),
                ]),
                ...(isWorkspaceAdmin
                  ? [
                      eb.and([
                        eb('shareables.workspace_id', '=', viewer.workspaceId),
                        eb('shareables.visibility', '=', 'link'),
                      ]),
                    ]
                  : []),
              ]),
            )

          if (cursor) {
            const currentCursor = cursor
            query = query.where((eb) =>
              eb.or([
                eb('shareables.updated_at', '<', currentCursor.updatedAt),
                eb.and([
                  eb('shareables.updated_at', '=', currentCursor.updatedAt),
                  eb('shareables.id', '<', currentCursor.id),
                ]),
              ]),
            )
          }

          const rows = await query
            .orderBy('shareables.updated_at', 'desc')
            .orderBy('shareables.id', 'desc')
            .limit(
              Math.min(
                ARTIFACT_RESOURCE_LIST_LIMIT,
                ARTIFACT_RESOURCE_SCAN_LIMIT - scannedCount,
              ),
            )
            .execute()
          if (rows.length === 0) break
          scannedCount += rows.length

          const rowsToValidate = rows
            .filter((row) => row.size_bytes > MAX_ARTIFACT_SOURCE_CHARS)
            .slice(0, ARTIFACT_RESOURCE_VALIDATION_LIMIT - validationCount)
          validationCount += rowsToValidate.length
          const validatedIds = new Set(
            (
              await Promise.all(
                rowsToValidate.map(async (row) => {
                  const readback = await getArtifactReadback(ctx.db, viewer, {
                    id: row.id,
                    baseUrl: ctx.baseUrl,
                  })
                  return readback.kind === 'ok' && !readback.data.truncated
                    ? row.id
                    : null
                }),
              )
            ).filter((id): id is string => id !== null),
          )

          for (const row of rows) {
            if (
              row.size_bytes > MAX_ARTIFACT_SOURCE_CHARS &&
              !validatedIds.has(row.id)
            )
              continue

            const uri = `${appOrigin}/a/${row.id}`
            const title = displayTitle({
              titleOverride: row.title_override,
              derivedTitle: row.derived_title,
              name: row.name,
            })
            resources.push({
              uri,
              // Some MCP clients still render `name` even when `title` is
              // present. Lead with the human-readable title and retain the
              // unique URI so name-keying clients do not collapse duplicates.
              name: `${title} — ${uri}`,
              title,
              description: `Current ${
                row.artifact_kind === 'markdown_page' ? 'Markdown' : 'HTML'
              } source from Artifact Share.`,
              mimeType:
                row.artifact_kind === 'markdown_page'
                  ? 'text/markdown'
                  : 'text/html',
            })
            if (resources.length === ARTIFACT_RESOURCE_LIST_LIMIT) break
          }

          const last = rows.at(-1)
          if (!last || rows.length < ARTIFACT_RESOURCE_LIST_LIMIT) break
          cursor = { updatedAt: last.updated_at, id: last.id }
        }

        return { resources }
      },
    }),
    {
      title: 'Artifact Share artifact',
      description:
        'Reads the current Markdown or HTML source of an Artifact Share artifact.',
    },
    async (uri, variables) => {
      await enforcePerUserLimit(ctx)

      const id = uri.pathname.slice('/a/'.length)
      if (
        typeof variables.id !== 'string' ||
        id.length === 0 ||
        id.includes('/')
      ) {
        throw new McpError(
          ErrorCode.InvalidParams,
          ARTIFACT_RESOURCE_UNAVAILABLE,
        )
      }

      const user = await loadMcpUser(ctx.db, ctx.identity.userId)
      if (!user) {
        throw new McpError(
          ErrorCode.InternalError,
          'Artifact resource user is unavailable.',
        )
      }

      const result = await getArtifactReadback(
        ctx.db,
        mcpUserAsSessionUser(user),
        {
          id,
          baseUrl: ctx.baseUrl,
        },
      )

      switch (result.kind) {
        case 'ok':
          if (result.data.truncated) {
            throw new McpError(
              ErrorCode.InvalidParams,
              ARTIFACT_RESOURCE_TOO_LARGE,
            )
          }
          return {
            contents: [
              {
                uri: uri.href,
                mimeType:
                  result.data.format === 'markdown'
                    ? 'text/markdown'
                    : 'text/html',
                text: result.data.content,
              },
            ],
          }
        case 'not-found':
          throw new McpError(
            ErrorCode.InvalidParams,
            ARTIFACT_RESOURCE_UNAVAILABLE,
          )
        case 'unsupported-kind':
          throw new McpError(
            ErrorCode.InvalidParams,
            ARTIFACT_RESOURCE_UNSUPPORTED,
          )
        case 'source-unavailable':
          throw new McpError(
            ErrorCode.InternalError,
            ARTIFACT_RESOURCE_SOURCE_UNAVAILABLE,
          )
        default: {
          const exhaustive: never = result
          return exhaustive
        }
      }
    },
  )
}
