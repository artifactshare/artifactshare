import { nanoid } from 'nanoid'
import { env } from 'cloudflare:workers'
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
import { renderMarkdownDocument } from '~/lib/markdown-render'
import type { Visibility } from '~/lib/shareable-types'
import type { SessionUser } from '~/lib/user'
import {
  isTeamWorkspaceAdmin,
  viewerDisplayCheck,
  type ArtifactSnapshot,
} from '~/services/access.server'
import { getArtifact } from './storage.server'
import { commentPostedEventQuery } from './events.server'
import type { DB } from '~/types/db'
import {
  COMMENT_THREAD_LIST_LIMIT,
  commentThreadWindowExpression,
} from './comment-thread-window.server'

export { COMMENT_THREAD_LIST_LIMIT } from './comment-thread-window.server'
export const MAX_QUOTED_TEXT_LENGTH = 1000
export const MAX_CONTEXT_TEXT_LENGTH = 200

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
const ANCHOR_TEXT_CACHE_TTL_MS = 5000
const ANCHOR_TEXT_CACHE_MAX_ENTRIES = 100

const anchorTextCache = new Map<string, { value: string; expiresAt: number }>()

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
  live?: ArtifactLiveBinding
  originMutationId?: string
  originUserId?: string
  waitUntil?: (promise: Promise<unknown>) => void
}

export function clearCommentAnchorTextCache() {
  anchorTextCache.clear()
}

export interface CommentAnchorInput {
  quotedText: string
  prefixText: string
  suffixText: string
  textStart: number
  textEnd: number
  cssPath: string | null
}

// The minimal anchor an agent supplies via the MCP post_comment tool: the text
// to quote, plus optional surrounding context to disambiguate repeats. The
// server measures the offsets against the current rendered source — the agent
// can't see them — so it never has to compute character positions itself.
export interface QuoteAnchorInput {
  quote: string
  before?: string
  after?: string
}

export type BuildQuoteAnchorResult =
  | { kind: 'ok'; anchor: CommentAnchorInput }
  // The artifact kind has no single anchorable text (a multi-file bundle).
  | { kind: 'unsupported' }
  // The quote doesn't appear in the current rendered source.
  | { kind: 'not-found' }

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

