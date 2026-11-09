export const MAX_COMMENT_BODY_LENGTH = 4000

export type CommentThreadStatus = 'open' | 'resolved'

// Unknown-count bound for PDF page numbers: versions keep no page count, so
// the server accepts any page up to this; the viewer enforces the real count.
export const MAX_PDF_PAGE_NUMBER = 100_000

export function isPdfPageNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_PDF_PAGE_NUMBER
  )
}

export type CommentThreadSubject =
  | { kind: 'artifact' }
  | {
      // A PDF comment on the page open when it was posted. versionId is the
      // posting version (null once deleted); canNavigate is true only when
      // that page can be opened in the displayed version.
      kind: 'pdf-page'
      pageNumber: number
      versionId: string | null
      versionNumber: number | null
      canNavigate: boolean
    }
  | {
      kind: 'text'
      locus?: { headings: string[]; block_text: string }
      state: 'attached' | 'orphaned'
      checking?: boolean
      positionState?: 'attached' | 'needs-check' | 'unchecked'
      selectorFormat?: 'normalized-v1' | 'quote-v1' | null
      textHash?: string | null
      ambiguousAtCreation?: boolean
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
  messageCount: number
  replyCount: number
  olderCursor: string | null
  /** Client-only latest server window, excluding disjoint around-page rows. */
  latestReplyIds?: string[]
  /** Client-only bounded page requests retained for revalidation. */
  loadedPages?: Array<{
    through?: string
    before?: string
    aroundMessageId?: string
    limit?: number
    /** Lower tuple of the retained interval; refreshes may need continuation pages. */
    coverageStart?: string | null
  }>
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
