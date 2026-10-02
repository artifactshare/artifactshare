import { env } from 'cloudflare:workers'
import type { CommentAnchorInput } from '~/services/comments.server'
import {
  clearCommentAnchorTextCache,
  createCommentThread,
  loadCommentThreads,
  type CommentAccess,
} from '~/services/comments.server'
import { createMigratedInMemoryDb } from './sqlite-fixture'
import { extractAnchorDocument } from '@artifactshare/viewer-kit/anchor-text'
import { renderMarkdownDocument } from '~/lib/markdown-render'

/** Browser payloads pass through the production create/read path and real SQL. */
export async function commentAnchorRoundTrip(input: {
  source: string
  nextSource: string
  anchor: CommentAnchorInput
  markdown?: boolean
}) {
  const { db, sqlite } = createMigratedInMemoryDb()
  const now = '2026-05-29T00:00:00.000Z'
  const kind = input.markdown ? 'markdown_page' : 'html_page'
  const path = input.markdown ? '/artifact.md' : '/artifact.html'
  const sources = new Map([
    ['v1', input.source],
    ['v2', input.nextSource],
  ])
  Object.assign(env, {
    BUCKET: {
      get: (key: string) =>
        Promise.resolve({ text: () => Promise.resolve(sources.get(key)) }),
    },
  })
  clearCommentAnchorTextCache()
  try {
    await db
      .insertInto('workspaces')
      .values({
        id: 'ws1',
        hd: 'example.com',
        name: 'Example',
        created_at: now,
      })
      .execute()
    await db
      .insertInto('users')
      .values({
        id: 'u1',
        email: 'owner@example.com',
        email_verified: 1,
        name: 'Owner',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: 'ws1',
        locale: null,
      })
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'inbox1',
        workspace_id: 'ws1',
        kind: 'inbox',
        owner_user_id: 'u1',
        created_by_id: 'u1',
        name: 'Inbox',
        description: null,
        archived_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 'abc123def4',
        workspace_id: 'ws1',
        owner_user_id: 'u1',
        slug: null,
        name: 'artifact.html',
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: kind,
        visibility: 'private',
        current_version_id: 'v1',
        container_id: 'inbox1',
        created_at: now,
        updated_at: now,
        last_accessed_at: null,
      })
      .execute()
    async function version(id: string) {
      await db
        .insertInto('versions')
        .values({
          id,
          shareable_id: 'abc123def4',
          artifact_kind: kind,
          status: 'published',
          entrypoint_path: path,
          r2_key: id,
          size_bytes: 100,
          sha256: id,
          created_by_id: 'u1',
          created_at: now,
          published_at: now,
        })
        .execute()
    }
    await version('v1')
    const access: CommentAccess = {
      shareableId: 'abc123def4',
      workspaceId: 'ws1',
      ownerUserId: 'u1',
      visibility: 'private',
      linkExpiresAt: null,
      currentVersionId: 'v1',
      artifactKind: kind,
      entrypointPath: path,
      r2Key: 'v1',
      isOwner: true,
      isTeamWorkspaceAdmin: false,
    }
    const user = {
      id: 'u1',
      email: 'owner@example.com',
      emailVerified: true,
      name: 'Owner',
      image: null,
      workspaceId: 'ws1',
      hd: 'example.com',
      msTenantId: null,
      kind: 'human' as const,
      locale: null,
    }
    const created = await createCommentThread(
      db,
      access,
      user,
      'Check this text.',
      input.anchor,
    )
    if (created.kind !== 'ok') throw new Error(created.kind)
    const stored = sqlite
      .prepare('SELECT quoted_text, text_start, text_end FROM comment_anchors')
      .get()
    await version('v2')
    await db
      .updateTable('shareables')
      .set({ current_version_id: 'v2' })
      .where('id', '=', 'abc123def4')
      .execute()
    const updated = await loadCommentThreads(
      db,
      { ...access, currentVersionId: 'v2', r2Key: 'v2' },
      user,
    )
    const text = (source: string) =>
      extractAnchorDocument(
        input.markdown ? renderMarkdownDocument(source) : source,
      ).text
    return {
      stored,
      origin: created.threads[0]!,
      updated: updated[0]!,
      text: text(input.source),
      nextText: text(input.nextSource),
    }
  } finally {
    clearCommentAnchorTextCache()
    await db.destroy()
  }
}
