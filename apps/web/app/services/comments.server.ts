import { env } from 'cloudflare:workers'
import { nanoid } from 'nanoid'
import type { Compilable, Kysely } from 'kysely'
import { sql } from 'kysely'
import { nowIso } from '~/lib/datetime'
import { runD1Batch } from '~/lib/d1-batch.server'
import {
  MAX_COMMENT_BODY_LENGTH,
  type CommentAuthor,
  type CommentMessageView,
  type CommentThreadStatus,
  type CommentThreadSubject,
  type CommentThreadView,
} from '~/lib/comments'
import type { Visibility } from '~/lib/shareable-types'
import type { SessionUser } from '~/lib/user'
import {
  isTeamWorkspaceAdmin,
  viewerDisplayCheck,
  type ArtifactSnapshot,
} from '~/services/access.server'
import { isWorkspaceAccessRevoked } from '~/modules/access'
import { commentPostedEventQuery } from './events.server'
import type { DB } from '~/types/db'
import type { AgentReadAuthorization } from './agent-scope.server'
import {
  COMMENT_THREAD_LIST_LIMIT,
  commentThreadWindowExpression,
} from './comment-thread-window.server'

export { COMMENT_THREAD_LIST_LIMIT } from './comment-thread-window.server'
export const MAX_QUOTED_TEXT_LENGTH = 1000
export const MAX_CONTEXT_TEXT_LENGTH = 400

export async function latestOtherCommentCreatedAt(
  db: Kysely<DB>,
  shareableId: string,
  viewerUserId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('comment_messages')
    .innerJoin(
      'comment_threads',
      'comment_threads.id',
      'comment_messages.thread_id',
    )
    .select((eb) =>
      eb.fn.max<string | null>('comment_messages.created_at').as('created_at'),
    )
    .where('comment_threads.shareable_id', '=', shareableId)
    .where('comment_messages.created_by_id', '<>', viewerUserId)
    .executeTakeFirst()
  return row?.created_at ?? null
}
const MAX_CSS_PATH_LENGTH = 1000
type ArtifactLiveBinding = {
  getByName(name: string): {
    notifyCommentsChanged(
      originMutationId?: string,
      originUserId?: string,
    ): Promise<void>
  }
}

export interface CommentMutationOptions {
  agentProfileId?: string | null
  agentReadAuthorization?: AgentReadAuthorization
  live?: ArtifactLiveBinding
  originMutationId?: string
  originUserId?: string
  waitUntil?: (promise: Promise<unknown>) => void
}

export interface CommentAnchorInput {
  selectorFormat?: 'normalized-v1' | 'quote-v1'
  textHash?: string | null
  ambiguousAtCreation?: boolean
  versionId?: string | null
  quotedText: string
  prefixText: string
  suffixText: string
  textStart: number | null
  textEnd: number | null
  cssPath: string | null
}

// Agent selectors are measured only when a viewer opens the artifact.
export interface QuoteAnchorInput {
  quote: string
  before?: string
  after?: string
}

export type BuildQuoteAnchorResult =
  | { kind: 'ok'; anchor: CommentAnchorInput }
  // The artifact kind has no single anchorable text (a multi-file bundle).
  | { kind: 'unsupported' }
  | { kind: 'invalid' }

export interface CommentAccess {
  shareableId: string
  workspaceId: string
  ownerUserId: string
  visibility: Visibility
  linkExpiresAt: string | null
  currentVersionId: string | null
  artifactKind: string
  entrypointPath: string | null
  r2Key: string | null
  // Owner-only comment moderation requires live access to the artifact's
  // workspace. A separate viewer grant must not inherit owner authority.
  isOwner: boolean
  isTeamWorkspaceAdmin: boolean
  // Only loadCommentAccess derives placement; other constructors leave it out.
  projectId?: string | null
}

export interface VerifiedCommentShareable {
  id: string
  workspaceId: string
  ownerUserId: string
  visibility: Visibility
  linkExpiresAt?: string | null
  currentVersionId: string | null
  artifactKind: string
  entrypointPath: string | null
  r2Key: string | null
}

export type CommentMutationResult =
  | { kind: 'ok'; threads: CommentThreadView[] }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'invalid-body' }
  | { kind: 'invalid-anchor' }
  | { kind: 'invalid-thread' }
  | { kind: 'invalid-message' }
  | { kind: 'closed-thread' }
  | { kind: 'commit-failed' }

// createCommentThread additionally reports the id of the thread it created, so a
// caller can point at the new thread without re-deriving it from `threads` (its
// position there isn't contractual). Additive over the shared ok variant; other
// callers ignore it.
export type CreateCommentThreadResult =
  | { kind: 'ok'; threadId: string; threads: CommentThreadView[] }
  | { kind: 'version-conflict' }
  | Exclude<CommentMutationResult, { kind: 'ok' }>

export type ChangeCommentInput =
  | {
      kind: 'update'
      messageId: string
      body: string
      threadId?: string
      resolved?: boolean
    }
  | {
      kind: 'update'
      threadId: string
      resolved: boolean
      messageId?: never
      body?: never
    }
  | { kind: 'delete'; messageId: string; threadId?: string }
  | { kind: 'delete'; threadId: string; messageId?: undefined }

export type ChangeCommentResult =
  | {
      kind: 'ok'
      threadId: string
      thread: CommentThreadView
      threads: CommentThreadView[]
    }
  | {
      kind: 'ok'
      threadId: string
      deleted: true
      threadDeleted: boolean
      thread?: CommentThreadView
      threads: CommentThreadView[]
    }
  | Exclude<CommentMutationResult, { kind: 'ok' }>

type CommentMutationStepResult =
  | { kind: 'ok' }
  | Exclude<CommentMutationResult, { kind: 'ok' }>

