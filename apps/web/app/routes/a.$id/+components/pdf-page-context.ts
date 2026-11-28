import { createContext } from 'react'

export type PdfCommentPage = { versionId: string; pageNumber: number }

export interface PdfPageBridge {
  page: PdfCommentPage | null
  onPageChange: (
    versionId: string,
    page: { pageNumber: number; pageCount: number } | null,
  ) => void
  openRequest: { pageNumber: number; versionId: string | null } | null
  displayedVersionId: string | null
  openPage: (pageNumber: number, versionId: string) => void
}

export const PdfPageContext = createContext<PdfPageBridge | null>(null)

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
