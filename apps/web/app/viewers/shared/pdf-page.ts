// The PDF viewer and the app exchange the page being read. The app gives each
// viewer document that answered its ready check a fresh sync token; the
// viewer reports its current page with that token (validated in the app by
// isSandboxMessage), so a report from an earlier document in the same frame
// never matches. The app asks it to open a page. Like the preferences message,
// the parent messages carry no access decision: the viewer accepts them from
// its parent window alone, ignores anything malformed, and opens only a page
// its document has.

// Matches MAX_PDF_PAGE_COUNT in the sandbox message validator.
export const MAX_PDF_PAGE = 100_000

const REPORT_SOURCE = 'artifactshare'
const REPORT_KIND = 'pdf-page-changed'
const COMMAND_SOURCE = 'artifactshare-parent'
const COMMAND_KIND = 'pdf-open-page'
const SYNC_KIND = 'pdf-page-sync'

function isPage(value: unknown, max = MAX_PDF_PAGE): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= max
  )
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/** The report for a viewer snapshot. Only a shown page is ever reported. */
export function pdfPageReport(
  snapshot: {
    state: string
    ready: boolean
    page: number
    pageCount: number
  },
  token: string,
) {
  if (
    snapshot.state === 'ready' &&
    snapshot.ready &&
    isPage(snapshot.pageCount) &&
    isPage(snapshot.page, snapshot.pageCount)
  )
    return {
      source: REPORT_SOURCE,
      kind: REPORT_KIND,
      token,
      state: 'ready',
      pageNumber: snapshot.page,
      pageCount: snapshot.pageCount,
    } as const
  return {
    source: REPORT_SOURCE,
    kind: REPORT_KIND,
    token,
    state: 'unavailable',
  } as const
}

export function pdfPageSyncMessage(token: string) {
  return { source: COMMAND_SOURCE, kind: SYNC_KIND, token } as const
}

export function parsePdfPageSyncMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const message = data as Record<string, unknown>
  if (message.source !== COMMAND_SOURCE || message.kind !== SYNC_KIND)
    return null
  if (Object.keys(message).length !== 3 || !isToken(message.token)) return null
  return message.token
}

export function pdfOpenPageMessage(pageNumber: number) {
  return { source: COMMAND_SOURCE, kind: COMMAND_KIND, pageNumber } as const
}

export function parsePdfOpenPageMessage(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null
  const message = data as Record<string, unknown>
  if (message.source !== COMMAND_SOURCE || message.kind !== COMMAND_KIND)
    return null
  if (Object.keys(message).length !== 3 || !isPage(message.pageNumber))
    return null
  return message.pageNumber
}
