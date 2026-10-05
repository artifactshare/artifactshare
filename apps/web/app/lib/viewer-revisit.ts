export type NewCommentMessage = { messageId: string; threadId: string }

export type ViewerRevisitContext = {
  entryCurrentVersionId: string
  version:
    | { kind: 'ordinal'; from: number; to: number }
    | { kind: 'fallback' }
    | null
  commentCount: number
  newCommentMessages: Array<NewCommentMessage>
}
