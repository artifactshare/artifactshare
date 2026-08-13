export const MAX_COMMENT_BODY_LENGTH = 4000

export type CommentThreadStatus = 'open' | 'resolved'

export type CommentThreadSubject =
  | { kind: 'artifact' }
  | {
      kind: 'text'
      state: 'attached' | 'orphaned'
      quotedText: string
      prefixText: string
      suffixText: string
      targetPath: string
      versionId: string | null
      textStart: number | null
      textEnd: number | null
      cssPath: string | null
    }

export interface CommentAuthor {
  id: string
  name: string | null
  email: string
  image: string | null
  kind?: 'human' | 'bot'
}

export interface CommentMessageView {
  id: string
  body: string
  agent: string | null
  createdAt: string
  updatedAt: string
  author: CommentAuthor
  canEdit: boolean
  canDelete: boolean
}

export interface CommentThreadView {
  id: string
  status: CommentThreadStatus
  subject: CommentThreadSubject
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  canResolve: boolean
  messages: CommentMessageView[]
}

export function quoteCommentText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return `“${normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized}”`
}

export function commentDeepLinkUrl(baseUrl: string, threadId: string): string {
  const url = new URL(baseUrl)
  url.searchParams.set('comment', threadId)
  return url.toString()
}
