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
const messageFields = {
  message_id: 'message-a',
  author_name: 'Owner',
  author_email: 'owner@example.com',
  agent: null,
  body: 'Reply',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}
const threadFields = {
  id: 'thread-a',
  message_count: 1,
  reply_count: 0,
  older_cursor: null,
  status: 'open',
  resolved_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  anchor: { kind: 'artifact', quoted_text: null, state: null },
  messages: [messageFields],
}

test('a mutation reports the thread, the changed message and the refresh flag, and nothing else', () => {
  // An unrelated property must not change the reported fields.
  const result = {
    thread,
    changedMessage: message,
    refreshRequired: true,
    deleted: false,
  }
  expect(agentCommentMutationFields(result)).toEqual({
    thread: threadFields,
    changed_message: messageFields,
    refresh_required: true,
  })
  expect(agentCommentMutationFields({ thread })).toEqual({
    thread: threadFields,
  })
  expect(agentCommentMutationFields({ changedMessage: message })).toEqual({
    changed_message: messageFields,
  })
  expect(agentCommentMutationFields({ refreshRequired: true })).toEqual({
    refresh_required: true,
  })
  expect(agentCommentMutationFields({})).toEqual({})
})

test('a deletion reports the surviving thread and omits absent fields', () => {
  expect(agentCommentDeletionFields({ thread, refreshRequired: true })).toEqual(
    { refresh_required: true, thread: threadFields },
  )
  expect(agentCommentDeletionFields({ thread })).toEqual({
    thread: threadFields,
  })
  expect(agentCommentDeletionFields({ refreshRequired: true })).toEqual({
    refresh_required: true,
  })
  expect(agentCommentDeletionFields({})).toEqual({})
})

for (const selectorFormat of ['normalized-v1', 'quote-v1', null] as const) {
  for (const ambiguousAtCreation of [false, true]) {
    for (const positionState of [
      'attached',
      'unchecked',
      'needs-check',
    ] as const) {
      test(`stored metadata survives ${selectorFormat}/${ambiguousAtCreation}/${positionState}`, () => {
        const textThread: CommentThreadView = {
          ...thread,
          subject: {
            kind: 'text',
            quotedText: 'word',
            prefixText: ' a b ',
            suffixText: '',
            versionId: positionState === 'needs-check' ? null : 'v1',
            selectorFormat,
            ambiguousAtCreation,
            positionState,
            state: positionState === 'attached' ? 'attached' : 'orphaned',
            targetPath: '/index.html',
            textStart: 10,
            textEnd: 14,
            cssPath: 'p',
          },
        }
        const expected = {
          kind: 'text',
          quoted_text: 'word',
          quote_before: ' a b ',
          quote_after: '',
          version_id: positionState === 'needs-check' ? null : 'v1',
          target_path: '/index.html',
          state: positionState === 'attached' ? 'attached' : 'orphaned',
          position_state: positionState,
          ...(selectorFormat === 'normalized-v1'
            ? { ambiguous_at_creation: ambiguousAtCreation }
            : {}),
        }
        for (const map of [
          agentCommentMutationFields,
          agentCommentDeletionFields,
        ]) {
          expect(map({ thread: textThread }).thread?.anchor).toStrictEqual(
            expected,
          )
        }
      })
    }
  }
}

test('static-site text anchors return their page location', () => {
  for (const targetPath of [
    '/docs/setup.html',
    '/settings',
    '/index.html#/billing',
  ]) {
    const textThread: CommentThreadView = {
      ...thread,
      subject: {
        kind: 'text',
        quotedText: 'word',
        prefixText: '',
        suffixText: '',
        versionId: 'v1',
        selectorFormat: 'normalized-v1',
        ambiguousAtCreation: false,
        positionState: 'unchecked',
        state: 'orphaned',
        targetPath,
        textStart: 0,
        textEnd: 4,
        cssPath: null,
      },
    }
    expect(
      agentCommentMutationFields({ thread: textThread }).thread?.anchor,
    ).toMatchObject({ kind: 'text', target_path: targetPath })
  }
  // Whole-artifact anchors keep their existing shape.
  expect(agentCommentMutationFields({ thread }).thread?.anchor).toStrictEqual({
    kind: 'artifact',
    quoted_text: null,
    state: null,
  })
})

test('PDF page comments add page and posting version to the artifact anchor', () => {
  const pageThread = (
    versionId: string | null,
    versionNumber: number | null,
  ): CommentThreadView => ({
    ...thread,
    subject: {
      kind: 'pdf-page',
      pageNumber: 12,
      versionId,
      versionNumber,
      canNavigate: false,
      navigableVersionId: null,
    },
  })
  for (const map of [agentCommentMutationFields, agentCommentDeletionFields]) {
    expect(map({ thread: pageThread('v1', 3) }).thread?.anchor).toStrictEqual({
      kind: 'artifact',
      quoted_text: null,
      state: null,
      page_number: 12,
      version_id: 'v1',
      version_number: 3,
    })
    expect(
      map({ thread: pageThread(null, null) }).thread?.anchor,
    ).toStrictEqual({
      kind: 'artifact',
      quoted_text: null,
      state: null,
      page_number: 12,
      version_id: null,
      version_number: null,
    })
  }
})