// Resolve comment access from a thread id, so tools that act on a thread (the
// MCP update_comment / delete_comment) don't need the artifact id. Returns null
// when the thread doesn't exist or the user can't view its artifact — the two
// are indistinguishable to the caller by design.
export async function loadCommentAccessForThread(
  db: Kysely<DB>,
  user: SessionUser,
  threadId: string,
): Promise<CommentAccess | null> {
  const row = await db
    .selectFrom('comment_threads')
    .select('shareable_id')
    .where('id', '=', threadId)
    .executeTakeFirst()
  if (!row) return null
  return loadCommentAccess(db, user, row.shareable_id)
}

// The shareable fields loadShareableViewAccess resolves once the viewer's
// display access is verified. Callers that need feature-specific access shapes
// (comments, viewer list) derive them from this.
export interface ShareableViewAccess {
  id: string
  workspaceId: string
  ownerUserId: string
  visibility: Visibility
  linkExpiresAt: string | null
  currentVersionId: string | null
  artifactKind: string
  entrypointPath: string | null
  r2Key: string
  containerId: string | null
  projectContainerKind: string | null
}

// Shareable lookup + viewerDisplayCheck + r2_key existence. Returns null when
// the shareable doesn't exist, has no stored source, or the user can't view it
// — the three are indistinguishable to the caller by design.
export async function loadShareableViewAccess(
  db: Kysely<DB>,
  user: SessionUser,
  shareableId: string,
  agentReadAuthorization?: AgentReadAuthorization,
): Promise<ShareableViewAccess | null> {
  const shareable = await db
    .selectFrom('shareables')
    .leftJoin('versions', 'versions.id', 'shareables.current_version_id')
    .leftJoin(
      'artifact_containers as project_container',
      'project_container.id',
      'shareables.container_id',
    )
    .select([
      'shareables.id',
      'shareables.workspace_id',
      'shareables.owner_user_id',
      'shareables.name',
      'shareables.visibility',
      'shareables.link_expires_at',
      'shareables.artifact_kind',
      'shareables.container_id',
      'shareables.current_version_id',
      'project_container.kind as project_container_kind',
      'project_container.base_visibility as project_container_base_visibility',
      'versions.r2_key',
      'versions.artifact_kind as version_artifact_kind',
      'versions.entrypoint_path',
    ])
    .where('shareables.id', '=', shareableId)
    .executeTakeFirst()
  if (!shareable?.r2_key) return null
  const r2Key = shareable.r2_key

  const snapshot: ArtifactSnapshot = {
    id: r2Key,
    name: shareable.name,
    mimeType:
      (shareable.version_artifact_kind ?? shareable.artifact_kind) ===
      'markdown_page'
        ? 'text/markdown'
        : 'text/html',
    modifiedTime: null,
    ownerEmail: null,
  }
  const authorizedByAgent =
    agentReadAuthorization?.kind === 'agent-read' &&
    agentReadAuthorization.artifactId === shareable.id &&
    agentReadAuthorization.viewerUserId === user.id &&
    agentReadAuthorization.viewerWorkspaceId === shareable.workspace_id
  if (!authorizedByAgent) {
    const check = await viewerDisplayCheck(
      db,
      shareable.visibility,
      user.id,
      snapshot,
      {
        shareableId: shareable.id,
        ownerUserId: shareable.owner_user_id,
        artifactWorkspaceId: shareable.workspace_id,
        viewerWorkspaceId: user.workspaceId,
        viewerEmail: user.email,
        viewerEmailVerified: user.emailVerified,
        containerId: shareable.container_id,
        containerKind: shareable.project_container_kind,
        containerBaseVisibility: shareable.project_container_base_visibility,
      },
    )
    if (check.kind !== 'access-granted') return null
  }

  return {
    id: shareable.id,
    workspaceId: shareable.workspace_id,
    ownerUserId: shareable.owner_user_id,
    visibility: shareable.visibility,
    linkExpiresAt: shareable.link_expires_at,
    currentVersionId: shareable.current_version_id,
    artifactKind: shareable.version_artifact_kind ?? shareable.artifact_kind,
    entrypointPath: shareable.entrypoint_path,
    r2Key,
    containerId: shareable.container_id,
    projectContainerKind: shareable.project_container_kind,
  }
}

export async function loadCommentAccess(
  db: Kysely<DB>,
  user: SessionUser,
  shareableId: string,
  agentReadAuthorization?: AgentReadAuthorization,
): Promise<CommentAccess | null> {
  const shareable = await loadShareableViewAccess(
    db,
    user,
    shareableId,
    agentReadAuthorization,
  )
  if (!shareable) return null

  const authorizationUser = agentReadAuthorization
    ? { ...user, workspaceId: agentReadAuthorization.viewerWorkspaceId }
    : user
  const access = await commentAccessFromVerifiedShareable(
    db,
    authorizationUser,
    {
      id: shareable.id,
      workspaceId: shareable.workspaceId,
      ownerUserId: shareable.ownerUserId,
      visibility: shareable.visibility,
      linkExpiresAt: shareable.linkExpiresAt,
      currentVersionId: shareable.currentVersionId,
      artifactKind: shareable.artifactKind,
      entrypointPath: shareable.entrypointPath,
      r2Key: shareable.r2Key,
    },
  )
  return {
    ...access,
    projectId:
      shareable.projectContainerKind === 'project'
        ? shareable.containerId
        : null,
  }
}

export async function commentAccessFromVerifiedShareable(
  db: Kysely<DB>,
  user: SessionUser,
  shareable: VerifiedCommentShareable,
): Promise<CommentAccess> {
  return {
    shareableId: shareable.id,
    workspaceId: shareable.workspaceId,
    ownerUserId: shareable.ownerUserId,
    visibility: shareable.visibility,
    linkExpiresAt: shareable.linkExpiresAt ?? null,
    currentVersionId: shareable.currentVersionId,
    artifactKind: shareable.artifactKind,
    entrypointPath: shareable.entrypointPath,
    r2Key: shareable.r2Key,
    isOwner:
      shareable.ownerUserId === user.id &&
      !(await isWorkspaceAccessRevoked(db, shareable.workspaceId, user.id)),
    isTeamWorkspaceAdmin: await isTeamWorkspaceAdmin(
      db,
      user,
      shareable.workspaceId,
    ),
  }
}

