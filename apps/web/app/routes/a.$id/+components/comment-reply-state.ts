export interface CommentReplyState {
  activeThreadId: string | null
  drafts: Readonly<Record<string, string>>
}
export type CommentReplyAction =
  | { type: 'open'; threadId: string }
  | { type: 'change'; threadId: string; value: string }
  | { type: 'cancel' }
  | {
      type: 'settled'
      threadId: string
      submittedBody: string
      success: boolean
    }
export function createCommentReplyState(): CommentReplyState {
  return { activeThreadId: null, drafts: {} }
}
export function commentReplyReducer(
  state: CommentReplyState,
  action: CommentReplyAction,
): CommentReplyState {
  switch (action.type) {
    case 'open':
      return { ...state, activeThreadId: action.threadId }
    case 'change':
      return {
        ...state,
        drafts: { ...state.drafts, [action.threadId]: action.value },
      }
    case 'cancel':
      return { ...state, activeThreadId: null }
    case 'settled':
      if (!action.success) return state
      return {
        activeThreadId:
          state.activeThreadId === action.threadId &&
          state.drafts[action.threadId] === action.submittedBody
            ? null
            : state.activeThreadId,
        drafts:
          state.drafts[action.threadId] === action.submittedBody
            ? Object.fromEntries(
                Object.entries(state.drafts).filter(
                  ([id]) => id !== action.threadId,
                ),
              )
            : state.drafts,
      }
  }
}
