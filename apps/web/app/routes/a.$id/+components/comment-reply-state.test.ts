import { describe, expect, test } from 'vitest'
import {
  commentReplyReducer,
  createCommentReplyState,
} from './comment-reply-state'

describe('commentReplyReducer', () => {
  test('starts with no active reply or drafts', () => {
    expect(createCommentReplyState()).toEqual({
      activeThreadId: null,
      drafts: {},
    })
  })

  test('keeps drafts while switching and cancelling', () => {
    let state = createCommentReplyState()
    state = commentReplyReducer(state, { type: 'open', threadId: 'a' })
    state = commentReplyReducer(state, {
      type: 'change',
      threadId: 'a',
      value: 'draft',
    })
    state = commentReplyReducer(state, { type: 'open', threadId: 'b' })
    state = commentReplyReducer(state, {
      type: 'change',
      threadId: 'b',
      value: 'other',
    })
    state = commentReplyReducer(state, { type: 'cancel' })
    expect(state).toEqual({
      activeThreadId: null,
      drafts: { a: 'draft', b: 'other' },
    })
  })

  test('keeps a failed reply draft', () => {
    let state = commentReplyReducer(createCommentReplyState(), {
      type: 'open',
      threadId: 'a',
    })
    state = commentReplyReducer(state, {
      type: 'change',
      threadId: 'a',
      value: 'draft',
    })
    state = commentReplyReducer(state, {
      type: 'settled',
      threadId: 'a',
      submittedBody: 'draft',
      success: false,
    })
    expect(state.drafts.a).toBe('draft')
  })

  test('clears only the successful reply draft', () => {
    let state = commentReplyReducer(createCommentReplyState(), {
      type: 'open',
      threadId: 'a',
    })
    state = commentReplyReducer(state, {
      type: 'change',
      threadId: 'a',
      value: 'draft',
    })
    state = commentReplyReducer(state, {
      type: 'change',
      threadId: 'b',
      value: 'other',
    })
    state = commentReplyReducer(state, {
      type: 'settled',
      threadId: 'a',
      submittedBody: 'draft',
      success: true,
    })
    expect(state.drafts).toEqual({ b: 'other' })
  })

  test('does not close another composer or clear a newer draft when a reply settles', () => {
    let state = commentReplyReducer(createCommentReplyState(), {
      type: 'open',
      threadId: 'a',
    })
    state = commentReplyReducer(state, {
      type: 'change',
      threadId: 'a',
      value: 'submitted',
    })
    state = commentReplyReducer(state, { type: 'open', threadId: 'b' })
    state = commentReplyReducer(state, {
      type: 'change',
      threadId: 'a',
      value: 'newer draft',
    })
    state = commentReplyReducer(state, {
      type: 'settled',
      threadId: 'a',
      submittedBody: 'submitted',
      success: true,
    })

    expect(state).toEqual({
      activeThreadId: 'b',
      drafts: { a: 'newer draft' },
    })
  })

  test('keeps the same composer open when its draft changed during submission', () => {
    let state = commentReplyReducer(createCommentReplyState(), {
      type: 'open',
      threadId: 'a',
    })
    state = commentReplyReducer(state, {
      type: 'change',
      threadId: 'a',
      value: 'newer draft',
    })
    state = commentReplyReducer(state, {
      type: 'settled',
      threadId: 'a',
      submittedBody: 'submitted',
      success: true,
    })

    expect(state).toEqual({
      activeThreadId: 'a',
      drafts: { a: 'newer draft' },
    })
  })
})
