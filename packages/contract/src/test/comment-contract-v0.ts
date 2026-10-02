// Frozen pre-position-state response schemas. Do not derive these from the new comment schemas.
import { z } from 'zod'
import { ArtifactVersionSchema } from '../index.js'
const stringId = z.string().min(1)
const timestamp = z.string().min(1)
const url = z.string().url()
const nullableTimestamp = timestamp.nullable()

export const CommentAnchorSchemaV0 = z.union([
  z.object({
    kind: z.literal('artifact'),
    quoted_text: z.null(),
    state: z.null(),
  }),
  z.object({
    kind: z.literal('text'),
    quoted_text: z.string(),
    state: z.enum(['attached', 'orphaned']),
  }),
])

export const CommentMessageSchemaV0 = z.object({
  message_id: stringId,
  author_name: z.string().nullable(),
  author_email: z.string(),
  agent: z.string().nullable(),
  body: z.string(),
  created_at: timestamp,
  updated_at: timestamp,
})

export const CommentThreadSchemaV0 = z.object({
  id: stringId,
  status: z.enum(['open', 'resolved']),
  resolved_at: nullableTimestamp,
  created_at: timestamp,
  updated_at: timestamp,
  anchor: CommentAnchorSchemaV0,
  messages: z.array(CommentMessageSchemaV0),
})

export const CommentsListResponseSchemaV0 = z.object({
  artifact_id: stringId,
  share_url: url.nullable().optional(),
  comments: z.array(CommentThreadSchemaV0),
  has_more: z.boolean().optional(),
})

export const CommentPostResponseSchemaV0 = z.object({
  artifact_id: stringId,
  share_url: url.nullable().optional(),
  thread_id: stringId,
  reply: z.boolean(),
  thread: CommentThreadSchemaV0,
})

export const CommentActionResponseSchemaV0 = z.object({
  artifact_id: stringId,
  share_url: url.nullable().optional(),
  thread_id: stringId,
  thread: CommentThreadSchemaV0,
})

export const CommentDeleteResponseSchemaV0 = z.object({
  artifact_id: stringId,
  share_url: url.nullable().optional(),
  thread_id: stringId,
  deleted: z.literal(true),
  thread_deleted: z.boolean(),
  thread: CommentThreadSchemaV0.optional(),
})

export const ArtifactReadResponseSchemaV0 = z.object({
  id: stringId,
  share_url: url,
  version_id: stringId,
  format: z.enum(['html', 'markdown']),
  content: z.string(),
  size_bytes: z.number().nonnegative(),
  truncated: z.boolean(),
  next_offset: z.number().int().nonnegative().nullable(),
  link_expires_at: nullableTimestamp.optional(),
  project_id: stringId.nullable().optional(),
  versions: z.array(ArtifactVersionSchema).optional(),
  versions_has_more: z.boolean().optional(),
  comments: z.array(z.lazy(() => CommentThreadSchemaV0)).optional(),
  comments_has_more: z.boolean().optional(),
})
