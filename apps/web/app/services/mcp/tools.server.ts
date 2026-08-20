import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { CONNECT_AI_AGENTS_ANCHOR } from '~/lib/connect-link'
import { APEX_HOST } from '~/lib/hosts'
import {
  logUploadPermissionFailure,
  type UploadPermissionResult,
} from '~/lib/upload-permission.server'
import { checkUploadAccess } from '~/services/upload-access.server'
import {
  defaultVisibilityFor,
  isVisibility,
  type ArtifactKind,
  type ContainerKind,
  type ProjectBaseVisibility,
  type Visibility,
} from '~/lib/shareable-types'
import { isOrgWorkspace } from '~/lib/user'
import { t, type Locale } from '~/lib/i18n'
import { DEFAULT_LOCALE, isSupportedLocale } from '~/i18n/messages'
import { shortVisibilityLabelKey } from '~/lib/visibility-labels'
import { computeTextSha256 } from '~/lib/sha256'
import { isoMsAgo } from '~/lib/datetime'
import { payloadFromMcpEditArgs } from '~/lib/shareable-settings-adapter.server'
import { deleteArtifactSuccessBody } from '~/lib/project-actions-adapter.server'
import {
  appendShareable,
  createVersion,
  deleteShareable,
  editShareableSettings,
  getOwnedShareableSummary,
  listOwnedShareables,
  updateShareableMetadata,
  uploadShareable,
  type CreateVersionResult,
  type EditShareableSettingsResult,
  type OwnedShareableSummary,
  type UploadShareableResult,
} from '~/services/shareables.server'
import {
  createProjectContainer,
  editProjectContainerSettings,
  type EditProjectContainerSettingsResult,
  listWorkspaceProjects,
  normalizeProjectDescription,
  normalizeProjectName,
  parseProjectBaseVisibility,
} from '~/services/projects.server'
import { MAX_GRANT_EMAILS } from '~/lib/grant-emails'
import {
  changeComment,
  COMMENT_THREAD_LIST_LIMIT,
  loadCommentAccess,
  loadCommentAccessForThread,
  loadCommentThreads,
  postArtifactComment,
  type ChangeCommentInput,
  type CommentMutationResult,
  type PostArtifactCommentResult,
} from '~/services/comments.server'
import { MAX_COMMENT_BODY_LENGTH } from '~/lib/comments'
import {
  loadMcpUser,
  mcpUserAsSessionUser,
  type McpRequestContext,
  type McpUser,
  type RateLimiter,
} from './identity.server'
import { findRecentPublish, recordArtifactPost } from './posts.server'
import { ARTIFACT_PREVIEW_TEMPLATE_URI } from './preview-widget.server'
import { toAgentCommentThread } from '~/services/artifact-readback.server'
import { getArtifactReadback } from '~/services/artifact-readback-service.server'
import { recordFirstArtifactPost } from '~/services/first-post-analytics.server'
import { securityAuditInsertQuery } from '~/services/security-audit.server'
import { listCliArtifacts } from '~/services/cli-artifacts.server'
import { slackReauthorizationWarnings } from '~/services/slack-notifications.server'
import {
  buildUpgradeRequest,
  type UpgradeRequest,
} from '~/services/upgrade-request.server'

export {
  capSource,
  singleFileFormat,
  toAgentCommentThread as toMcpCommentThread,
} from '~/services/artifact-readback.server'

type Format = 'html' | 'markdown'

// Mirror the web metadata route's title_override cap so a title set through MCP
// can't grow past what the viewer / list rendering assumes.
const MAX_TITLE_OVERRIDE_LENGTH = 200

// Idempotency window: a host's timeout-retry of share_artifact lands within
// seconds, so this only needs to be long enough to absorb retries — not so long
// that a deliberate re-publish of the same content reuses the old artifact.
const IDEMPOTENCY_WINDOW_MS = 10 * 60_000
const TOOL_ALIAS_HINT =
  'Artifact Share is also called "as"; use these tools when the user says "as". If the user says "Artifact Share" or "artifactshare", briefly mention they can call it "as" next time. '
const TOOL_ROUTING_HINT =
  'Honor an explicit route choice; otherwise route by capabilities: MCP for chat/sandboxes, CLI for capable coding agents. '
const CONNECT_AI_AGENTS_URL = `https://${APEX_HOST}/connect#${CONNECT_AI_AGENTS_ANCHOR}`

// Text content is the universal baseline: every host can render a tool's text
// result, so the tools speak plain JSON. Successful results also carry
// `structuredContent` (matching the tool's outputSchema) so hosts that read it
// can hand the model typed data. Tool-level failures set `isError` and carry a
// machine code plus a "what / why / next" body so the agent knows whether it
// can recover itself.
type ToolTextResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

const VISIBILITY_VALUES = ['private', 'workspace', 'project', 'link'] as const

// Output schemas — declared so hosts advertise the result shape to the model
// (and the SDK validates what we return). Optional fields are nullable because
// a best-effort read-back can miss after a committed write.
const ARTIFACT_OUTPUT_SCHEMA = {
  id: z.string(),
  share_url: z.string(),
  title: z.string().nullable(),
  visibility: z.enum(VISIBILITY_VALUES),
  link_expires_at: z.string().nullable(),
  visibility_label: z.string(),
  warnings: z
    .array(
      z.object({
        code: z.literal('slack_reauthorization_required'),
        message: z.string(),
      }),
    )
    .optional(),
}

const UPDATE_OUTPUT_SCHEMA = {
  id: z.string(),
  share_url: z.string(),
  title: z.string().nullable(),
  visibility: z.enum(VISIBILITY_VALUES).nullable(),
  link_expires_at: z.string().nullable(),
  visibility_label: z.string().nullable(),
  version_id: z.string(),
}

const LIST_OUTPUT_SCHEMA = {
  artifacts: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      share_url: z.string(),
      visibility: z.enum(VISIBILITY_VALUES),
      link_expires_at: z.string().nullable(),
      visibility_label: z.string(),
      updated_at: z.string(),
      // The project the artifact is filed under, or null for the unfiled inbox.
      project_id: z.string().nullable(),
      owner_email: z.string().optional(),
      artifact_kind: z.string(),
    }),
  ),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
}

const VERSION_ITEM_SCHEMA = z.object({
  version_id: z.string(),
  status: z.string(),
  size_bytes: z.number(),
  created_at: z.string(),
  published_at: z.string().nullable(),
  is_current: z.boolean(),
})

const COMMENT_THREAD_SCHEMA = z.object({
  id: z.string(),
  status: z.enum(['open', 'resolved']),
  resolved_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  // What the thread is attached to. 'artifact' = the whole document;
  // 'text' = a quoted span (quoted_text). state 'orphaned' means a later
  // version removed that span, so the quote no longer matches the source.
  anchor: z.object({
    kind: z.enum(['artifact', 'text']),
    quoted_text: z.string().nullable(),
    state: z.enum(['attached', 'orphaned']).nullable(),
  }),
  messages: z.array(
    z.object({
      // The message id, for update_comment / delete_comment.
      message_id: z.string(),
      author_name: z.string().nullable(),
      author_email: z.string(),
      // The agent name when posted via CLI/MCP on behalf of an agent; null when
      // the human posted directly.
      agent: z.string().nullable(),
      body: z.string(),
      created_at: z.string(),
      updated_at: z.string(),
    }),
  ),
})

const GET_ARTIFACT_OUTPUT_SCHEMA = {
  id: z.string(),
  share_url: z.string(),
  version_id: z.string(),
  format: z.enum(['html', 'markdown']),
  content: z.string(),
  // Full stored size of the source in bytes. When `truncated` is true this
  // exceeds `content`; even when false it differs from content.length for
  // multibyte text. Use `truncated`, not this, to tell if `content` is whole.
  size_bytes: z.number(),
  // True when there is more source past this chunk: `content` is a partial
  // slice (a prefix, or a window starting at the requested offset). Call
  // get_artifact again with offset set to next_offset to read the rest; never
  // feed a truncated read back into update_artifact.
  truncated: z.boolean(),
  // The offset to pass on the next get_artifact call to continue reading, or
  // null when truncated is false (this chunk reached the end of the source).
  next_offset: z.number().nullable(),
  link_expires_at: z.string().nullable(),
  // Present only when requested via `include`. versions is the history newest
  // first. versions_has_more says whether older entries were dropped past the
  // page cap.
  versions: z.array(VERSION_ITEM_SCHEMA).optional(),
  versions_has_more: z.boolean().optional(),
}

const PREVIEW_OUTPUT_SCHEMA = {
  id: z.string(),
  share_url: z.string(),
  title: z.string().nullable(),
  artifact_kind: z.enum([
    'markdown_page',
    'html_page',
    'static_site',
    'spa',
    'workspace_app',
  ]),
  // The viewer's locale, so the preview widget can localize its own chrome.
  locale: z.string(),
}

const POST_COMMENT_OUTPUT_SCHEMA = {
  artifact_id: z.string(),
  share_url: z.string(),
  // The thread the comment landed in — the new thread when starting one, or the
  // replied-to thread. `reply` says which of the two happened.
  thread_id: z.string(),
  reply: z.boolean(),
  thread: COMMENT_THREAD_SCHEMA,
}

const UPDATE_COMMENT_OUTPUT_SCHEMA = {
  thread_id: z.string(),
  // The thread after the edit, so the agent sees the resulting state.
  thread: COMMENT_THREAD_SCHEMA,
}

const LIST_COMMENTS_OUTPUT_SCHEMA = {
  artifact_id: z.string(),
  share_url: z.string(),
  comments: z.array(COMMENT_THREAD_SCHEMA),
  comments_has_more: z.boolean(),
}

const DELETE_COMMENT_OUTPUT_SCHEMA = {
  thread_id: z.string(),
  // Always true on success; the error path sets isError instead.
  deleted: z.boolean(),
  // True when the whole thread is gone — either it was deleted, or the deleted
  // message was its last one. When false, `thread` holds the surviving thread.
  thread_deleted: z.boolean(),
  thread: COMMENT_THREAD_SCHEMA.optional(),
}

const PROJECT_BASE_VISIBILITY_VALUES = ['workspace', 'private'] as const

