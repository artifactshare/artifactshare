import { createContext } from 'react'

// PDF の閲覧中のページを、ビューアのフレームとコメントパネルで共有する。
// フレームは表示中のページを報告し、パネルは新しいコメントにそのページを
// 付け、ページのコメントからそのページを開く。PDF 以外では値がない。
export type PdfCommentPage = { versionId: string; pageNumber: number }

export interface PdfPageBridge {
  /** The page shown on the current version, for a new panel comment. */
  page: PdfCommentPage | null
  /** The frame's report for its version: the page shown, or null for none. */
  onPageChange: (
    versionId: string,
    page: { pageNumber: number; pageCount: number } | null,
  ) => void
  /**
   * A page for the frame to open, on the version the card's navigation was
   * decided for; a new object for every choice.
   */
  openRequest: { pageNumber: number; versionId: string | null } | null
  openPage: (pageNumber: number) => void
}

export const PdfPageContext = createContext<PdfPageBridge | null>(null)

/**
 * The page a new panel comment is placed on: only a page reported for the
 * current version of a PDF, never on a historical view.
 */
export function pdfCommentPage(
  shown: PdfCommentPage | null,
  view: {
    renderType: string | null
    isHistoricalVersion: boolean
    currentVersionId: string | null
  },
): PdfCommentPage | null {
  return view.renderType === 'pdf' &&
    !view.isHistoricalVersion &&
    shown !== null &&
    shown.versionId === view.currentVersionId
    ? shown
    : null
}