export async function loadCommentThreads(
  db: Kysely<DB>,
  access: CommentAccess,
  user: Pick<SessionUser, 'id'>,
): Promise<CommentThreadView[]> {
  const rows = await loadCommentThreadRows(db, access.shareableId)
  return await loadCommentThreadViews(db, access, user, rows)
}

function loadCommentThreadRows(
  db: Kysely<DB>,
  shareableId: string,
): Promise<CommentThreadRow[]> {
  return db
    .selectFrom('comment_threads')
    .select([
      'id',
      'status',
      'created_by_id',
      'resolved_at',
      'created_at',
      'updated_at',
    ])
    .where('shareable_id', '=', shareableId)
    .where(
      commentThreadWindowExpression(sql.val(shareableId), 'comment_threads'),
    )
    .orderBy(sql<boolean>`(status = 'open')`, 'desc')
    .orderBy('updated_at', 'desc')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'asc')
    .limit(COMMENT_THREAD_LIST_LIMIT)
    .execute()
}

type CommentThreadRow = {
  id: string
  status: CommentThreadStatus
  created_by_id: string
  resolved_at: string | null
  created_at: string
  updated_at: string
}

export async function loadCommentThread(
  db: Kysely<DB>,
  access: CommentAccess,
  user: Pick<SessionUser, 'id'>,
  threadId: string,
): Promise<CommentThreadView | null> {
  const row = await db
    .selectFrom('comment_threads')
    .select([
      'id',
      'status',
      'created_by_id',
      'resolved_at',
      'created_at',
      'updated_at',
    ])
    .where('shareable_id', '=', access.shareableId)
    .where('id', '=', threadId)
    .executeTakeFirst()
  if (!row) return null
  const threads = await loadCommentThreadViews(db, access, user, [row])
  return threads[0] ?? null
}

async function loadCommentThreadViews(
  db: Kysely<DB>,
  access: CommentAccess,
  user: Pick<SessionUser, 'id'>,
  rows: CommentThreadRow[],
): Promise<CommentThreadView[]> {
  if (rows.length === 0) return []

  const threadIds = rows.map((row) => row.id)
  const [messages, anchors] = await Promise.all([
    db
      .selectFrom('comment_messages')
      .innerJoin('users', 'users.id', 'comment_messages.created_by_id')
      .select([
        'comment_messages.id',
        'comment_messages.thread_id',
        'comment_messages.body',
        'comment_messages.agent',
        'comment_messages.created_at',
        'comment_messages.updated_at',
        'users.id as author_id',
        'users.email as author_email',
        'users.name as author_name',
        'users.image as author_image',
        'users.kind as author_kind',
      ])
      .where('comment_messages.thread_id', 'in', threadIds)
      .orderBy('comment_messages.created_at', 'asc')
      .orderBy('comment_messages.id', 'asc')
      .execute(),
    db
      .selectFrom('comment_anchors')
      .select([
        'id',
        'selector_format',
        'text_hash',
        'ambiguous_at_creation',
        'thread_id',
        'version_id',
        'target_path',
        'quoted_text',
        'prefix_text',
        'suffix_text',
        'text_start',
        'text_end',
        'css_path',
      ])
      .where('thread_id', 'in', threadIds)
      .execute(),
  ])

  const messagesByThread = new Map<string, CommentMessageView[]>()
  for (const message of messages) {
    const list = messagesByThread.get(message.thread_id) ?? []
    list.push({
      id: message.id,
      body: message.body,
      agent: message.agent,
      createdAt: message.created_at,
      updatedAt: message.updated_at,
      author: {
        id: message.author_id,
        email: message.author_email,
        name: message.author_name,
        image: message.author_image,
        kind: message.author_kind,
      },
      canEdit: message.author_id === user.id,
      canDelete:
        message.author_id === user.id ||
        access.isOwner ||
        access.isTeamWorkspaceAdmin,
    })
    messagesByThread.set(message.thread_id, list)
  }

  const subjectsByThread = await resolveCommentSubjects(db, access, anchors)

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    subject: subjectsByThread.get(row.id) ?? { kind: 'artifact' },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    canResolve: canResolveCommentThread(access, user.id, row.created_by_id),
    messages: messagesByThread.get(row.id) ?? [],
  }))
}

export async function createCommentThread(
  db: Kysely<DB>,
  access: CommentAccess,
  user: SessionUser,
  rawBody: string,
  rawAnchor?: CommentAnchorInput | null,
  options?: CommentMutationOptions,
  agent?: string | null,
): Promise<CreateCommentThreadResult> {
  const body = normalizeCommentBody(rawBody)
  if (!body) return { kind: 'invalid-body' }
  const anchor = rawAnchor ? normalizeCommentAnchor(access, rawAnchor) : null
  if (rawAnchor && !anchor) return { kind: 'invalid-anchor' }
  if (
    anchor?.selectorFormat === 'normalized-v1' &&
    anchor.versionId !== access.currentVersionId
  ) {
    return { kind: 'version-conflict' }
  }

  const now = nowIso()
  const threadId = nanoid()
  const messageId = nanoid()
  const queries: Compilable<unknown>[] = [
    db.insertInto('comment_threads').values({
      id: threadId,
      shareable_id: anchor
        ? sql<string>`(SELECT id FROM shareables WHERE id = ${access.shareableId} AND current_version_id = ${access.currentVersionId})`
        : access.shareableId,
      status: 'open',
      created_by_id: user.id,
      resolved_by_id: null,
      resolved_at: null,
      created_at: now,
      updated_at: now,
    }),
    db.insertInto('comment_messages').values({
      id: messageId,
      thread_id: threadId,
      body,
      agent: agent || null,
      created_by_id: user.id,
      created_by_agent_profile_id: options?.agentProfileId ?? null,
      created_at: now,
      updated_at: now,
    }),
    commentPostedEventQuery(db, {
      messageId,
      shareableId: access.shareableId,
      actorUserId: user.id,
      createdAt: now,
    }),
  ]
  if (anchor) {
    queries.push(
      db.insertInto('comment_anchors').values({
        id: nanoid(),
        thread_id: threadId,
        version_id: access.currentVersionId,
        target_path: anchor.targetPath,
        quoted_text: anchor.quotedText,
        prefix_text: anchor.prefixText,
        suffix_text: anchor.suffixText,
        text_start: anchor.textStart ?? 0,
        text_end: anchor.textEnd ?? 0,
        selector_format: anchor.selectorFormat ?? null,
        text_hash: anchor.textHash ?? null,
        ambiguous_at_creation:
          anchor.selectorFormat === 'normalized-v1'
            ? Number(anchor.ambiguousAtCreation)
            : null,
        css_path: anchor.cssPath,
        created_at: now,
      }),
    )
  }
  try {
    await runD1Batch(db, ...queries)
  } catch {
    if (anchor) {
      const current = await db
        .selectFrom('shareables')
        .select('current_version_id')
        .where('id', '=', access.shareableId)
        .executeTakeFirst()
      if (current?.current_version_id !== access.currentVersionId)
        return { kind: 'version-conflict' }
    }
    return { kind: 'commit-failed' }
  }

  await scheduleCommentThreadsChanged(access.shareableId, options)
  return {
    kind: 'ok',
    threadId,
    threads: await loadCommentThreads(db, access, user),
  }
}