// Shared project fields across list / create / edit, so the shape an agent sees
// for a project is identical wherever it surfaces.
const PROJECT_OUTPUT_FIELDS = {
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  // A project's sharing scope: 'workspace' = everyone in the workspace can view
  // its artifacts, 'private' = only the project's audience. The label is the
  // same wording the project page shows, in the caller's locale.
  base_visibility: z.enum(PROJECT_BASE_VISIBILITY_VALUES),
  base_visibility_label: z.string(),
  file_count: z.number(),
}

const LIST_PROJECTS_OUTPUT_SCHEMA = {
  projects: z.array(z.object(PROJECT_OUTPUT_FIELDS)),
}

const CREATE_PROJECT_OUTPUT_SCHEMA = PROJECT_OUTPUT_FIELDS

const EDIT_PROJECT_OUTPUT_SCHEMA = {
  ...PROJECT_OUTPUT_FIELDS,
  // Whether the project is archived (hidden from the active list) after the edit.
  archived: z.boolean(),
  // The project's audience after the edit: the emails that can view its
  // private-scoped artifacts even outside the workspace, sorted.
  audience: z.array(z.string()),
}

const EDIT_OUTPUT_SCHEMA = {
  id: z.string(),
  share_url: z.string(),
  title: z.string(),
  // The scope after the edit. Moving an artifact never widens it: filing a
  // project-scoped artifact back into the inbox downgrades it to private (the
  // inbox has no audience to inherit from), unless an explicit visibility was
  // set in the same call.
  visibility: z.enum(VISIBILITY_VALUES),
  visibility_label: z.string(),
  // Where the artifact now lives: the project id, or null for the unfiled inbox.
  project_id: z.string().nullable(),
}

const DELETE_OUTPUT_SCHEMA = {
  id: z.string(),
  // Always true on success; the error path sets isError instead.
  deleted: z.boolean(),
}

const WHOAMI_OUTPUT_SCHEMA = {
  connected: z.boolean(),
  user_id: z.string(),
  scopes: z.array(z.string()),
  auth_mode: z.enum(['oauth', 'dev']),
  workspace: z
    .object({
      id: z.string(),
      name: z.string(),
      domain: z.string().nullable(),
    })
    .nullable(),
  plan: z.string().nullable(),
  storage: z
    .object({
      used_bytes: z.number(),
      quota_bytes: z.number(),
      remaining_bytes: z.number(),
    })
    .nullable(),
  can_publish: z.boolean(),
}

// Write tools that can create or change link-visible content are open-world;
// other writes and comment tools only affect the closed, authenticated system.
// All non-delete writes retain history, so they aren't destructive.
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

const PUBLIC_WRITE_ANNOTATIONS = {
  ...WRITE_ANNOTATIONS,
  openWorldHint: true,
} as const

// Irreversible deletes carry destructiveHint so a host can prompt the user
// before the call runs. The version history goes with the artifact, so there is
// no undo — distinct from publish / update, which retain prior versions.
const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const

function toolDescription(description: string): string {
  return `${TOOL_ALIAS_HINT}${TOOL_ROUTING_HINT}${description}`
}

