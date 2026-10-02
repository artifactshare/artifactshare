import { expect, test } from 'vitest'
import { hasCommentPosition, type CommentThreadSubject } from './comments'

test('attachment actions require attached state and both resolved endpoints', () => {
  const subject: Extract<CommentThreadSubject, { kind: 'text' }> = {
    kind: 'text',
    state: 'attached',
    quotedText: 'original',
    prefixText: '',
    suffixText: '',
    targetPath: '/index.html',
    versionId: 'v1',
    textStart: 10,
    textEnd: 12,
    cssPath: null,
  }
  expect(hasCommentPosition(subject)).toBe(true)
  for (const state of ['needs-check', 'unresolved'] as const)
    expect(hasCommentPosition({ ...subject, state })).toBe(false)
  expect(hasCommentPosition({ ...subject, textEnd: null })).toBe(false)
  expect(hasCommentPosition({ ...subject, textStart: null })).toBe(false)
  expect(hasCommentPosition({ ...subject, textStart: 12 })).toBe(false)
  expect(hasCommentPosition({ kind: 'artifact' })).toBe(false)
})