export async function replyToCommentThread(
  db: Kysely<DB>,
  access: CommentAccess,
  user: SessionUser,
  threadId: string,
  rawBody: string,
  options?: CommentMutationOptions,
  agent?: string | null,
): Promise<CommentMutationResult> {
  const body = normalizeCommentBody(rawBody)
  if (!body) return { kind: 'invalid-body' }

  const thread = await loadThread(db, access.shareableId, threadId)
  if (!thread) return { kind: 'invalid-thread' }
  if (thread.status === 'resolved') return { kind: 'closed-thread' }

  const now = nowIso()
  const messageId = nanoid()
  try {
    await runD1Batch(
      db,
      db.insertInto('comment_messages').values({
        id: messageId,
        thread_id: threadId,
        body,
        agent: agent || null,
        created_by_id: user.id,
        created_by_agent_profile_id: options?.agentProfileId ?? null,
        created_at: now,
        updated_at: now,
      }),
      db
        .updateTable('comment_threads')
        .set({ updated_at: now })
        .where('id', '=', threadId)
        .where('shareable_id', '=', access.shareableId),
      commentPostedEventQuery(db, {
        messageId,
        shareableId: access.shareableId,
        actorUserId: user.id,
        createdAt: now,
      }),
    )
  } catch {
    return { kind: 'commit-failed' }
  }

  await scheduleCommentThreadsChanged(access.shareableId, options)
  return { kind: 'ok', threads: await loadCommentThreads(db, access, user) }
}

export async function setCommentThreadResolved(
  db: Kysely<DB>,
  access: CommentAccess,
  user: SessionUser,
  threadId: string,
  resolved: boolean,
  options?: CommentMutationOptions,
): Promise<CommentMutationResult> {
  const thread = await loadThread(db, access.shareableId, threadId)
  if (!thread) return { kind: 'invalid-thread' }
  const result = await mutateLoadedCommentThreadResolved(
    db,
    access,
    user,
    thread,
    resolved,
    options,
  )
  if (result.kind !== 'ok') return result

  return { kind: 'ok', threads: await loadCommentThreads(db, access, user) }
}

export async function updateCommentMessage(
  db: Kysely<DB>,
  access: CommentAccess,
  user: SessionUser,
  messageId: string,
  rawBody: string,
  options?: CommentMutationOptions,
): Promise<CommentMutationResult> {
  const body = normalizeCommentBody(rawBody)
  if (!body) return { kind: 'invalid-body' }

  const message = await loadMessage(db, access.shareableId, messageId)
  if (!message) return { kind: 'invalid-message' }
  const result = await mutateLoadedCommentMessage(
    db,
    access,
    user,
    message,
    body,
    options,
  )
  if (result.kind !== 'ok') return result

  return { kind: 'ok', threads: await loadCommentThreads(db, access, user) }
}

export async function deleteCommentMessage(
  db: Kysely<DB>,
  access: CommentAccess,
  user: SessionUser,
  messageId: string,
  expectedThreadId?: string,
  options?: CommentMutationOptions,
): Promise<CommentMutationResult> {
  const message = await loadMessage(db, access.shareableId, messageId)
  if (!message) return { kind: 'invalid-message' }
  const result = await mutateLoadedCommentMessageDelete(
    db,
    access,
    user,
    message,
    expectedThreadId,
    options,
  )
  if (result.kind !== 'ok') return result

  return { kind: 'ok', threads: await loadCommentThreads(db, access, user) }
}

async function mutateLoadedCommentThreadResolved(
  db: Kysely<DB>,
  access: CommentAccess,
  user: SessionUser,
  thread: LoadedCommentThread,
  resolved: boolean,
  options?: CommentMutationOptions,
): Promise<CommentMutationStepResult> {
  const isOwner = await liveOwnerAccess(db, access, user.id)
  if (
    !isOwner &&
    !access.isTeamWorkspaceAdmin &&
    thread.created_by_id !== user.id
  ) {
    return { kind: 'forbidden' }
  }

  const now = nowIso()
  await db
    .updateTable('comment_threads')
    .set({
      status: resolved ? 'resolved' : 'open',
      resolved_by_id: resolved ? user.id : null,
      resolved_at: resolved ? now : null,
      updated_at: now,
    })
    .where('id', '=', thread.id)
    .where('shareable_id', '=', access.shareableId)
    .execute()

  await scheduleCommentThreadsChanged(access.shareableId, options)
  return { kind: 'ok' }
}