export function registerArtifactTools(
  server: McpServer,
  ctx: McpRequestContext,
): void {
  // Resolve the full user from the token once per request, lazily: `tools/list`
  // and an unknown caller shouldn't pay a D1 read, but every tool that runs
  // needs the workspace-scoped identity. A rejected read is dropped (not
  // memoized) so a transient D1 blip on one tool can't poison the others in a
  // batched request.
  let userPromise: Promise<McpUser | null> | undefined
  const getUser = () => {
    if (!userPromise) {
      userPromise = loadMcpUser(ctx.db, ctx.identity.userId).catch((err) => {
        userPromise = undefined
        throw err
      })
    }
    return userPromise
  }
  const commentMutationOptions = {
    waitUntil: (promise: Promise<unknown>) =>
      ctx.executionContext.waitUntil(promise),
  }

  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: toolDescription(
        'Return the connected workspace, plan, remaining storage, and whether publishing is allowed. Call this right after connecting to ground the conversation.',
      ),
      outputSchema: WHOAMI_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) {
        return jsonResult({
          connected: true,
          user_id: ctx.identity.userId,
          scopes: ctx.identity.scopes,
          auth_mode: ctx.identity.mode,
          workspace: null,
          plan: null,
          storage: null,
          can_publish: false,
        })
      }
      const permission = await checkUploadAccess(user)
      logUploadPermissionFailure(permission)
      return jsonResult({
        connected: true,
        user_id: user.id,
        scopes: ctx.identity.scopes,
        auth_mode: ctx.identity.mode,
        workspace: {
          id: user.workspaceId,
          name: user.workspaceName,
          domain: user.hd,
        },
        plan: user.plan,
        storage: {
          used_bytes: user.storageUsedBytes,
          quota_bytes: user.storageQuotaBytes,
          remaining_bytes: Math.max(
            user.storageQuotaBytes - user.storageUsedBytes,
            0,
          ),
        },
        can_publish: permission.kind === 'allowed',
      })
    },
  )

  server.registerTool(
    'share_artifact',
    {
      title: 'Share artifact',
      description: toolDescription(
        'Share a single HTML or Markdown artifact and get a stable link back. Use when the user wants to share source text produced in chat or a temporary sandbox: pass the full HTML or Markdown source in content, not a local file path; a temporary path such as /mnt/data existing alone is not a reason to try the CLI. When no explicit route was chosen and the coding agent has a user-controlled workspace, CLI package access, and Artifact Share network access, this instruction applies: If the user already has a local file or folder, use the CLI instead: `npx --yes @artifactshare/cli share <path>`. MCP OAuth is separate from CLI auth; if the CLI reports `auth_required`, follow its recovery to set up or reuse a CLI profile. Embed any images directly in the content as base64 data: URIs so the artifact is one self-contained file — temporary or external image URLs will not display for viewers. Defaults to everyone in the workspace; personal Google accounts default to specific people. Set visibility to "link" for unauthenticated link sharing and use link_expires_at to choose a future RFC3339 UTC expiry or null for unlimited expiry. Omit it to use the workspace default. Pass project_id (from list_projects) to file it under a project instead of the unfiled inbox. If the result includes warnings, tell the user each warning explicitly.',
      ),
      outputSchema: ARTIFACT_OUTPUT_SCHEMA,
      annotations: PUBLIC_WRITE_ANNOTATIONS,
      inputSchema: {
        content: z
          .string()
          .min(1)
          .describe(
            'The full HTML or Markdown source to share. Do not pass a local file path; MCP cannot read the user’s filesystem.',
          ),
        title: z
          .string()
          .optional()
          .describe(
            'Display title. Defaults to the title found in the content.',
          ),
        format: z
          .enum(['html', 'markdown'])
          .optional()
          .describe('Content format. Inferred from the content when omitted.'),
        visibility: z
          .enum(['workspace', 'private', 'link'])
          .optional()
          .describe(
            'Who can view it. "workspace" = everyone in the company; "private" = only the people listed in grant_emails; "link" = anyone with the URL. When omitted, the default is the project sharing scope if project_id is set, otherwise workspace.',
          ),
        link_expires_at: z
          .string()
          .nullable()
          .optional()
          .describe(
            'For link visibility, a future RFC3339 UTC timestamp sets a finite expiry, null means unlimited expiry, and omission uses the workspace default.',
          ),
        grant_emails: z
          .array(z.string())
          .optional()
          .describe(
            'Email addresses to share with when visibility is "private".',
          ),
        project_id: z
          .string()
          .optional()
          .describe(
            'File the artifact under this project (from list_projects). Omit to leave it in the unfiled inbox. It then follows the project sharing scope unless you set visibility or grant_emails (either makes it "private" to those people instead).',
          ),
        slack_notify: z
          .boolean()
          .optional()
          .describe(
            'When Slack notifications are configured for the destination project, notify the channel by default; pass false only when the user explicitly does not want a notification.',
          ),
      },
    },
    async (args) => {
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()
      const permission = await checkUploadAccess(user)
      logUploadPermissionFailure(permission)
      if (permission.kind !== 'allowed') return permissionError(permission)
      const wsLimited = await perWorkspaceLimit(ctx, user.workspaceId)
      if (wsLimited) return wsLimited

      const format = inferFormat(args.content, args.format)
      const grantEmails = args.grant_emails ?? []
      const containerId = args.project_id ?? null
      const targetContainerKind: ContainerKind = containerId
        ? 'project'
        : 'inbox'
      // Naming recipients via grant_emails signals "share with these specific
      // people", so an omitted visibility resolves to private — otherwise the
      // container default would paradoxically widen access. With no recipients,
      // the default tracks the destination: a project follows its own scope,
      // the inbox falls back to workspace / private by account type.
      const visibility: Visibility =
        args.visibility ??
        (grantEmails.length > 0
          ? 'private'
          : defaultVisibilityFor(isOrgWorkspace(user), targetContainerKind))
      const title = args.title?.trim().slice(0, MAX_TITLE_OVERRIDE_LENGTH)

      // Idempotency: if the host re-sent this exact publish, return the artifact
      // it already created instead of a duplicate. The hash pins everything that
      // defines the artifact, so a changed scope or title is a genuine new post.
      const contentHash = await publishContentHash({
        format,
        visibility,
        grantEmails,
        title,
        content: args.content,
        containerId,
        linkExpiresAt: args.link_expires_at,
      })
      const twin = await findRecentPublish(ctx.db, {
        userId: user.id,
        contentHash,
        since: isoMsAgo(IDEMPOTENCY_WINDOW_MS),
      }).catch((err) => {
        // A lookup failure only risks a duplicate, never a crash — fail open.
        console.error('mcp_idempotency_lookup_failed', err)
        return null
      })
      if (twin) {
        return existingArtifactResult(ctx, user, twin.shareableId, visibility)
      }

      const file = buildArtifactFile(args.content, format)
      const result = await uploadShareable(
        ctx.db,
        user,
        file,
        visibility,
        grantEmails,
        containerId,
        null,
        {
          linkExpiresAt: args.link_expires_at,
          ...uploadOptionsForSlackNotify(args.slack_notify),
          auditQuery: ({ workspaceId, shareableId, createdAt }) =>
            securityAuditInsertQuery(ctx.db, {
              workspaceId,
              actorId: user.id,
              clientId: ctx.identity.clientId,
              development: ctx.identity.mode === 'dev',
              subjectId: shareableId,
              action: 'artifact.publish',
              createdAt,
            }),
        },
      )
      if (result.kind !== 'ok') {
        return uploadError(ctx, user, result, containerId)
      }
      await recordFirstArtifactPost(ctx.db, user, {
        channel: 'mcp',
        // MCP posts have no browser consent signal; measured as first-party.
        sendToGa: true,
        waitUntil: (promise) => ctx.executionContext.waitUntil(promise),
      })

      // The artifact is committed (R2 + D1). Everything below is best-effort:
      // never let it throw, or the agent would treat a successful publish as
      // failed and retry into a duplicate. Record the post first (it powers the
      // audit trail and the idempotency check above), then enrich the title.
      // `visibility` is authoritative for the output below: we only reach here
      // after a successful upload, so project_id resolved to a real project
      // container. It's the only way `visibility` is 'project', so
      // visibilityForContainer never downgraded it — output matches what was
      // stored.
      try {
        await recordArtifactPost(ctx.db, {
          shareableId: result.id,
          userId: user.id,
          workspaceId: user.workspaceId,
          clientId: ctx.identity.clientId,
          action: 'publish',
          contentHash,
        })
      } catch (err) {
        console.error('mcp_publish_record_failed', {
          shareable_id: result.id,
          err,
        })
      }
      let resolvedTitle: string | null = title || null
      try {
        if (title) {
          await updateShareableMetadata(
            ctx.db,
            { id: user.id, workspaceId: user.workspaceId },
            result.id,
            { titleOverride: title },
          )
        }
        const summary = await getOwnedShareableSummary(ctx.db, user, result.id)
        if (summary) resolvedTitle = summary.title
      } catch (err) {
        console.error('mcp_publish_enrichment_failed', {
          shareable_id: result.id,
          err,
        })
      }
      return jsonResult({
        id: result.id,
        share_url: shareUrl(ctx.baseUrl, result.id),
        title: resolvedTitle,
        visibility,
        link_expires_at: result.linkExpiresAt,
        visibility_label: scopeLabel(visibility, user.locale),
        ...(slackReauthorizationWarnings(
          result.slackNotificationSuppressed,
          user.locale,
        )
          ? {
              warnings: slackReauthorizationWarnings(
                result.slackNotificationSuppressed,
                user.locale,
              ),
            }
          : {}),
      })
    },
  )

  server.registerTool(
    'update_artifact',
    {
      title: 'Update artifact',
      description: toolDescription(
        'Replace an existing artifact with a new version. The share link stays the same. Pass the new full HTML or Markdown source in content, not a local file path. In chat or a temporary sandbox, keep the source inline. When no explicit route was chosen, use the CLI for a coding agent with a user-controlled workspace, CLI package access, and Artifact Share network access: `npx --yes @artifactshare/cli update <share-url> <path>`. MCP OAuth is separate from CLI auth; if the CLI reports `auth_required`, follow its recovery to set up or reuse a profile. If you do not know the id, call list_artifacts first.',
      ),
      outputSchema: UPDATE_OUTPUT_SCHEMA,
      annotations: PUBLIC_WRITE_ANNOTATIONS,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe('The artifact id from share_artifact or list_artifacts.'),
        content: z
          .string()
          .min(1)
          .describe(
            'The new HTML or Markdown source for this artifact. Do not pass a local file path; MCP cannot read the user’s filesystem.',
          ),
        format: z
          .enum(['html', 'markdown'])
          .optional()
          .describe('Content format. Inferred from the content when omitted.'),
      },
    },
    async (args) => {
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()
      const permission = await checkUploadAccess(user)
      logUploadPermissionFailure(permission)
      if (permission.kind !== 'allowed') return permissionError(permission)
      const wsLimited = await perWorkspaceLimit(ctx, user.workspaceId)
      if (wsLimited) return wsLimited

      const format = inferFormat(args.content, args.format)
      const file = buildArtifactFile(args.content, format)
      const result = await createVersion({
        db: ctx.db,
        user,
        shareableId: args.id,
        file,
        waitUntil: (promise) => ctx.executionContext.waitUntil(promise),
        auditQuery: ({ workspaceId, shareableId, createdAt }) =>
          securityAuditInsertQuery(ctx.db, {
            workspaceId,
            actorId: user.id,
            clientId: ctx.identity.clientId,
            development: ctx.identity.mode === 'dev',
            subjectId: shareableId,
            action: 'artifact.update',
            createdAt,
          }),
      })
      if (result.kind !== 'ok') return versionError(result)

      // Record the revision for the audit trail (which client revised what). The
      // content hash identifies this version's payload; updates aren't deduped,
      // so a resend lands a new version (retained, non-destructive).
      try {
        await recordArtifactPost(ctx.db, {
          shareableId: args.id,
          userId: user.id,
          workspaceId: user.workspaceId,
          clientId: ctx.identity.clientId,
          action: 'update',
          contentHash: await computeTextSha256(`${format}\n${args.content}`),
        })
      } catch (err) {
        console.error('mcp_update_record_failed', {
          shareable_id: args.id,
          err,
        })
      }

      // The new version is committed; the summary read is best-effort. On a miss
      // report null rather than guessing a scope (update never changes it) — an
      // absent visibility is safer to surface than a wrong one.
      let summary: OwnedShareableSummary | null = null
      try {
        summary = await getOwnedShareableSummary(ctx.db, user, args.id)
      } catch (err) {
        console.error('mcp_update_summary_failed', {
          shareable_id: args.id,
          err,
        })
      }
      return jsonResult({
        id: args.id,
        share_url: shareUrl(ctx.baseUrl, args.id),
        title: summary?.title ?? null,
        visibility: summary?.visibility ?? null,
        link_expires_at: summary?.linkExpiresAt ?? null,
        visibility_label: summary
          ? scopeLabel(summary.visibility, user.locale)
          : null,
        version_id: result.versionId,
      })
    },
  )

  server.registerTool(
    'append_artifact',
    {
      title: 'Append to artifact',
      description: toolDescription(
        'Append content exactly as provided to an existing single-file artifact. Use inline source in chat or a temporary sandbox; when no explicit route was chosen, use the CLI for a coding agent with a user-controlled workspace, CLI package access, and Artifact Share network access: `npx --yes @artifactshare/cli append <share-url> <path>`. MCP OAuth is separate from CLI auth; follow the CLI `auth_required` recovery to set up or reuse a profile. No newline or separator is inserted. For Markdown, add it to the end of the current source with no separator. For HTML, insert it immediately before an ASCII case-insensitive </body> closing tag; if none exists, add it at the end. A new version is created at the same share URL. Retry the same append_artifact call after version_conflict to append to the latest version without overwriting the earlier update. After a transport error, call get_artifact before retrying because the append may have committed. Inspect the source end for Markdown; for HTML, inspect immediately before the selected closing body tag, or the source end when that tag is absent. Static sites are not supported.',
      ),
      outputSchema: UPDATE_OUTPUT_SCHEMA,
      annotations: PUBLIC_WRITE_ANNOTATIONS,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe('The artifact id from share_artifact or list_artifacts.'),
        content: z
          .string()
          .min(1)
          .describe(
            'Non-empty content to insert without adding a separator. Markdown places it at the end of the current source. HTML places it immediately before an ASCII case-insensitive </body> closing tag, or at the end when that tag is absent.',
          ),
      },
    },
    async (args) => {
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()
      const permission = await checkUploadAccess(user)
      logUploadPermissionFailure(permission)
      if (permission.kind !== 'allowed') return permissionError(permission)
      const wsLimited = await perWorkspaceLimit(ctx, user.workspaceId)
      if (wsLimited) return wsLimited

      const result = await appendShareable(
        ctx.db,
        user,
        args.id,
        args.content,
        { waitUntil: (promise) => ctx.executionContext.waitUntil(promise) },
      )
      if (result.kind === 'version-conflict')
        return toolError({
          code: 'version_conflict',
          message: result.currentVersionId
            ? `The artifact changed before append. Current version: ${result.currentVersionId}.`
            : 'The artifact changed before append.',
          recoverable_by: 'agent',
          hint: 'Retry the same append_artifact call to append to the latest version.',
        })
      if (result.kind === 'copy-forbidden')
        return toolError({
          code: 'copy-forbidden',
          message:
            'Static sites are not supported. Use update_artifact to replace the full source.',
          recoverable_by: 'agent',
        })
      if (result.kind !== 'ok') return versionError(result)

      let summary: OwnedShareableSummary | null = null
      try {
        summary = await getOwnedShareableSummary(ctx.db, user, args.id)
      } catch (err) {
        console.error('mcp_append_summary_failed', {
          shareable_id: args.id,
          err,
        })
      }
      return jsonResult({
        id: args.id,
        share_url: shareUrl(ctx.baseUrl, args.id),
        title: summary?.title ?? null,
        visibility: summary?.visibility ?? null,
        link_expires_at: summary?.linkExpiresAt ?? null,
        visibility_label: summary
          ? scopeLabel(summary.visibility, user.locale)
          : null,
        version_id: result.versionId,
      })
    },
  )

  server.registerTool(
    'list_artifacts',
    {
      title: 'List artifacts',
      description: toolDescription(
        'List artifacts (id, title, link, visibility, project, updated time), newest first. Without project_id, list only artifacts you own. With project_id, list artifacts visible to you under that project, including owner_email. Filter with project_id (a project id from list_projects, or "" for the unfiled inbox) and/or query (a title search). If has_more is true, pass next_cursor as cursor to retrieve the next page.',
      ),
      outputSchema: LIST_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        project_id: z
          .string()
          .optional()
          .describe(
            'Only artifacts in this project (a project id from list_projects), or "" for the unfiled inbox. Omit for all.',
          ),
        query: z
          .string()
          .optional()
          .describe(
            'Only artifacts whose title contains this text (case-insensitive).',
          ),
        cursor: z
          .string()
          .optional()
          .describe('Cursor returned as next_cursor for the previous page.'),
      },
    },
    async (args) => {
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()
      const result = await listCliArtifacts(
        ctx.db,
        mcpUserAsSessionUser(user),
        {
          baseUrl: ctx.baseUrl,
          projectId: args.project_id,
          query: args.query,
          cursor: args.cursor,
        },
      )
      if (result.kind === 'invalid-project') {
        return toolError({
          code: 'not-found',
          message: 'No project with that id is available to you.',
          recoverable_by: 'agent',
          hint: 'Call list_projects for the project ids you can use.',
        })
      }
      if (result.kind === 'invalid-cursor') {
        return toolError({
          code: 'validation_failed',
          message:
            'The cursor is invalid or does not match the requested filters.',
          recoverable_by: 'agent',
          hint: 'Restart listing without cursor and use the returned next_cursor unchanged.',
        })
      }
      return jsonResult({
        ...result.data,
        artifacts: result.data.artifacts.map((artifact) => ({
          ...artifact,
          visibility_label: scopeLabel(artifact.visibility, user.locale),
        })),
      })
    },
  )

  server.registerTool(
    'get_artifact',
    {
      title: 'Get artifact',
      description: toolDescription(
        'Read back the Markdown or HTML source of an artifact you can view — your own, or one shared with you in your workspace. The response returns the source in content and the current version in version_id. Pass include to also return the version history ("versions") of your own artifacts in the same call. To read comment threads, call list_comments. If you do not know the id, call list_artifacts first. If the response sets truncated:true, the source is larger than one read returns: call get_artifact again with offset set to the returned next_offset and concatenate the content parts, until truncated is false. Multi-file sites cannot be read this way.',
      ),
      outputSchema: GET_ARTIFACT_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe('The artifact id from list_artifacts or share_artifact.'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Character offset to start reading the source from. Omit to read from the start. When a read returns truncated:true, call again with offset set to the returned next_offset to continue.',
          ),
        include: z
          .array(z.enum(['versions']))
          .optional()
          .describe(
            'Extra data to return alongside the source: "versions" for the version history (your own artifacts only). Omit for source only.',
          ),
      },
    },
    async (args) => {
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()

      const sessionUser = mcpUserAsSessionUser(user)
      const result = await getArtifactReadback(ctx.db, sessionUser, {
        id: args.id,
        baseUrl: ctx.baseUrl,
        offset: args.offset,
        include: args.include,
      })
      switch (result.kind) {
        case 'ok':
          return jsonResult(result.data)
        case 'not-found':
          return artifactNotViewableError()
        case 'unsupported-kind':
          return unreadableKindError(result.artifactKind)
        case 'source-unavailable':
          return sourceUnavailableError()
        default: {
          const _exhaustive: never = result
          return _exhaustive
        }
      }
    },
  )

  server.registerTool(
    'preview_artifact',
    {
      title: 'Preview artifact',
      description: toolDescription(
        'Show a compact card for an artifact you can view — your own, or one shared with you in your workspace — with an action to open the full artifact in Artifact Share. Use it when the user wants to inspect or open a shared artifact. If you do not know the id, call list_artifacts first.',
      ),
      outputSchema: PREVIEW_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      // Link the tool to its UI widget. ChatGPT reads the "openai/outputTemplate"
      // alias; Claude and the MCP Apps standard read "_meta.ui.resourceUri".
      // Setting both makes one tool render in either host.
      _meta: {
        ui: { resourceUri: ARTIFACT_PREVIEW_TEMPLATE_URI },
        'openai/outputTemplate': ARTIFACT_PREVIEW_TEMPLATE_URI,
        'openai/toolInvocation/invoking': 'Opening preview…',
        'openai/toolInvocation/invoked': 'Preview ready.',
      },
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe('The artifact id from list_artifacts or share_artifact.'),
      },
    },
    async (args) => {
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()

      // Viewer-scoped (same check as get_artifact / commenting): you can open
      // anything you can view, not just what you own. A non-viewable (or absent)
      // id refuses without leaking which it was. The card carries metadata only,
      // so every artifact kind follows the same path.
      const sessionUser = mcpUserAsSessionUser(user)
      const access = await loadCommentAccess(ctx.db, sessionUser, args.id)
      if (!access) return artifactNotViewableError()

      // The title is a nicety for the card; read it best-effort for your own
      // artifacts. Shared artifacts use the localized kind label instead.
      let title: string | null = null
      if (access.ownerUserId === user.id) {
        try {
          const summary = await getOwnedShareableSummary(ctx.db, user, args.id)
          title = summary?.title ?? null
        } catch (err) {
          console.error('mcp_preview_title_failed', {
            shareable_id: args.id,
            err,
          })
        }
      }

      const shareLink = shareUrl(ctx.baseUrl, args.id)
      const locale = isSupportedLocale(user.locale)
        ? user.locale
        : DEFAULT_LOCALE
      return {
        content: textContent({
          id: args.id,
          share_url: shareLink,
          title,
          locale,
        }),
        structuredContent: {
          id: args.id,
          share_url: shareLink,
          title,
          artifact_kind: access.artifactKind as ArtifactKind,
          locale,
        },
      }
    },
  )

  server.registerTool(
    'list_comments',
    {
      title: 'List comments',
      description: toolDescription(
        'List comment threads on an artifact you can view in your workspace. Returns thread ids, message ids, authors, bodies, and resolution status — use those ids with post_comment, update_comment, delete_comment, resolve_comment, or reopen_comment. Does not return the artifact source; call get_artifact for that. If you do not know the id, call list_artifacts first.',
      ),
      outputSchema: LIST_COMMENTS_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe('The artifact id from list_artifacts or share_artifact.'),
      },
    },
    async (args) => {
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()

      const sessionUser = mcpUserAsSessionUser(user)
      const access = await loadCommentAccess(ctx.db, sessionUser, args.id)
      if (!access) return artifactNotViewableError()

      const threads = await loadCommentThreads(ctx.db, access, sessionUser)
      return jsonResult({
        artifact_id: args.id,
        share_url: shareUrl(ctx.baseUrl, args.id),
        comments: threads.map(toAgentCommentThread),
        comments_has_more: threads.length >= COMMENT_THREAD_LIST_LIMIT,
      })
    },
  )

  server.registerTool(
    'post_comment',
    {
      title: 'Post comment',
      description: toolDescription(
        'Post a comment on an artifact you can view in your workspace, as the connected user. Start a new thread, reply to one, or anchor a comment to a quoted span of the text. Pass reply_to (a thread id from list_comments) to reply. To anchor the comment to a span, pass quote with the exact text to highlight (copy it from get_artifact); add quote_before / quote_after if the same text appears more than once. Omit reply_to and quote to comment on the whole artifact. Everyone who can view the artifact will see it.',
      ),
      outputSchema: POST_COMMENT_OUTPUT_SCHEMA,
      annotations: WRITE_ANNOTATIONS,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe('The artifact id from list_artifacts or share_artifact.'),
        body: z
          .string()
          .min(1)
          .max(MAX_COMMENT_BODY_LENGTH)
          .describe('The comment text.'),
        reply_to: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(
            'Reply to this thread (a thread id from list_comments). Omit to start a new thread.',
          ),
        quote: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Anchor the comment to this exact text from the artifact (copy it from get_artifact). Only when starting a new thread.',
          ),
        quote_before: z
          .string()
          .optional()
          .describe(
            'Text just before the quote, to pick the right occurrence when it repeats.',
          ),
        quote_after: z
          .string()
          .optional()
          .describe(
            'Text just after the quote, to pick the right occurrence when it repeats.',
          ),
        agent: z
          .string()
          .max(30)
          .optional()
          .describe(
            'The name of the agent posting on behalf of the user (e.g. "Claude", "Cursor"). Omit when the human is posting directly.',
          ),
      },
    },
    async (args) => {
      // Per-caller limit only: a comment is a couple of D1 rows with no storage
      // cost, so it shouldn't draw down the per-workspace storage-write budget
      // (that guards publish / update). The per-user limit is the spam backstop.
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()

      // postArtifactComment is the shared pipeline with the CLI comments
      // route: input rules, view check, anchor handling, and failure kinds
      // stay identical across both agent surfaces.
      const sessionUser = mcpUserAsSessionUser(user)
      const result = await postArtifactComment(
        ctx.db,
        sessionUser,
        args.id,
        {
          body: args.body,
          replyTo: args.reply_to,
          quote: args.quote,
          quoteBefore: args.quote_before,
          quoteAfter: args.quote_after,
          agent: args.agent,
        },
        commentMutationOptions,
      )
      if (result.kind !== 'ok') return postCommentError(result)
      return jsonResult({
        artifact_id: args.id,
        share_url: shareUrl(ctx.baseUrl, args.id),
        thread_id: result.threadId,
        reply: result.reply,
        thread: toAgentCommentThread(result.thread),
      })
    },
  )

  server.registerTool(
    'update_comment',
    {
      title: 'Update comment',
      description: toolDescription(
        'Edit a comment you wrote. Identify the thread with thread_id and the message with message_id (both from list_comments). Pass body with the new text — you can only edit your own comments.',
      ),
      outputSchema: UPDATE_COMMENT_OUTPUT_SCHEMA,
      annotations: WRITE_ANNOTATIONS,
      inputSchema: {
        thread_id: z
          .string()
          .min(1)
          .describe('The thread id from list_comments.'),
        message_id: z
          .string()
          .min(1)
          .describe('The message to edit (from list_comments).'),
        body: z
          .string()
          .min(1)
          .max(MAX_COMMENT_BODY_LENGTH)
          .describe('New text for the message named by message_id.'),
      },
    },
    async (args) => {
      // Per-caller limit only: a comment edit is a couple of D1 rows with no
      // storage cost, so it stays off the per-workspace budget.
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()

      const sessionUser = mcpUserAsSessionUser(user)
      const access = await loadCommentAccessForThread(
        ctx.db,
        sessionUser,
        args.thread_id,
      )
      if (!access) return threadNotFoundError()

      const result = await changeComment(
        ctx.db,
        access,
        sessionUser,
        updateCommentInput(args),
        commentMutationOptions,
      )
      if (result.kind !== 'ok') return commentActionError(result)
      if ('deleted' in result) return commentActionFailedError()
      return jsonResult({
        thread_id: args.thread_id,
        thread: toAgentCommentThread(result.thread),
      })
    },
  )

  server.registerTool(
    'resolve_comment',
    {
      title: 'Resolve comment',
      description: toolDescription(
        'Mark a comment thread as resolved. Pass thread_id from list_comments. The thread author, the artifact owner, or a workspace admin can resolve it.',
      ),
      outputSchema: UPDATE_COMMENT_OUTPUT_SCHEMA,
      annotations: WRITE_ANNOTATIONS,
      inputSchema: {
        thread_id: z
          .string()
          .min(1)
          .describe('The thread id from list_comments.'),
      },
    },
    async (args) => {
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()

      const sessionUser = mcpUserAsSessionUser(user)
      const access = await loadCommentAccessForThread(
        ctx.db,
        sessionUser,
        args.thread_id,
      )
      if (!access) return threadNotFoundError()

      const result = await changeComment(
        ctx.db,
        access,
        sessionUser,
        {
          kind: 'update',
          threadId: args.thread_id,
          resolved: true,
        },
        commentMutationOptions,
      )
      if (result.kind !== 'ok') return commentActionError(result)
      if ('deleted' in result) return commentActionFailedError()
      return jsonResult({
        thread_id: args.thread_id,
        thread: toAgentCommentThread(result.thread),
      })
    },
  )

  server.registerTool(
    'reopen_comment',
    {
      title: 'Reopen comment',
      description: toolDescription(
        'Reopen a resolved comment thread. Pass thread_id from list_comments. The thread author, the artifact owner, or a workspace admin can reopen it.',
      ),
      outputSchema: UPDATE_COMMENT_OUTPUT_SCHEMA,
      annotations: WRITE_ANNOTATIONS,
      inputSchema: {
        thread_id: z
          .string()
          .min(1)
          .describe('The thread id from list_comments.'),
      },
    },
    async (args) => {
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()

      const sessionUser = mcpUserAsSessionUser(user)
      const access = await loadCommentAccessForThread(
        ctx.db,
        sessionUser,
        args.thread_id,
      )
      if (!access) return threadNotFoundError()

      const result = await changeComment(
        ctx.db,
        access,
        sessionUser,
        {
          kind: 'update',
          threadId: args.thread_id,
          resolved: false,
        },
        commentMutationOptions,
      )
      if (result.kind !== 'ok') return commentActionError(result)
      if ('deleted' in result) return commentActionFailedError()
      return jsonResult({
        thread_id: args.thread_id,
        thread: toAgentCommentThread(result.thread),
      })
    },
  )

  server.registerTool(
    'delete_comment',
    {
      title: 'Delete comment',
      description: toolDescription(
        'Delete a single comment, or a whole comment thread, identified by thread_id (from list_comments). Pass message_id to delete just that message; omit it to delete the entire thread. Deleting the last message in a thread removes the thread too. This cannot be undone. You can delete your own comments; the artifact owner or a workspace admin can delete any comment or thread on it.',
      ),
      outputSchema: DELETE_COMMENT_OUTPUT_SCHEMA,
      annotations: DESTRUCTIVE_ANNOTATIONS,
      inputSchema: {
        thread_id: z
          .string()
          .min(1)
          .describe('The thread id from list_comments.'),
        message_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Delete just this message (from list_comments). Omit to delete the whole thread.',
          ),
      },
    },
    async (args) => {
      // Per-caller limit only: a delete frees a couple of D1 rows, so it stays
      // off the per-workspace storage-write budget.
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()

      const sessionUser = mcpUserAsSessionUser(user)
      const access = await loadCommentAccessForThread(
        ctx.db,
        sessionUser,
        args.thread_id,
      )
      if (!access) return threadNotFoundError()

      const result = await changeComment(
        ctx.db,
        access,
        sessionUser,
        {
          kind: 'delete',
          threadId: args.thread_id,
          ...(args.message_id ? { messageId: args.message_id } : {}),
        },
        commentMutationOptions,
      )
      if (result.kind !== 'ok') return commentActionError(result)
      if (!('deleted' in result)) return commentActionFailedError()

      return jsonResult({
        thread_id: args.thread_id,
        deleted: true,
        thread_deleted: result.threadDeleted,
        ...(result.thread
          ? { thread: toAgentCommentThread(result.thread) }
          : {}),
      })
    },
  )

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: toolDescription(
        'List the projects in your workspace, each with its id, name, and sharing scope. Sharing scope is "workspace" (everyone in your workspace can view the project\'s artifacts) or "private" (only the project audience can). Projects group related artifacts; the unfiled inbox is not a project and is not listed.',
      ),
      outputSchema: LIST_PROJECTS_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()
      // In-workspace projects only. Projects shared from other workspaces (where
      // this user is just an audience member) are left out: the token must not
      // reach outside its own workspace, and they aren't valid publish / move
      // targets anyway. Returned unpaginated — projects are a small curated set,
      // unlike artifacts, so there's nothing to page past.
      const projects = await listWorkspaceProjects(
        ctx.db,
        user.workspaceId,
        user,
      )
      return jsonResult({
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          description: project.description,
          base_visibility: project.baseVisibility,
          base_visibility_label: projectScopeLabel(
            project.baseVisibility,
            user.locale,
          ),
          file_count: project.fileCount,
        })),
      })
    },
  )

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description: toolDescription(
        'Create a project in your workspace to group related artifacts, and get its id back. Use the id with share_artifact or edit_artifact to file artifacts under it. base_visibility sets the sharing scope for the project\'s artifacts: "workspace" = everyone in the company can view them, "private" = only the project audience (set audience with edit_project). Defaults to "workspace".',
      ),
      outputSchema: CREATE_PROJECT_OUTPUT_SCHEMA,
      annotations: WRITE_ANNOTATIONS,
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe('Project name (up to 120 characters).'),
        description: z
          .string()
          .optional()
          .describe('Optional description (up to 500 characters).'),
        base_visibility: z
          .enum(['workspace', 'private'])
          .optional()
          .describe(
            'Sharing scope for the project\'s artifacts. Defaults to "workspace".',
          ),
      },
    },
    async (args) => {
      // Per-caller limit only: creating a project is a single D1 row with no
      // storage cost, so it stays off the per-workspace storage-write budget.
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()
      const permission = await checkUploadAccess(user)
      logUploadPermissionFailure(permission)
      if (permission.kind !== 'allowed') return permissionError(permission)

      const name = normalizeProjectName(args.name)
      if (!name) return invalidProjectNameError()
      const description = normalizeProjectDescription(args.description ?? null)
      const baseVisibility = parseProjectBaseVisibility(args.base_visibility)
      const created = await createProjectContainer(
        ctx.db,
        user.workspaceId,
        user.id,
        {
          name,
          description,
          baseVisibility,
        },
      )
      if (created.kind === 'project-limit-reached') {
        return projectLimitReachedError(ctx, user, created)
      }
      return jsonResult({
        id: created.id,
        name,
        description,
        base_visibility: baseVisibility,
        base_visibility_label: projectScopeLabel(baseVisibility, user.locale),
        file_count: 0,
      })
    },
  )

  server.registerTool(
    'edit_project',
    {
      title: 'Edit project',
      description: toolDescription(
        "Change a project's settings in one call: rename it, edit its description, change its sharing scope, add or remove people from its audience, and archive or unarchive it. Pass only the fields you want to change; omitted fields are left as-is. The audience (add_emails / remove_emails) is who can view the project's private-scoped artifacts, including people outside the workspace. Set archived to true to hide the project from the active list, or false to bring it back. Only the project's creator or a workspace admin can edit it. Editing a project's name, description, scope, or audience requires it to be active — pass archived: false in the same call to unarchive and edit it together.",
      ),
      outputSchema: EDIT_PROJECT_OUTPUT_SCHEMA,
      annotations: WRITE_ANNOTATIONS,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe('The project id from list_projects or create_project.'),
        name: z
          .string()
          .optional()
          .describe('New project name (up to 120 characters).'),
        description: z
          .string()
          .optional()
          .describe(
            'New description (up to 500 characters). Pass an empty string to clear it.',
          ),
        base_visibility: z
          .enum(['workspace', 'private'])
          .optional()
          .describe(
            'Sharing scope for the project\'s artifacts: "workspace" = everyone in the company, "private" = only the audience.',
          ),
        add_emails: z
          .array(z.string())
          .optional()
          .describe('Email addresses to add to the project audience.'),
        remove_emails: z
          .array(z.string())
          .optional()
          .describe('Email addresses to remove from the project audience.'),
        archived: z
          .boolean()
          .optional()
          .describe(
            'Set to true to archive (hide from the active list), false to unarchive. Omit to leave the archive state unchanged.',
          ),
      },
    },
    async (args) => {
      // Per-caller limit only: project edits are metadata-only D1 writes with no
      // storage cost, so they stay off the per-workspace storage-write budget.
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()

      const result = await editProjectContainerSettings(
        ctx.db,
        user.workspaceId,
        args.id,
        user,
        {
          name: args.name,
          description: args.description,
          baseVisibility:
            args.base_visibility !== undefined
              ? parseProjectBaseVisibility(args.base_visibility)
              : undefined,
          addEmails: args.add_emails,
          removeEmails: args.remove_emails,
          archived: args.archived,
        },
      )
      if (result.kind !== 'ok') return projectEditError(ctx, user, result)

      const state = result.project
      return jsonResult({
        id: state.id,
        name: state.name,
        description: state.description,
        base_visibility: state.baseVisibility,
        base_visibility_label: projectScopeLabel(
          state.baseVisibility,
          user.locale,
        ),
        file_count: state.fileCount,
        archived: state.archivedAt !== null,
        audience: result.audience,
      })
    },
  )

  server.registerTool(
    'edit_artifact',
    {
      title: 'Edit artifact settings',
      description: toolDescription(
        'Change an artifact\'s settings in one call: rename it, change who can view it, set or clear a link expiry, add or remove specific viewers, and file it under a project or back to the unfiled inbox. Pass only the fields you want to change; omitted fields are left as-is. The share link and version history stay the same — use update_artifact instead to replace the content. visibility "workspace" = everyone in the company, "private" = only the people you share with, and "link" = anyone with the URL. For an existing link, omitted link_expires_at preserves its current expiry; null requests unlimited expiry when allowed. To change the location, set project_id to a project id (from list_projects), or to "" (empty string) to return it to the unfiled inbox; omit project_id to leave the location unchanged. Moving never widens who can view it.',
      ),
      outputSchema: EDIT_OUTPUT_SCHEMA,
      annotations: PUBLIC_WRITE_ANNOTATIONS,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe('The artifact id from list_artifacts or share_artifact.'),
        title: z
          .string()
          .optional()
          .describe(
            'New display title. Pass an empty string to clear it and fall back to the title in the content.',
          ),
        visibility: z
          .enum(['workspace', 'private', 'link'])
          .optional()
          .describe(
            'Who can view it. "workspace" = everyone in the company; "private" = only the people shared with; "link" = anyone with the URL.',
          ),
        link_expires_at: z
          .string()
          .nullable()
          .optional()
          .describe(
            'For link visibility, a future RFC3339 UTC timestamp sets a finite expiry, null means unlimited expiry. Omit to preserve an existing link expiry or use the workspace default when changing a non-link artifact to link.',
          ),
        add_emails: z
          .array(z.string())
          .optional()
          .describe('Email addresses to grant view access to.'),
        remove_emails: z
          .array(z.string())
          .optional()
          .describe('Email addresses to revoke view access from.'),
        project_id: z
          .string()
          .optional()
          .describe(
            'Move the artifact: a project id (from list_projects) files it under that project; "" (empty string) returns it to the unfiled inbox. Omit to leave its location unchanged.',
          ),
      },
    },
    async (args) => {
      // Per-caller limit only: an edit is metadata-only D1 writes with no storage
      // cost, so it stays off the per-workspace storage-write budget — same as
      // post_comment.
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()

      const edited = await editShareableSettings(
        ctx.db,
        user,
        args.id,
        payloadFromMcpEditArgs(args),
      )
      if (edited.kind === 'not-found') return artifactNotFoundError()
      if (edited.kind === 'invalid-destination')
        return invalidDestinationError()
      if (edited.kind !== 'ok') return editShareError(edited)

      const state = edited.shareable
      return jsonResult({
        id: args.id,
        share_url: shareUrl(ctx.baseUrl, args.id),
        title: state.title,
        visibility: state.visibility,
        link_expires_at: state.linkExpiresAt,
        visibility_label: scopeLabel(state.visibility, user.locale),
        project_id: state.projectId,
      })
    },
  )

  server.registerTool(
    'delete_artifact',
    {
      title: 'Delete artifact',
      description: toolDescription(
        'Permanently delete an artifact you published, including its entire version history. This cannot be undone and the share link stops working. Only the owner can delete it. To stop sharing without deleting, use edit_artifact to set visibility to "private" instead.',
      ),
      outputSchema: DELETE_OUTPUT_SCHEMA,
      annotations: DESTRUCTIVE_ANNOTATIONS,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe('The artifact id from list_artifacts or share_artifact.'),
      },
    },
    async (args) => {
      // Per-caller limit only: a delete frees storage rather than consuming it,
      // so it stays off the per-workspace storage-write budget.
      const limited = await perUserLimit(ctx)
      if (limited) return limited
      const user = await getUser()
      if (!user) return unresolvedUserError()

      // Owner-scoped: no options are passed, so deleteShareable only takes its
      // owner path (the manager-delete path is opt-in and stays off here). A
      // non-owned id is reported as not-found without revealing it exists.
      const result = await deleteShareable(
        ctx.db,
        {
          id: user.id,
          workspaceId: user.workspaceId,
          emailVerified: user.emailVerified,
        },
        args.id,
      )
      if (result.kind === 'not-found') return artifactNotFoundError()
      if (result.kind === 'delete-failed') {
        return toolError({
          code: 'delete-failed',
          message: 'Could not delete the artifact. Try again.',
          recoverable_by: 'agent',
        })
      }
      return jsonResult(deleteArtifactSuccessBody(args.id))
    },
  )
}

