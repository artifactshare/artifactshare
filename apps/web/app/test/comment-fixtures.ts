import type { CommentThreadView } from '~/lib/comments'

const timestamp = '2026-05-01T00:00:00.000Z'
export function commentFixture(id: string, body = id): CommentThreadView {
  return {
    id,
    status: 'open',
    subject: { kind: 'artifact' },
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: null,
    canResolve: true,
    messageCount: 1,
    replyCount: 0,
    olderCursor: null,
    messages: [
      {
        id: `${id}-message`,
        body,
        createdAt: timestamp,
        updatedAt: timestamp,
        agent: null,
        canEdit: true,
        canDelete: true,
        author: {
          id: 'reviewer',
          name: 'Reviewer',
          email: 'reviewer@example.com',
          image: null,
        },
      },
    ],
  }
}