async function mutateLoadedCommentMessage(
  db: Kysely<DB>,
  access: CommentAccess,
  user: SessionUser,
  message: LoadedCommentMessage,
  body: string,
  options?: CommentMutationOptions,
): Promise<CommentMutationStepResult> {
  if (message.created_by_id !== user.id) return { kind: 'forbidden' }
  if (message.body === body) return { kind: 'ok' }

  const now = nowIso()
  try {
    await runD1Batch(
      db,
      db
        .updateTable('comment_messages')
        .set({ body, updated_at: now })
        .where('id', '=', message.id),
      db
        .updateTable('comment_threads')
        .set({ updated_at: now })
        .where('id', '=', message.thread_id)
        .where('shareable_id', '=', access.shareableId),
    )
  } catch {
    return { kind: 'commit-failed' }
  }

  await scheduleCommentThreadsChanged(access.shareableId, options)
  return { kind: 'ok' }
}

async function mutateLoadedCommentMessageDelete(
  db: Kysely<DB>,
  access: CommentAccess,
  user: SessionUser,
  message: LoadedCommentMessage,
  expectedThreadId?: string,
  options?: CommentMutationOptions,
): Promise<CommentMutationStepResult> {
  if (
    expectedThreadId !== undefined &&
    message.thread_id !== expectedThreadId
  ) {
    return { kind: 'invalid-message' }
  }
  const isOwner = await liveOwnerAccess(db, access, user.id)
  if (
    message.created_by_id !== user.id &&
    !isOwner &&
    !access.isTeamWorkspaceAdmin
  ) {
    return { kind: 'forbidden' }
  }

  const now = nowIso()
  try {
    await runD1Batch(
      db,
      db.deleteFrom('comment_messages').where('id', '=', message.id),
      db
        .deleteFrom('comment_anchors')
        .where('thread_id', '=', message.thread_id)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('comment_messages')
                .select('id')
                .whereRef('thread_id', '=', 'comment_anchors.thread_id'),
            ),
          ),
        ),
      db
        .deleteFrom('comment_threads')
        .where('id', '=', message.thread_id)
        .where('shareable_id', '=', access.shareableId)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('comment_messages')
                .select('id')
                .whereRef('thread_id', '=', 'comment_threads.id'),
            ),
          ),
        ),
      db
        .updateTable('comment_threads')
        .set({ updated_at: now })
        .where('id', '=', message.thread_id)
        .where('shareable_id', '=', access.shareableId)
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom('comment_messages')
              .select('id')
              .whereRef('thread_id', '=', 'comment_threads.id'),
          ),
        ),
    )
  } catch {
    return { kind: 'commit-failed' }
  }

  await scheduleCommentThreadsChanged(access.shareableId, options)
  return { kind: 'ok' }
}

export async function deleteCommentThread(
  db: Kysely<DB>,
  access: CommentAccess,
  user: SessionUser,
  threadId: string,
  options?: CommentMutationOptions,
): Promise<CommentMutationResult> {
  const thread = await loadThread(db, access.shareableId, threadId)
  if (!thread) return { kind: 'invalid-thread' }
  const isOwner = await liveOwnerAccess(db, access, user.id)
  if (
    !isOwner &&
    !access.isTeamWorkspaceAdmin &&
    thread.created_by_id !== user.id
  ) {
    return { kind: 'forbidden' }
  }

  try {
    await runD1Batch(
      db,
      db.deleteFrom('comment_anchors').where('thread_id', '=', threadId),
      db.deleteFrom('comment_messages').where('thread_id', '=', threadId),
      db
        .deleteFrom('comment_threads')
        .where('id', '=', threadId)
        .where('shareable_id', '=', access.shareableId),
    )
  } catch {
    return { kind: 'commit-failed' }
  }

  await scheduleCommentThreadsChanged(access.shareableId, options)
  return { kind: 'ok', threads: await loadCommentThreads(db, access, user) }
}

export function changeComment(
  db: Kysely<DB>,
  access: CommentAccess,
  user: SessionUser,
  input: ChangeCommentInput,
  options?: CommentMutationOptions,
): Promise<ChangeCommentResult> {
  switch (input.kind) {
    case 'update':
      return updateExistingComment(db, access, user, input, options)
    case 'delete':
      return deleteExistingComment(db, access, user, input, options)
  }
}

async function updateExistingComment(
  db: Kysely<DB>,
  access: CommentAccess,
  user: SessionUser,
  input: Extract<ChangeCommentInput, { kind: 'update' }>,
  options?: CommentMutationOptions,
): Promise<ChangeCommentResult> {
  let threadId: string | null | undefined = input.threadId
  let threads: CommentThreadView[] | null = null

  if (input.messageId !== undefined && input.body !== undefined) {
    const body = normalizeCommentBody(input.body)
    if (!body) return { kind: 'invalid-body' }

    const message = await loadMessage(db, access.shareableId, input.messageId)
    if (!message) return { kind: 'invalid-message' }
    threadId ??= message.thread_id

    const result = await mutateLoadedCommentMessage(
      db,
      access,
      user,
      message,
      body,
      options,
    )
    if (result.kind !== 'ok') return result
  }

  if (input.resolved !== undefined) {
    if (!threadId) return { kind: 'invalid-thread' }
    const thread = await loadThread(db, access.shareableId, threadId)
    if (!thread) return { kind: 'invalid-thread' }
    const result = await mutateLoadedCommentThreadResolved(
      db,
      access,
      user,
      thread,
      input.resolved,
      options,
    )
    if (result.kind !== 'ok') return result
  }

  if (!threadId) return { kind: 'invalid-thread' }

  threads = await loadCommentThreads(db, access, user)
  const thread =
    findCommentThread(threads, threadId) ??
    (await loadCommentThread(db, access, user, threadId))
  return thread
    ? { kind: 'ok', threadId, thread, threads }
    : { kind: 'commit-failed' }
}