export async function loadCommentAccess(
  db: Kysely<DB>,
  user: SessionUser,
  shareableId: string,
): Promise<CommentAccess | null> {
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

  const snapshot: ArtifactSnapshot = {
    id: shareable.r2_key,
    name: shareable.name,
    mimeType:
      (shareable.version_artifact_kind ?? shareable.artifact_kind) ===
      'markdown_page'
        ? 'text/markdown'
        : 'text/html',
    modifiedTime: null,
    ownerEmail: null,
  }
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

  const access = await commentAccessFromVerifiedShareable(db, user, {
    id: shareable.id,
    workspaceId: shareable.workspace_id,
    ownerUserId: shareable.owner_user_id,
    visibility: shareable.visibility,
    linkExpiresAt: shareable.link_expires_at,
    currentVersionId: shareable.current_version_id,
    artifactKind: shareable.version_artifact_kind ?? shareable.artifact_kind,
    entrypointPath: shareable.entrypoint_path,
    r2Key: shareable.r2_key,
  })
  return {
    ...access,
    projectId:
      shareable.project_container_kind === 'project'
        ? shareable.container_id
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
      ])
      .where('comment_messages.thread_id', 'in', threadIds)
      .orderBy('comment_messages.created_at', 'asc')
      .orderBy('comment_messages.id', 'asc')
      .execute(),
    db
      .selectFrom('comment_anchors')
      .select([
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
      },
      canEdit: message.author_id === user.id,
      canDelete:
        message.author_id === user.id ||
        access.ownerUserId === user.id ||
        access.isTeamWorkspaceAdmin,
    })
    messagesByThread.set(message.thread_id, list)
  }

  const subjectsByThread = await resolveCommentSubjects(access, anchors)

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

  const now = nowIso()
  const threadId = nanoid()
  const messageId = nanoid()
  const queries: Compilable<unknown>[] = [
    db.insertInto('comment_threads').values({
      id: threadId,
      shareable_id: access.shareableId,
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
        text_start: anchor.textStart,
        text_end: anchor.textEnd,
        css_path: anchor.cssPath,
        created_at: now,
      }),
    )
  }
  try {
    await runD1Batch(...queries)
  } catch {
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
  if (!canResolveCommentThread(access, user.id, thread.created_by_id)) {
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
  if (
    message.created_by_id !== user.id &&
    access.ownerUserId !== user.id &&
    !access.isTeamWorkspaceAdmin
  ) {
    return { kind: 'forbidden' }
  }

  const now = nowIso()
  try {
    await runD1Batch(
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
  if (!canResolveCommentThread(access, user.id, thread.created_by_id)) {
    return { kind: 'forbidden' }
  }

  try {
    await runD1Batch(
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
    access.ownerUserId === userId ||
    access.isTeamWorkspaceAdmin ||
    threadCreatedById === userId
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
  const quotedText = rawAnchor.quotedText.trim()
  if (!quotedText || quotedText.length > MAX_QUOTED_TEXT_LENGTH) return null
  if (!Number.isInteger(rawAnchor.textStart)) return null
  if (!Number.isInteger(rawAnchor.textEnd)) return null
  if (rawAnchor.textStart < 0 || rawAnchor.textEnd <= rawAnchor.textStart) {
    return null
  }
  if (rawAnchor.textEnd - rawAnchor.textStart > MAX_QUOTED_TEXT_LENGTH) {
    return null
  }
  const prefixText = clampContext(rawAnchor.prefixText)
  const suffixText = clampContext(rawAnchor.suffixText)
  const cssPath =
    rawAnchor.cssPath && rawAnchor.cssPath.length <= MAX_CSS_PATH_LENGTH
      ? rawAnchor.cssPath
      : null
  return {
    quotedText,
    prefixText,
    suffixText,
    textStart: rawAnchor.textStart,
    textEnd: rawAnchor.textEnd,
    cssPath,
    targetPath: access.entrypointPath ?? '/index.html',
  }
}

function clampContext(value: string): string {
  return value.trim().slice(0, MAX_CONTEXT_TEXT_LENGTH)
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
  thread_id: string
  version_id: string | null
  target_path: string
  quoted_text: string
  prefix_text: string
  suffix_text: string
  text_start: number
  text_end: number
  css_path: string | null
}

async function resolveCommentSubjects(
  access: CommentAccess,
  anchors: AnchorRow[],
): Promise<Map<string, CommentThreadSubject>> {
  const subjects = new Map<string, CommentThreadSubject>()
  if (anchors.length === 0) return subjects

  let currentText: string | null = null
  const needsCurrentText = anchors.some(
    (anchor) =>
      anchor.version_id !== access.currentVersionId ||
      anchor.target_path !== access.entrypointPath,
  )
  if (needsCurrentText && canUseTextAnchors(access)) {
    currentText = await loadCurrentAnchorText(access)
  }

  for (const anchor of anchors) {
    let range: { textStart: number; textEnd: number } | null = null
    if (
      anchor.version_id === access.currentVersionId &&
      anchor.target_path === access.entrypointPath
    ) {
      range = { textStart: anchor.text_start, textEnd: anchor.text_end }
    } else if (currentText) {
      range = findAnchorRange(currentText, anchor)
    }
    subjects.set(anchor.thread_id, {
      kind: 'text',
      state: range ? 'attached' : 'orphaned',
      quotedText: anchor.quoted_text,
      prefixText: anchor.prefix_text,
      suffixText: anchor.suffix_text,
      targetPath: anchor.target_path,
      versionId: anchor.version_id,
      textStart: range?.textStart ?? null,
      textEnd: range?.textEnd ?? null,
      cssPath: anchor.css_path,
    })
  }
  return subjects
}

async function loadCurrentAnchorText(
  access: CommentAccess,
): Promise<string | null> {
  if (!access.r2Key) return null
  const cacheKey = `${access.artifactKind}:${access.r2Key}`
  const cached = anchorTextCache.get(cacheKey)
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    return cached.value
  }
  if (cached) anchorTextCache.delete(cacheKey)
  try {
    const object = await getArtifact(env.BUCKET, access.r2Key)
    if (!object) return null
    const raw = await object.text()
    const value = htmlToSearchText(
      access.artifactKind === 'markdown_page'
        ? renderMarkdownDocument(raw)
        : raw,
    )
    pruneCommentAnchorTextCache(now)
    if (anchorTextCache.size >= ANCHOR_TEXT_CACHE_MAX_ENTRIES) {
      const oldestKey = anchorTextCache.keys().next().value
      if (oldestKey) anchorTextCache.delete(oldestKey)
    }
    anchorTextCache.set(cacheKey, {
      value,
      expiresAt: now + ANCHOR_TEXT_CACHE_TTL_MS,
    })
    return value
  } catch {
    anchorTextCache.delete(cacheKey)
    return null
  }
}

function pruneCommentAnchorTextCache(now: number) {
  for (const [key, entry] of anchorTextCache) {
    if (entry.expiresAt <= now) anchorTextCache.delete(key)
  }
}

// Turn an agent's quote into a stored anchor by locating it in the current
// rendered source. The agent reads the raw source (Markdown / HTML) but the
// anchor lives in the rendered, tag-stripped text the viewer measures, so only
// a plain-text quote matches — a quote carrying markup falls to 'not-found',
// which the tool surfaces as a clear, retryable error.
export async function buildQuoteAnchor(
  access: CommentAccess,
  input: QuoteAnchorInput,
): Promise<BuildQuoteAnchorResult> {
  if (!canUseTextAnchors(access)) return { kind: 'unsupported' }
  const quote = input.quote.trim()
  if (!quote || quote.length > MAX_QUOTED_TEXT_LENGTH)
    return { kind: 'not-found' }

  const currentText = await loadCurrentAnchorText(access)
  if (!currentText) return { kind: 'not-found' }

  const matches: number[] = []
  let index = currentText.indexOf(quote)
  while (index >= 0) {
    matches.push(index)
    index = currentText.indexOf(quote, index + 1)
  }
  if (matches.length === 0) return { kind: 'not-found' }

  // Disambiguate repeats with the supplied context; ties keep the first match.
  const before = input.before?.trim() ?? ''
  const after = input.after?.trim() ?? ''
  const best = matches.reduce(
    (min, start) => {
      const score = quoteContextPenalty(
        currentText,
        start,
        quote,
        before,
        after,
      )
      return score < min.score ? { start, score } : min
    },
    { start: -1, score: Infinity },
  )
  const textStart = best.start
  const textEnd = textStart + quote.length

  // Persist context around the match so the anchor can re-locate the span after
  // later edits, preferring the agent's hint when it gave one.
  const prefixText =
    before ||
    currentText.slice(
      Math.max(0, textStart - MAX_CONTEXT_TEXT_LENGTH),
      textStart,
    )
  const suffixText =
    after || currentText.slice(textEnd, textEnd + MAX_CONTEXT_TEXT_LENGTH)

  return {
    kind: 'ok',
    anchor: {
      quotedText: quote,
      prefixText,
      suffixText,
      textStart,
      textEnd,
      cssPath: null,
    },
  }
}

function quoteContextPenalty(
  text: string,
  start: number,
  quote: string,
  before: string,
  after: string,
): number {
  let penalty = 0
  if (before) {
    const slice = text.slice(Math.max(0, start - before.length), start)
    if (!slice.endsWith(before)) penalty += 10_000
  }
  if (after) {
    const end = start + quote.length
    const slice = text.slice(end, end + after.length)
    if (!slice.startsWith(after)) penalty += 10_000
  }
  return penalty
}

function findAnchorRange(
  currentText: string,
  anchor: AnchorRow,
): { textStart: number; textEnd: number } | null {
  const matches: number[] = []
  let index = currentText.indexOf(anchor.quoted_text)
  while (index >= 0) {
    matches.push(index)
    index = currentText.indexOf(anchor.quoted_text, index + 1)
  }
  if (matches.length === 0) return null
  const best = matches.reduce(
    (min, start) => {
      const score =
        Math.abs(start - anchor.text_start) +
        contextPenalty(currentText, start, anchor)
      return score < min.score ? { start, score } : min
    },
    { start: -1, score: Infinity },
  )
  return {
    textStart: best.start,
    textEnd: best.start + anchor.quoted_text.length,
  }
}

function contextPenalty(
  currentText: string,
  start: number,
  anchor: AnchorRow,
): number {
  let penalty = 0
  if (anchor.prefix_text) {
    const before = currentText.slice(
      Math.max(0, start - anchor.prefix_text.length - 40),
      start,
    )
    if (!before.endsWith(anchor.prefix_text)) penalty += 10_000
  }
  if (anchor.suffix_text) {
    const end = start + anchor.quoted_text.length
    const after = currentText.slice(
      end,
      Math.min(currentText.length, end + anchor.suffix_text.length + 40),
    )
    if (!after.startsWith(anchor.suffix_text)) penalty += 10_000
  }
  return penalty
}

function htmlToSearchText(html: string): string {
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  const body = bodyMatch?.[1] ?? html
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(
      /&(?:#(\d+)|#x([\da-f]+)|([a-z][\da-z]+));/gi,
      (match, dec, hex, name) => decodeHtmlEntity(match, dec, hex, name),
    )
}

const HTML_ENTITY_NAMES: Record<string, string> = {
  AElig: 'Æ',
  Aacute: 'Á',
  Acirc: 'Â',
  Agrave: 'À',
  Aring: 'Å',
  Atilde: 'Ã',
  Auml: 'Ä',
  Ccedil: 'Ç',
  ETH: 'Ð',
  Eacute: 'É',
  Ecirc: 'Ê',
  Egrave: 'È',
  Euml: 'Ë',
  Iacute: 'Í',
  Icirc: 'Î',
  Igrave: 'Ì',
  Iuml: 'Ï',
  Ntilde: 'Ñ',
  Oacute: 'Ó',
  Ocirc: 'Ô',
  Ograve: 'Ò',
  Oslash: 'Ø',
  Otilde: 'Õ',
  Ouml: 'Ö',
  THORN: 'Þ',
  Uacute: 'Ú',
  Ucirc: 'Û',
  Ugrave: 'Ù',
  Uuml: 'Ü',
  Yacute: 'Ý',
  amp: '&',
  aacute: 'á',
  acirc: 'â',
  acute: '´',
  aelig: 'æ',
  agrave: 'à',
  aring: 'å',
  atilde: 'ã',
  auml: 'ä',
  brvbar: '¦',
  bull: '•',
  ccedil: 'ç',
  cedil: '¸',
  cent: '¢',
  apos: "'",
  curren: '¤',
  copy: '©',
  deg: '°',
  divide: '÷',
  eacute: 'é',
  ecirc: 'ê',
  egrave: 'è',
  emsp: '\u2003',
  ensp: '\u2002',
  eth: 'ð',
  euro: '€',
  euml: 'ë',
  gt: '>',
  hellip: '…',
  iacute: 'í',
  icirc: 'î',
  iexcl: '¡',
  igrave: 'ì',
  iquest: '¿',
  iuml: 'ï',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  macr: '¯',
  mdash: '—',
  micro: 'µ',
  middot: '·',
  nbsp: '\u00A0',
  ndash: '–',
  not: '¬',
  ntilde: 'ñ',
  oacute: 'ó',
  ocirc: 'ô',
  ograve: 'ò',
  ordf: 'ª',
  ordm: 'º',
  oslash: 'ø',
  otilde: 'õ',
  ouml: 'ö',
  para: '¶',
  plusmn: '±',
  pound: '£',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  sect: '§',
  shy: '\u00AD',
  sup1: '¹',
  sup2: '²',
  sup3: '³',
  szlig: 'ß',
  thinsp: '\u2009',
  thorn: 'þ',
  trade: '™',
  times: '×',
  uacute: 'ú',
  ucirc: 'û',
  ugrave: 'ù',
  uml: '¨',
  uuml: 'ü',
  yacute: 'ý',
  yen: '¥',
  yuml: 'ÿ',
}

function decodeHtmlEntity(
  match: string,
  dec?: string,
  hex?: string,
  name?: string,
): string {
  const codePoint = dec
    ? Number.parseInt(dec, 10)
    : hex
      ? Number.parseInt(hex, 16)
      : NaN
  if (Number.isFinite(codePoint)) {
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return match
    }
  }
  return lookupHtmlEntity(name) ?? match
}

function lookupHtmlEntity(name?: string): string | null {
  if (!name) return null
  if (Object.prototype.hasOwnProperty.call(HTML_ENTITY_NAMES, name)) {
    return HTML_ENTITY_NAMES[name]!
  }
  return null
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
  | { kind: 'ok'; threadId: string; reply: boolean; thread: CommentThreadView }
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
  const access = await loadCommentAccess(db, user, artifactId)
  if (!access) return { kind: 'not-found' }

  // The agent supplies the quoted text, never offsets — the server measures
  // them against the current source.
  let anchor: CommentAnchorInput | undefined
  if (input.quote !== undefined) {
    const built = await buildQuoteAnchor(access, {
      quote: input.quote,
      before: input.quoteBefore,
      after: input.quoteAfter,
    })
    if (built.kind === 'unsupported') return { kind: 'quote-unsupported' }
    if (built.kind === 'not-found') return { kind: 'quote-not-found' }
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
    if (result.kind !== 'ok') return result
    threadId = result.threadId
    threads = result.threads
  }

  // The thread just written bubbles to the newest, so it's always within the
  // capped set the mutation returned; the guard is for the type.
  const thread = threads.find((candidate) => candidate.id === threadId)
  if (!thread) return { kind: 'commit-failed' }
  return { kind: 'ok', threadId, reply: input.replyTo !== undefined, thread }
}
