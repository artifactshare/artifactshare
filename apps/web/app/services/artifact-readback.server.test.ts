import { expect, test, vi } from 'vitest'
import type { CommentThreadView } from '~/lib/comments'
import {
  agentCommentDeletionFields,
  agentCommentMutationFields,
} from './artifact-readback.server'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const message = {
  id: 'message-a',
  body: 'Reply',
  author: {
    id: 'owner',
    name: 'Owner',
    email: 'owner@example.com',
    image: null,
  },
  agent: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  canEdit: true,
  canDelete: true,
}
const thread: CommentThreadView = {
  id: 'thread-a',
  messageCount: 1,
  replyCount: 0,
  olderCursor: null,
  status: 'open',
  resolvedAt: null,
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
  subject: { kind: 'artifact' },
  messages: [message],
  canResolve: true,
}
const messageJson =
  '{"message_id":"message-a","author_name":"Owner","author_email":"owner@example.com","agent":null,"body":"Reply","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}'
const threadJson =
  '{"id":"thread-a","message_count":1,"reply_count":0,"older_cursor":null,"status":"open","resolved_at":null,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","anchor":{"kind":"artifact","quoted_text":null,"state":null},"messages":[' +
  messageJson +
  ']}'

test('ordinary mutation serialization retains field order and changed messages regardless of unrelated properties', () => {
  const result = {
    thread,
    changedMessage: message,
    refreshRequired: true,
    deleted: false,
  }
  expect(JSON.stringify(agentCommentMutationFields(result))).toBe(
    `{"thread":${threadJson},"changed_message":${messageJson},"refresh_required":true}`,
  )
  expect(JSON.stringify(agentCommentMutationFields({ thread }))).toBe(
    `{"thread":${threadJson}}`,
  )
  expect(
    JSON.stringify(agentCommentMutationFields({ changedMessage: message })),
  ).toBe(`{"changed_message":${messageJson}}`)
  expect(
    JSON.stringify(agentCommentMutationFields({ refreshRequired: true })),
  ).toBe('{"refresh_required":true}')
  expect(JSON.stringify(agentCommentMutationFields({}))).toBe('{}')
})

test('deletion serialization preserves refresh then surviving thread and omitted fields', () => {
  expect(
    JSON.stringify(
      agentCommentDeletionFields({ thread, refreshRequired: true }),
    ),
  ).toBe(`{"refresh_required":true,"thread":${threadJson}}`)
  expect(JSON.stringify(agentCommentDeletionFields({ thread }))).toBe(
    `{"thread":${threadJson}}`,
  )
  expect(
    JSON.stringify(agentCommentDeletionFields({ refreshRequired: true })),
  ).toBe('{"refresh_required":true}')
  expect(JSON.stringify(agentCommentDeletionFields({}))).toBe('{}')
})