async function deleteExistingComment(
  db: Kysely<DB>,
  access: CommentAccess,
  user: SessionUser,
  input: Extract<ChangeCommentInput, { kind: 'delete' }>,
  options?: CommentMutationOptions,
): Promise<ChangeCommentResult> {
  if (input.messageId) {
    const message = await loadMessage(db, access.shareableId, input.messageId)
    if (!message) return { kind: 'invalid-message' }
    const threadId = input.threadId ?? message.thread_id

    const result = await mutateLoadedCommentMessageDelete(
      db,
      access,
      user,
      message,
      input.threadId,
      options,
    )
    if (result.kind !== 'ok') return result

    const threads = await loadCommentThreads(db, access, user)
    const thread =
      findCommentThread(threads, threadId) ??
      (await loadCommentThread(db, access, user, threadId))
    return {
      kind: 'ok',
      threadId,
      deleted: true,
      threadDeleted: !thread,
      threads,
      ...(thread ? { thread } : {}),
    }
  }

  if (!input.threadId) return { kind: 'invalid-thread' }
  const result = await deleteCommentThread(
    db,
    access,
    user,
    input.threadId,
    options,
  )
  if (result.kind !== 'ok') return result
  return {
    kind: 'ok',
    threadId: input.threadId,
    deleted: true,
    threadDeleted: true,
    threads: result.threads,
  }
}

function findCommentThread(
  threads: CommentThreadView[],
  threadId: string,
): CommentThreadView | null {
  return threads.find((thread) => thread.id === threadId) ?? null
}

async function scheduleCommentThreadsChanged(
  shareableId: string,
  options?: CommentMutationOptions,
): Promise<void> {
  const promise = notifyCommentThreadsChanged(
    shareableId,
    options?.live,
    options?.originMutationId,
    options?.originUserId,
  )
  if (options?.waitUntil) {
    options.waitUntil(promise)
    return
  }
  await promise
}

export async function notifyCommentThreadsChanged(
  shareableId: string,
  live: ArtifactLiveBinding | undefined = (
    env as { ARTIFACT_LIVE?: ArtifactLiveBinding }
  ).ARTIFACT_LIVE,
  originMutationId?: string,
  originUserId?: string,
): Promise<void> {
  if (!live) return
  try {
    await live
      .getByName(shareableId)
      .notifyCommentsChanged(originMutationId, originUserId)
  } catch {
    // Realtime delivery is advisory; D1 remains the source of truth.
  }
}

function canResolveCommentThread(
  access: CommentAccess,
  userId: string,
  threadCreatedById: string,
): boolean {
  return (
    (access.isOwner && access.ownerUserId === userId) ||
    access.isTeamWorkspaceAdmin ||
    threadCreatedById === userId
  )
}

async function liveOwnerAccess(
  db: Kysely<DB>,
  access: CommentAccess,
  userId: string,
): Promise<boolean> {
  return (
    access.ownerUserId === userId &&
    !(await isWorkspaceAccessRevoked(db, access.workspaceId, userId))
  )
}

function normalizeCommentBody(rawBody: string): string | null {
  const body = rawBody.trim()
  if (!body) return null
  if (body.length > MAX_COMMENT_BODY_LENGTH) return null
  return body
}

function normalizeCommentAnchor(
  access: CommentAccess,
  rawAnchor: CommentAnchorInput,
):
  | (CommentAnchorInput & {
      targetPath: string
    })
  | null {
  if (!canUseTextAnchors(access)) return null
  if (
    typeof rawAnchor.quotedText !== 'string' ||
    typeof rawAnchor.prefixText !== 'string' ||
    typeof rawAnchor.suffixText !== 'string'
  )
    return null
  const quotedText = rawAnchor.quotedText
  if (!quotedText.trim() || quotedText.length > MAX_QUOTED_TEXT_LENGTH)
    return null
  if (
    rawAnchor.prefixText.length > MAX_CONTEXT_TEXT_LENGTH ||
    rawAnchor.suffixText.length > MAX_CONTEXT_TEXT_LENGTH
  )
    return null
  if (
    rawAnchor.selectorFormat !== undefined &&
    rawAnchor.selectorFormat !== 'normalized-v1' &&
    rawAnchor.selectorFormat !== 'quote-v1'
  )
    return null
  if (
    rawAnchor.selectorFormat === undefined &&
    (!Number.isSafeInteger(rawAnchor.textStart) ||
      !Number.isSafeInteger(rawAnchor.textEnd) ||
      rawAnchor.textStart! < 0 ||
      rawAnchor.textEnd! - rawAnchor.textStart! !== quotedText.length)
  )
    return null
  if (rawAnchor.selectorFormat === 'normalized-v1') {
    if (
      quotedText !== quotedText.replace(/\s+/g, ' ').trim() ||
      rawAnchor.prefixText !== rawAnchor.prefixText.replace(/\s+/g, ' ') ||
      rawAnchor.suffixText !== rawAnchor.suffixText.replace(/\s+/g, ' ')
    )
      return null
    if (
      !Number.isSafeInteger(rawAnchor.textStart) ||
      !Number.isSafeInteger(rawAnchor.textEnd) ||
      rawAnchor.textStart! < 0 ||
      rawAnchor.textEnd! - rawAnchor.textStart! !== quotedText.length ||
      !validTextHash(rawAnchor.textHash) ||
      typeof rawAnchor.ambiguousAtCreation !== 'boolean' ||
      typeof rawAnchor.versionId !== 'string' ||
      !rawAnchor.versionId ||
      rawAnchor.versionId.length > 128
    )
      return null
  } else if (
    rawAnchor.selectorFormat === 'quote-v1' &&
    (rawAnchor.textStart !== null ||
      rawAnchor.textEnd !== null ||
      rawAnchor.textHash != null)
  )
    return null
  if (
    rawAnchor.cssPath !== null &&
    (typeof rawAnchor.cssPath !== 'string' ||
      rawAnchor.cssPath.length > MAX_CSS_PATH_LENGTH)
  )
    return null
  return {
    ...rawAnchor,
    quotedText,
    targetPath: access.entrypointPath ?? '/index.html',
  }
}

function validTextHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function canUseTextAnchors(access: CommentAccess): boolean {
  return (
    (access.artifactKind === 'html_page' ||
      access.artifactKind === 'markdown_page') &&
    Boolean(access.currentVersionId) &&
    Boolean(access.r2Key)
  )
}

type AnchorRow = {
  id: string
  thread_id: string
  version_id: string | null
  target_path: string
  quoted_text: string
  prefix_text: string
  suffix_text: string
  text_start: number
  text_end: number
  css_path: string | null
  selector_format: 'normalized-v1' | 'quote-v1' | null
  text_hash: string | null
  ambiguous_at_creation: number | null
}

async function resolveCommentSubjects(
  db: Kysely<DB>,
  access: CommentAccess,
  anchors: AnchorRow[],
): Promise<Map<string, CommentThreadSubject>> {
  const subjects = new Map<string, CommentThreadSubject>()
  for (const anchor of anchors) {
    const results = await db
      .selectFrom('comment_anchor_results')
      .innerJoin('versions', 'versions.id', 'comment_anchor_results.version_id')
      .selectAll('comment_anchor_results')
      .where('anchor_id', '=', anchor.id)
      .where('versions.shareable_id', '=', access.shareableId)
      .where('versions.created_at', '<=', (eb) =>
        eb
          .selectFrom('versions as displayed')
          .select('displayed.created_at')
          .where('displayed.id', '=', access.currentVersionId ?? ''),
      )
      .orderBy('comment_anchor_results.updated_at', 'desc')
      .orderBy('versions.created_at', 'desc')
      .execute()
    const current = results.find(
      (result) =>
        result.version_id === access.currentVersionId &&
        result.target_path === (access.entrypointPath ?? '/index.html'),
    )
    const latest = results.find((result) => result.text_hash !== null)
    const positionState = current?.state ?? 'unchecked'
    subjects.set(anchor.thread_id, {
      kind: 'text',
      state: positionState === 'attached' ? 'attached' : 'orphaned',
      positionState,
      quotedText: anchor.quoted_text,
      prefixText: anchor.prefix_text,
      suffixText: anchor.suffix_text,
      targetPath: anchor.target_path,
      versionId: anchor.version_id,
      selectorFormat: anchor.selector_format,
      textHash: latest?.text_hash ?? anchor.text_hash,
      ambiguousAtCreation: anchor.ambiguous_at_creation === 1,
      textStart:
        latest?.hint_start ??
        (anchor.selector_format === 'normalized-v1' ? anchor.text_start : null),
      textEnd:
        latest?.hint_end ??
        (anchor.selector_format === 'normalized-v1' ? anchor.text_end : null),
      cssPath: anchor.css_path,
    })
  }
  return subjects
}

/** Quote creation deliberately does not read or interpret artifact content. */
export function buildQuoteAnchor(
  access: CommentAccess,
  input: QuoteAnchorInput,
): BuildQuoteAnchorResult {
  if (!canUseTextAnchors(access)) return { kind: 'unsupported' }
  if (
    typeof input.quote !== 'string' ||
    (input.before !== undefined && typeof input.before !== 'string') ||
    (input.after !== undefined && typeof input.after !== 'string')
  )
    return { kind: 'invalid' }
  const quote = input.quote.replace(/\s+/g, ' ').trim()
  const before = (input.before ?? '').replace(/\s+/g, ' ')
  const after = (input.after ?? '').replace(/\s+/g, ' ')
  if (
    !quote ||
    quote.length > MAX_QUOTED_TEXT_LENGTH ||
    before.length > MAX_CONTEXT_TEXT_LENGTH ||
    after.length > MAX_CONTEXT_TEXT_LENGTH
  )
    return { kind: 'invalid' }
  return {
    kind: 'ok',
    anchor: {
      quotedText: quote,
      prefixText: before,
      suffixText: after,
      selectorFormat: 'quote-v1',
      textStart: null,
      textEnd: null,
      cssPath: null,
    },
  }
}

export interface AnchorResolutionInput {
  threadId: string
  state: 'attached' | 'needs-check'
  textStart: number | null
  textEnd: number | null
  textHash: string | null
}

export function isAnchorResolution(
  value: unknown,
): value is AnchorResolutionInput {
  if (!value || typeof value !== 'object') return false
  const v = value as AnchorResolutionInput
  if (typeof v.threadId !== 'string' || !v.threadId || v.threadId.length > 128)
    return false
  if (v.state === 'needs-check')
    return v.textStart === null && v.textEnd === null && v.textHash === null
  return (
    v.state === 'attached' &&
    Number.isSafeInteger(v.textStart) &&
    Number.isSafeInteger(v.textEnd) &&
    v.textStart! >= 0 &&
    v.textEnd! > v.textStart! &&
    validTextHash(v.textHash)
  )
}