function updateCommentInput(args: {
  thread_id: string
  message_id: string
  body: string
}): ChangeCommentInput {
  return {
    kind: 'update',
    threadId: args.thread_id,
    messageId: args.message_id,
    body: args.body,
  }
}

// ── result shaping ───────────────────────────────────────────────

function textContent(payload: unknown): ToolTextResult['content'] {
  return [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
}

function jsonResult(payload: Record<string, unknown>): ToolTextResult {
  return { content: textContent(payload), structuredContent: payload }
}

function toolError(error: {
  code: string
  message: string
  recoverable_by: 'agent' | 'human'
  hint?: string
  upgrade_request?: UpgradeRequest
}): ToolTextResult {
  return { isError: true, content: textContent({ error }) }
}

// ── rate limiting ────────────────────────────────────────────────

// Gate one tool call on a limiter. Returns an error result to short-circuit the
// handler when over budget, or null to proceed. Fail open: a missing limiter
// (tests / unconfigured binding) or a limiter error never blocks a real call —
// the limit is an abuse backstop, not a correctness gate.
async function rateLimitGuard(
  limiter: RateLimiter | null,
  key: string,
): Promise<ToolTextResult | null> {
  if (!limiter) return null
  try {
    const { success } = await limiter.limit({ key })
    return success ? null : rateLimitError()
  } catch (err) {
    console.error('mcp_rate_limit_failed', err)
    return null
  }
}

// Per-caller limit (the token's `sub`); covers every tool, including reads.
function perUserLimit(ctx: McpRequestContext): Promise<ToolTextResult | null> {
  return rateLimitGuard(
    ctx.rateLimiters.perUser,
    `mcp:user:${ctx.identity.userId}`,
  )
}

// Per-workspace limit; guards the storage-writing tools (publish / update).
function perWorkspaceLimit(
  ctx: McpRequestContext,
  workspaceId: string,
): Promise<ToolTextResult | null> {
  return rateLimitGuard(ctx.rateLimiters.perWorkspace, `mcp:ws:${workspaceId}`)
}

function rateLimitError(): ToolTextResult {
  return toolError({
    code: 'rate-limited',
    message: 'Too many requests in a short time.',
    recoverable_by: 'agent',
    hint: 'Wait a moment before trying again.',
  })
}

function unresolvedUserError(): ToolTextResult {
  return toolError({
    code: 'workspace-unresolved',
    message: 'Could not resolve your workspace from this connection.',
    recoverable_by: 'human',
    hint: 'Reconnect the connector and sign in with Google again.',
  })
}

function artifactNotFoundError(): ToolTextResult {
  return toolError({
    code: 'not-found',
    message: 'No artifact with that id is owned by you.',
    recoverable_by: 'agent',
    hint: 'Call list_artifacts to find the right id.',
  })
}

// project_id named a container that isn't a usable project in the caller's
// workspace — a wrong id, another workspace's project, or an archived one.
// Shared by share_artifact and edit_artifact: both take a project_id and fall
// back to the unfiled inbox when it's omitted.
function invalidDestinationError(): ToolTextResult {
  return toolError({
    code: 'invalid-destination',
    message: 'project_id does not match a project in your workspace.',
    recoverable_by: 'agent',
    hint: 'Pass a project_id from list_projects, or omit it to use the unfiled inbox.',
  })
}

// Map a failed share-settings change (visibility / grants) to an agent-facing
// error. not-found is owner-scoped (handled like artifactNotFoundError); the
// rest mirror the upload errors so the wording stays consistent across tools.
function editShareError(
  result: Exclude<
    EditShareableSettingsResult,
    { kind: 'ok' | 'invalid-destination' }
  >,
): ToolTextResult {
  switch (result.kind) {
    case 'not-found':
      return artifactNotFoundError()
    case 'bot-artifact-grant-unsupported':
      return toolError({
        code: 'bot-artifact-grant-unsupported',
        message: 'Bots cannot receive artifact-level grants.',
        recoverable_by: 'agent',
        hint: "Share the bot's project audience instead of the single artifact.",
      })
    case 'bot-home-unavailable':
      return toolError({
        code: 'bot-home-unavailable',
        message: 'Bot-owned artifacts have no home destination.',
        recoverable_by: 'agent',
        hint: 'Move the artifact to a project instead.',
      })
    case 'workspace-unavailable':
      return toolError({
        code: 'workspace-scope-unavailable',
        message:
          'This is a personal Google account, so it cannot share with a whole company.',
        recoverable_by: 'agent',
        hint: 'Set visibility to "private" and pass viewers as add_emails instead.',
      })
    case 'link-sharing-plan-required':
      return toolError({
        code: 'link-sharing-plan-required',
        message: 'Link sharing requires a Plus or Team plan.',
        recoverable_by: 'human',
      })
    case 'link-sharing-disabled':
      return toolError({
        code: 'link-sharing-disabled',
        message: 'Link sharing is disabled for this workspace.',
        recoverable_by: 'human',
      })
    case 'link-expiry-invalid':
      return toolError({
        code: 'link-expiry-invalid',
        message: 'The link expiry is invalid for this workspace policy.',
        recoverable_by: 'agent',
        hint: 'Pass a future RFC3339 UTC timestamp within the workspace maximum, or null only when unlimited expiry is allowed.',
      })
    case 'too-many-grants':
      return toolError({
        code: 'too-many-grants',
        message: `Share with at most ${result.limit} email addresses.`,
        recoverable_by: 'agent',
      })
    case 'commit-failed':
      return toolError({
        code: 'edit-failed',
        message: 'Could not save the changes. Try again.',
        recoverable_by: 'agent',
      })
  }
}

function invalidProjectNameError(): ToolTextResult {
  return toolError({
    code: 'invalid-name',
    message: 'A project name is required.',
    recoverable_by: 'agent',
    hint: 'Pass a non-empty name.',
  })
}

async function projectLimitReachedError(
  ctx: McpRequestContext,
  user: McpUser,
  result: {
    limit: number
    billingWorkspaceId: string
    observedPlan: 'free' | 'plus'
  },
): Promise<ToolTextResult> {
  const upgradeRequest = await buildUpgradeRequest({
    db: ctx.db,
    actor: user,
    billingWorkspaceId: result.billingWorkspaceId,
    limitType: 'projects',
    observedPlan: result.observedPlan,
    locale: isSupportedLocale(user.locale) ? user.locale : DEFAULT_LOCALE,
    appBaseUrl: ctx.baseUrl,
  })
  return toolError({
    code: 'project-limit-reached',
    message: `You've reached your plan's project limit (${result.limit} projects). Upgrade your plan or archive existing projects. See /settings/billing for upgrade options.`,
    recoverable_by: 'human',
    hint: 'Archive an existing project or upgrade the workspace plan in billing settings.',
    ...(upgradeRequest && { upgrade_request: upgradeRequest }),
  })
}

function invalidProjectEditInputError(): ToolTextResult {
  return toolError({
    code: 'invalid-name',
    message: 'Project name or audience input is invalid.',
    recoverable_by: 'agent',
    hint: 'Pass a non-empty name and valid audience changes.',
  })
}

function projectNotFoundError(): ToolTextResult {
  return toolError({
    code: 'not-found',
    message: 'No project with that id is in your workspace.',
    recoverable_by: 'agent',
    hint: 'Call list_projects for the project ids you can use.',
  })
}

function projectForbiddenError(): ToolTextResult {
  return toolError({
    code: 'forbidden',
    message: 'You do not have permission to edit that project.',
    recoverable_by: 'human',
    hint: "Only the project's creator or a workspace admin can edit it.",
  })
}

function projectArchivedError(): ToolTextResult {
  return toolError({
    code: 'project-archived',
    message: 'That project is archived, so its settings cannot be changed.',
    recoverable_by: 'agent',
    hint: 'Pass archived: false in the same call to unarchive and edit it together.',
  })
}

function tooManyAudienceError(): ToolTextResult {
  return toolError({
    code: 'too-many-audience',
    message: `A project audience can have at most ${MAX_GRANT_EMAILS} people.`,
    recoverable_by: 'agent',
  })
}

async function projectEditError(
  ctx: McpRequestContext,
  user: McpUser,
  result: Exclude<EditProjectContainerSettingsResult, { kind: 'ok' }>,
): Promise<ToolTextResult> {
  switch (result.kind) {
    case 'not-found':
      return projectNotFoundError()
    case 'forbidden':
      return projectForbiddenError()
    case 'project-archived':
      return projectArchivedError()
    case 'project-limit-reached':
      return await projectLimitReachedError(ctx, user, result)
    case 'too-many-grants':
      return tooManyAudienceError()
    case 'validation-failed':
      return invalidProjectEditInputError()
    case 'bot-grant-rejected':
      return toolError({
        code: result.code,
        message:
          result.code === 'bot-stopped-grant-rejected'
            ? 'This bot has been stopped and cannot receive grants.'
            : 'This grant change is not allowed for a bot.',
        recoverable_by: 'human',
      })
  }
}

// Comments use the viewer's workspace-scoped check, not owner-scoping, so the
// failure case is "you can't view this", not "you don't own this" — keep the
// wording and hint distinct from artifactNotFoundError. Same 'not-found' code:
// a non-existent and a non-visible id are indistinguishable to the caller by
// design (we don't reveal which).
function artifactNotViewableError(): ToolTextResult {
  return toolError({
    code: 'not-found',
    message: 'No artifact with that id is visible to you.',
    recoverable_by: 'agent',
    hint: 'Check the id, or call list_artifacts for the ids you own.',
  })
}

// Map a failed comment write to an agent-facing error. create/reply only ever
// return invalid-body / invalid-thread / closed-thread / commit-failed; the rest
// of the shared union can't arise here but are routed through the generic retry
// so the switch stays exhaustive.
// Exhaustive over the shared post pipeline's failure kinds so a new kind is a
// compile error here, like the CLI route's switch, instead of silently falling
// into a generic bucket.
function postCommentError(
  result: Exclude<PostArtifactCommentResult, { kind: 'ok' }>,
): ToolTextResult {
  switch (result.kind) {
    case 'quote-on-reply':
      return quoteOnReplyError()
    case 'quote-unsupported':
      return quoteUnsupportedError()
    case 'quote-not-found':
      return quoteNotFoundError()
    case 'not-found':
      return artifactNotViewableError()
    default:
      return commentMutationError(result)
  }
}

function commentMutationError(
  result: Exclude<CommentMutationResult, { kind: 'ok' }>,
): ToolTextResult {
  switch (result.kind) {
    case 'invalid-body':
      return toolError({
        code: 'invalid-comment',
        message: `The comment is empty or longer than ${MAX_COMMENT_BODY_LENGTH} characters.`,
        recoverable_by: 'agent',
        hint: 'Post a non-empty comment within the length limit.',
      })
    case 'invalid-thread':
      return toolError({
        code: 'thread-not-found',
        message: 'No comment thread with that id is on this artifact.',
        recoverable_by: 'agent',
        hint: 'Call list_comments for the thread ids, or omit thread_id to start a new thread.',
      })
    case 'closed-thread':
      return toolError({
        code: 'thread-resolved',
        message: 'That comment thread is resolved and does not take replies.',
        recoverable_by: 'agent',
        hint: 'Omit thread_id to start a new thread instead.',
      })
    case 'commit-failed':
    case 'invalid-anchor':
    case 'invalid-message':
    case 'forbidden':
    case 'not-found':
      return commentPostFailedError()
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}

function commentPostFailedError(): ToolTextResult {
  return toolError({
    code: 'comment-failed',
    message: 'Could not post the comment. Try again.',
    recoverable_by: 'agent',
  })
}

function quoteOnReplyError(): ToolTextResult {
  return toolError({
    code: 'quote-on-reply',
    message: 'A quote can only anchor a new comment, not a reply.',
    recoverable_by: 'agent',
    hint: 'Omit reply_to to start a new quoted thread, or omit quote to reply.',
  })
}

function quoteUnsupportedError(): ToolTextResult {
  return toolError({
    code: 'quote-unsupported',
    message: 'This artifact type does not support quoting a text span.',
    recoverable_by: 'agent',
    hint: 'Post without quote to comment on the whole artifact.',
  })
}

function quoteNotFoundError(): ToolTextResult {
  return toolError({
    code: 'quote-not-found',
    message: 'The quoted text was not found in the current artifact.',
    recoverable_by: 'agent',
    hint: 'Copy the exact visible text from get_artifact (markup is not matched), or omit quote to comment on the whole artifact.',
  })
}

// A thread id that doesn't exist or isn't on an artifact the caller can view.
// Same 'not-found' code as the artifact case: non-existent and non-visible are
// indistinguishable to the caller by design.
function threadNotFoundError(): ToolTextResult {
  return toolError({
    code: 'not-found',
    message: 'No comment thread with that id is visible to you.',
    recoverable_by: 'agent',
    hint: 'Call list_comments for the thread ids.',
  })
}

function commentActionError(
  result: Exclude<CommentMutationResult, { kind: 'ok' }>,
): ToolTextResult {
  switch (result.kind) {
    case 'invalid-body':
      return toolError({
        code: 'invalid-comment',
        message: `The comment is empty or longer than ${MAX_COMMENT_BODY_LENGTH} characters.`,
        recoverable_by: 'agent',
        hint: 'Edit it to a non-empty comment within the length limit.',
      })
    case 'invalid-message':
      return toolError({
        code: 'message-not-found',
        message: 'No comment message with that id is on this artifact.',
        recoverable_by: 'agent',
        hint: 'Call list_comments for the message ids.',
      })
    case 'invalid-thread':
      return toolError({
        code: 'thread-not-found',
        message: 'No comment thread with that id is on this artifact.',
        recoverable_by: 'agent',
        hint: 'Call list_comments for the thread ids.',
      })
    case 'closed-thread':
      return toolError({
        code: 'thread-resolved',
        message: 'That comment thread is resolved.',
        recoverable_by: 'agent',
        hint: 'Reopen it with reopen_comment first.',
      })
    case 'forbidden':
      return toolError({
        code: 'forbidden',
        message: 'You do not have permission to change that comment.',
        recoverable_by: 'human',
        hint: 'You can edit only your own comments; resolving or deleting a thread needs to be the thread author, the artifact owner, or a workspace admin.',
      })
    case 'not-found':
      return threadNotFoundError()
    case 'invalid-anchor':
    case 'commit-failed':
      return commentActionFailedError()
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}

function commentActionFailedError(): ToolTextResult {
  return toolError({
    code: 'comment-action-failed',
    message: 'Could not change the comment. Try again.',
    recoverable_by: 'agent',
  })
}

function unreadableKindError(artifactKind: string): ToolTextResult {
  return toolError({
    code: 'unsupported-kind',
    message: `This artifact is a ${artifactKind}, a multi-file site, so its source cannot be read as a single text. Open the share link to view it.`,
    recoverable_by: 'human',
  })
}

function sourceUnavailableError(): ToolTextResult {
  return toolError({
    code: 'source-unavailable',
    message: 'The artifact source is not available right now. Try again.',
    recoverable_by: 'agent',
  })
}

function permissionError(
  permission: Exclude<UploadPermissionResult, { kind: 'allowed' }>,
): ToolTextResult {
  switch (permission.kind) {
    case 'self-upload-disabled':
      return toolError({
        code: 'self-upload-disabled',
        message:
          'This account can view and comment, but cannot publish its own files.',
        recoverable_by: 'human',
        hint: 'Sign in with Google or Microsoft on the Artifact Share website to create an upload-enabled workspace.',
      })
    case 'not-allowed':
      return toolError({
        code: 'upload-not-enabled',
        message: 'Publishing is paused right now.',
        recoverable_by: 'human',
        hint: 'Artifact Share has paused publishing; contact Artifact Share support if you need it enabled.',
      })
    case 'missing-flagship-binding':
      return toolError({
        code: 'upload-unavailable',
        message: 'Publishing is temporarily unavailable.',
        recoverable_by: 'human',
        hint: 'This is a server configuration issue; contact the operator.',
      })
    case 'flagship-error':
      return toolError({
        code: 'upload-check-failed',
        message: 'Could not verify publishing permission. Try again.',
        recoverable_by: 'agent',
      })
  }
}

async function uploadError(
  ctx: McpRequestContext,
  user: McpUser,
  result: Exclude<UploadShareableResult, { kind: 'ok' }>,
  containerId: string | null,
): Promise<ToolTextResult> {
  switch (result.kind) {
    case 'unsupported-type':
      return toolError({
        code: 'unsupported-type',
        message: 'Only HTML and Markdown can be shared.',
        recoverable_by: 'agent',
        hint: 'Pass HTML or Markdown content (set format to "html" or "markdown").',
      })
    case 'too-large':
      return toolError({
        code: 'too-large',
        message: 'The artifact is larger than 25 MB.',
        recoverable_by: 'agent',
        hint: `Reduce embedded images or split the content, or share large or multi-file artifacts from an AI agent with: npx --yes @artifactshare/cli share <path>. Setup guide: ${CONNECT_AI_AGENTS_URL}`,
      })
    case 'invalid-path':
      return toolError({
        code: 'invalid-path',
        message: 'The content could not be packaged for sharing. Try again.',
        recoverable_by: 'agent',
      })
    case 'workspace-unavailable':
      return toolError({
        code: 'workspace-scope-unavailable',
        message:
          'This is a personal Google account, so it cannot share with a whole company.',
        recoverable_by: 'agent',
        hint: 'Ask who should see it and pass their emails as grant_emails; visibility stays "private".',
      })
    case 'bot-artifact-grant-unsupported':
      return toolError({
        code: 'bot-artifact-grant-unsupported',
        message:
          'Artifact-level grants to bot email addresses are not supported.',
        recoverable_by: 'agent',
        hint: "Remove the bot email from grant_emails and share the bot's project audience instead of the single artifact.",
      })
    case 'link-sharing-plan-required':
      return toolError({
        code: 'link-sharing-plan-required',
        message: 'Link sharing requires a Plus or Team plan.',
        recoverable_by: 'human',
      })
    case 'link-sharing-disabled':
      return toolError({
        code: 'link-sharing-disabled',
        message: 'Link sharing is disabled for this workspace.',
        recoverable_by: 'human',
      })
    case 'link-expiry-invalid':
      return toolError({
        code: 'link-expiry-invalid',
        message: 'The link expiry is invalid for this workspace policy.',
        recoverable_by: 'agent',
        hint: 'Pass a future RFC3339 UTC timestamp within the workspace maximum, or null only when unlimited expiry is allowed.',
      })
    case 'too-many-grants':
      return toolError({
        code: 'too-many-grants',
        message: `Share with at most ${result.limit} email addresses.`,
        recoverable_by: 'agent',
      })
    case 'workspace-access-revoked':
      return toolError({
        code: 'workspace-access-revoked',
        message: 'Your access to this workspace has been revoked.',
        recoverable_by: 'human',
        hint: 'Ask a workspace admin to restore your workspace membership.',
      })
    case 'contributor-limit-exceeded':
      return toolError({
        code: 'contributor-limit',
        message:
          'This workspace cannot add more contributors. Contact the Artifact Share team.',
        recoverable_by: 'human',
        hint: 'Contact the Artifact Share team for help.',
      })
    case 'quota-exceeded':
      const destination = containerId
        ? await ctx.db
            .selectFrom('artifact_containers')
            .innerJoin(
              'workspaces',
              'workspaces.id',
              'artifact_containers.workspace_id',
            )
            .select([
              'artifact_containers.workspace_id as workspace_id',
              'workspaces.plan as plan',
            ])
            .where('artifact_containers.id', '=', containerId)
            .executeTakeFirst()
        : { workspace_id: user.workspaceId, plan: user.plan }
      const billingWorkspaceId = destination?.workspace_id
      const upgradeRequest =
        billingWorkspaceId && destination?.plan === 'free'
          ? await buildUpgradeRequest({
              db: ctx.db,
              actor: user,
              billingWorkspaceId,
              limitType: 'storage',
              observedPlan: 'free',
              locale: isSupportedLocale(user.locale)
                ? user.locale
                : DEFAULT_LOCALE,
              appBaseUrl: ctx.baseUrl,
            })
          : null
      return toolError({
        code: 'quota-exceeded',
        message: 'The workspace is out of storage.',
        recoverable_by: 'human',
        hint: 'Ask a workspace admin to free space or raise the plan.',
        ...(upgradeRequest && { upgrade_request: upgradeRequest }),
      })
    case 'invalid-container':
      return invalidDestinationError()
    // MCP publishes never pass a stable key; kept for exhaustiveness.
    case 'key-conflict':
      return toolError({
        code: 'storage-failed',
        message: 'Could not save the artifact. Try again.',
        recoverable_by: 'agent',
      })
    case 'storage-failed':
      return toolError({
        code: 'storage-failed',
        message: 'Could not save the artifact. Try again.',
        recoverable_by: 'agent',
      })
    case 'id-exhausted':
      return toolError({
        code: 'id-exhausted',
        message: 'Could not allocate a share link. Try again.',
        recoverable_by: 'agent',
      })
  }
  return toolError({
    code: 'storage-failed',
    message: 'Could not save the new version. Try again.',
    recoverable_by: 'agent',
  })
}

function versionError(
  result: Exclude<CreateVersionResult, { kind: 'ok' }>,
): ToolTextResult {
  switch (result.kind) {
    case 'not-found':
      return artifactNotFoundError()
    case 'copy-forbidden':
      return toolError({
        code: 'update-unsupported',
        message:
          'This artifact is a multi-file site and cannot be updated this way.',
        recoverable_by: 'human',
      })
    case 'too-large':
      return toolError({
        code: 'too-large',
        message: 'The new version is larger than 25 MB.',
        recoverable_by: 'agent',
        hint: `Reduce embedded images or split the content, or update large or multi-file artifacts from an AI agent with: npx --yes @artifactshare/cli update <share-url> <path>. Setup guide: ${CONNECT_AI_AGENTS_URL}`,
      })
    case 'unsupported-type':
      return toolError({
        code: 'unsupported-type',
        message: 'Only HTML and Markdown can be shared.',
        recoverable_by: 'agent',
      })
    case 'invalid-path':
      return toolError({
        code: 'invalid-path',
        message: 'The content could not be packaged. Try again.',
        recoverable_by: 'agent',
      })
    case 'workspace-access-revoked':
      return toolError({
        code: 'workspace-access-revoked',
        message: 'Your access to this workspace has been revoked.',
        recoverable_by: 'human',
        hint: 'Ask a workspace admin to restore your workspace membership.',
      })
    case 'quota-exceeded':
      return toolError({
        code: 'quota-exceeded',
        message: 'The workspace is out of storage.',
        recoverable_by: 'human',
      })
    case 'invalid-container':
      return invalidDestinationError()
    case 'storage-failed':
      return toolError({
        code: 'storage-failed',
        message: 'Could not save the new version. Try again.',
        recoverable_by: 'agent',
      })
  }
  return toolError({
    code: 'storage-failed',
    message: 'Could not save the new version. Try again.',
    recoverable_by: 'agent',
  })
}

// ── idempotency ──────────────────────────────────────────────────

// Canonical key for idempotent-resend detection: every input that defines the
// resulting artifact. Grant emails are sorted so recipient order can't split a
// resend into two artifacts. Serialize as JSON, not a delimiter-joined string —
// content and titles carry arbitrary newlines, so a `\n` join would let two
// different requests collide onto the same key and wrongly dedup.
export function publishContentHash(args: {
  format: Format
  visibility: Visibility
  grantEmails: string[]
  title: string | undefined
  content: string
  containerId: string | null
  linkExpiresAt?: string | null
}): Promise<string> {
  const canonical = JSON.stringify([
    args.format,
    args.visibility,
    args.grantEmails.toSorted(),
    args.title ?? '',
    args.content,
    args.containerId ?? '',
    args.linkExpiresAt === undefined
      ? '<workspace-default>'
      : args.linkExpiresAt === null
        ? '<unlimited>'
        : args.linkExpiresAt,
  ])
  return computeTextSha256(canonical)
}

export function uploadOptionsForSlackNotify(slackNotify: boolean | undefined) {
  return slackNotify === false ? { slackNotify: false } : {}
}

// Re-describe an existing artifact in the same shape as a fresh publish, for an
// idempotent resend. `fallbackVisibility` (the request's resolved scope, which
// the content hash pinned) keeps the output-schema enum valid if the read misses.
async function existingArtifactResult(
  ctx: McpRequestContext,
  user: McpUser,
  shareableId: string,
  fallbackVisibility: Visibility,
): Promise<ToolTextResult> {
  let summary: OwnedShareableSummary | null = null
  try {
    summary = await getOwnedShareableSummary(ctx.db, user, shareableId)
  } catch (err) {
    console.error('mcp_idempotency_summary_failed', {
      shareable_id: shareableId,
      err,
    })
  }
  const visibility = summary?.visibility ?? fallbackVisibility
  return jsonResult({
    id: shareableId,
    share_url: shareUrl(ctx.baseUrl, shareableId),
    title: summary?.title ?? null,
    visibility,
    link_expires_at: summary?.linkExpiresAt ?? null,
    visibility_label: scopeLabel(visibility, user.locale),
  })
}

// ── pure helpers (unit-tested) ───────────────────────────────────

// Human-readable share-scope label, in the user's locale. Routes through the
// i18n catalog (the same keys the viewer chrome uses) so the wording can't
// drift from the UI. Unknown / null locales fall back to DEFAULT_LOCALE.
//
// `visibility` is typed Visibility, but the column has no CHECK constraint, so a
// legacy / future value could fall outside the catalog. Guard against it so one
// odd row can't crash the whole listing (an unknown key would make t()
// dereference undefined); fall back to the raw value.
export function scopeLabel(visibility: string, locale: string | null): string {
  const lang: Locale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE
  return isVisibility(visibility)
    ? t(lang, shortVisibilityLabelKey(visibility))
    : visibility
}

// A project's sharing-scope label, in the caller's locale — the same wording the
// project page's scope chip uses ('workspace' = 社内全員, 'private' = 関係者のみ),
// routed through the i18n catalog so MCP and UI can't drift. base_visibility is a
// closed union, so unlike scopeLabel this needs no unknown-value fallback.
export function projectScopeLabel(
  baseVisibility: ProjectBaseVisibility,
  locale: string | null,
): string {
  const lang: Locale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE
  return t(
    lang,
    baseVisibility === 'private'
      ? 'project.shareScope.private'
      : 'project.shareScope.workspace',
  )
}

// Tools take a string; `detectArtifactTypeForUpload` keys off file.type /
// file.name, so the inferred format decides both. A fixed ASCII filename keeps
// `validateBundlePath` happy regardless of the title (the title is applied
// separately via title_override / derived from the content).
export function buildArtifactFile(content: string, format: Format): File {
  const ext = format === 'html' ? 'html' : 'md'
  const type =
    format === 'html'
      ? 'text/html; charset=utf-8'
      : 'text/markdown; charset=utf-8'
  return new File([content], `artifact.${ext}`, { type })
}

const FORMAT_SNIFF_WINDOW = 4096

// Markdown legitimately embeds raw HTML (`<img>`, `<table>`, `<a>` …), so a
// stray tag must NOT flip it to HTML — the markdown renderer would then show the
// surrounding `#`/`**` syntax literally. Only treat content as HTML on a
// document-level or executable signal that markdown wouldn't carry. When in
// doubt, markdown: its renderer passes raw HTML through, so the reverse mistake
// is the cheaper one. Agents can always set `format` explicitly.
export function inferFormat(content: string, explicit?: Format): Format {
  if (explicit) return explicit
  const head = content.trimStart().slice(0, FORMAT_SNIFF_WINDOW).toLowerCase()
  if (
    /^<!doctype html/.test(head) ||
    /<(?:html|head|body|script|style)\b/.test(head)
  ) {
    return 'html'
  }
  return 'markdown'
}

function shareUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/$/, '')}/a/${id}`
}