/** Position-only writes: verified viewer access, no editing or unread events. */
export async function storeAnchorResolutions(
  db: Kysely<DB>,
  access: CommentAccess,
  input: {
    versionId: string
    targetPath: string
    frameToken: string
    generation: number
    results: AnchorResolutionInput[]
  },
): Promise<boolean> {
  if (
    !Array.isArray(input.results) ||
    input.results.length > 100 ||
    !input.results.every(isAnchorResolution) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0 ||
    !/^[a-f0-9]{64}$/.test(input.frameToken) ||
    typeof input.targetPath !== 'string' ||
    input.targetPath.length > 1000
  )
    return false
  const version = await db
    .selectFrom('versions')
    .select(['id', 'entrypoint_path'])
    .where('id', '=', input.versionId)
    .where('shareable_id', '=', access.shareableId)
    .executeTakeFirst()
  if (
    !version ||
    (version.entrypoint_path ?? '/index.html') !== input.targetPath
  )
    return false
  const writes: Compilable<unknown>[] = []
  for (const result of input.results) {
    const anchor = await db
      .selectFrom('comment_anchors')
      .innerJoin(
        'comment_threads',
        'comment_threads.id',
        'comment_anchors.thread_id',
      )
      .select([
        'comment_anchors.id',
        'comment_anchors.quoted_text',
        'comment_anchors.target_path',
      ])
      .where('comment_threads.shareable_id', '=', access.shareableId)
      .where('thread_id', '=', result.threadId)
      .executeTakeFirst()
    if (
      !anchor ||
      (result.state === 'attached' &&
        result.textEnd! - result.textStart! !==
          anchor.quoted_text.replace(/\s+/g, ' ').length)
    )
      return false
    const values = {
      anchor_id: anchor.id,
      version_id: input.versionId,
      target_path: input.targetPath,
      state: result.state,
      hint_start: result.textStart,
      hint_end: result.textEnd,
      text_hash: result.textHash,
      frame_token: input.frameToken,
      generation: input.generation,
      updated_at: nowIso(),
    }
    writes.push(
      db
        .insertInto('comment_anchor_results')
        .values(values)
        .onConflict((oc) =>
          oc
            .columns(['anchor_id', 'version_id', 'target_path'])
            .doUpdateSet(
              result.state === 'attached'
                ? values
                : {
                    ...values,
                    hint_start: sql`comment_anchor_results.hint_start`,
                    hint_end: sql`comment_anchor_results.hint_end`,
                    text_hash: sql`comment_anchor_results.text_hash`,
                  },
            )
            .where((eb) =>
              eb.or([
                eb(
                  'comment_anchor_results.frame_token',
                  '!=',
                  input.frameToken,
                ),
                eb('comment_anchor_results.generation', '<', input.generation),
              ]),
            ),
        ),
    )
  }
  if (writes.length) await runD1Batch(db, ...writes)
  return true
}

function loadThread(db: Kysely<DB>, shareableId: string, threadId: string) {
  return db
    .selectFrom('comment_threads')
    .select(['id', 'created_by_id', 'status'])
    .where('id', '=', threadId)
    .where('shareable_id', '=', shareableId)
    .executeTakeFirst()
}

type LoadedCommentThread = NonNullable<Awaited<ReturnType<typeof loadThread>>>

function loadMessage(db: Kysely<DB>, shareableId: string, messageId: string) {
  return db
    .selectFrom('comment_messages')
    .innerJoin(
      'comment_threads',
      'comment_threads.id',
      'comment_messages.thread_id',
    )
    .select([
      'comment_messages.id',
      'comment_messages.thread_id',
      'comment_messages.created_by_id',
      'comment_messages.body',
    ])
    .where('comment_messages.id', '=', messageId)
    .where('comment_threads.shareable_id', '=', shareableId)
    .executeTakeFirst()
}

type LoadedCommentMessage = NonNullable<Awaited<ReturnType<typeof loadMessage>>>

export interface PostArtifactCommentInput {
  body: string
  replyTo?: string | undefined
  quote?: string | undefined
  quoteBefore?: string | undefined
  quoteAfter?: string | undefined
  agent?: string | undefined
}

export type PostArtifactCommentResult =
  | {
      kind: 'ok'
      threadId: string
      reply: boolean
      thread: CommentThreadView
      visibility: Visibility
    }
  | { kind: 'quote-on-reply' }
  | { kind: 'quote-unsupported' }
  | { kind: 'quote-not-found' }
  | Exclude<CommentMutationResult, { kind: 'ok' }>

/**
 * Shared post pipeline for the agent surfaces (MCP post_comment and the CLI
 * comments route) so input rules, anchor handling, and failure kinds cannot
 * drift between them. Transports map kinds to their own error shapes.
 */
export async function postArtifactComment(
  db: Kysely<DB>,
  user: SessionUser,
  artifactId: string,
  input: PostArtifactCommentInput,
  options?: CommentMutationOptions,
): Promise<PostArtifactCommentResult> {
  // A quote anchors a span on a brand-new thread; a reply joins an existing
  // thread's anchor, so the two can't be combined.
  if (input.quote !== undefined && input.replyTo !== undefined) {
    return { kind: 'quote-on-reply' }
  }

  // Workspace-scoped view check: anyone who can view the artifact can comment
  // on it, and a non-viewable (or absent) id refuses without leaking which.
  const access = await loadCommentAccess(
    db,
    user,
    artifactId,
    options?.agentReadAuthorization,
  )
  if (!access) return { kind: 'not-found' }

  // The viewer resolves agent-supplied quotes when the document is opened.
  let anchor: CommentAnchorInput | undefined
  if (input.quote !== undefined) {
    const built = await buildQuoteAnchor(access, {
      quote: input.quote,
      before: input.quoteBefore,
      after: input.quoteAfter,
    })
    if (built.kind === 'unsupported') return { kind: 'quote-unsupported' }
    if (built.kind === 'invalid') return { kind: 'invalid-anchor' }
    anchor = built.anchor
  }

  let threadId: string
  let threads: CommentThreadView[]
  const normalizedAgent =
    input.agent && input.agent.trim() ? input.agent.trim() : null

  if (input.replyTo !== undefined) {
    const result = await replyToCommentThread(
      db,
      access,
      user,
      input.replyTo,
      input.body,
      options,
      normalizedAgent,
    )
    if (result.kind !== 'ok') return result
    threadId = input.replyTo
    threads = result.threads
  } else {
    const result = await createCommentThread(
      db,
      access,
      user,
      input.body,
      anchor,
      options,
      normalizedAgent,
    )
    if (result.kind === 'version-conflict') return { kind: 'commit-failed' }
    if (result.kind !== 'ok') return result
    threadId = result.threadId
    threads = result.threads
  }

  // The thread just written bubbles to the newest, so it's always within the
  // capped set the mutation returned; the guard is for the type.
  const thread = threads.find((candidate) => candidate.id === threadId)
  if (!thread) return { kind: 'commit-failed' }
  return {
    kind: 'ok',
    threadId,
    reply: input.replyTo !== undefined,
    thread,
    visibility: access.visibility,
  }
}
