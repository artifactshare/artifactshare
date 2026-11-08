// The parts of pdf.js the viewer uses. pdf.js is not bundled: the library,
// its worker and its viewer component load at run time from this sandbox
// origin (PDFJS_ASSET_PREFIX), the pinned pdfjs-dist files the sandbox Worker
// serves, so only their shapes are declared here.
import { PDFJS_ASSET_PREFIX } from './paths'

export interface PdfViewport {
  width: number
  height: number
}

export interface PdfRenderTask {
  promise: Promise<void>
  cancel(): void
}

export interface PdfPage {
  getViewport(options: { scale: number }): PdfViewport
  getTextContent(): Promise<{ items: Array<{ str?: unknown }> }>
  render(options: {
    canvas: HTMLCanvasElement
    viewport: PdfViewport
  }): PdfRenderTask
  cleanup(): boolean
}

export interface PdfDocument {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPage>
  getData(): Promise<Uint8Array<ArrayBuffer>>
  getDownloadInfo(): Promise<unknown>
  destroy(): Promise<void>
}

export interface PdfjsLibrary {
  GlobalWorkerOptions: { workerSrc: string }
  getDocument(options: {
    url: string
    isEvalSupported: boolean
    cMapUrl: string
    cMapPacked: boolean
    standardFontDataUrl: string
    wasmUrl: string
    iccUrl: string
  }): { promise: Promise<PdfDocument> }
}

export interface PdfPageView {
  width: number
  height: number
  scale: number
  renderingState: number
}

export interface PdfViewerInstance {
  currentPageNumber: number
  readonly pagesCount: number
  currentScale: number
  currentScaleValue: string
  scrollMode: number
  getPageView(index: number): PdfPageView | undefined
  nextPage(): boolean
  previousPage(): boolean
  setDocument(document: PdfDocument | null): void
}

export type FindMatches = { current: number; total: number }

export interface PdfEvents {
  pagesinit: Record<string, never>
  pagechanging: { pageNumber: number }
  pagesloaded: { pagesCount: number }
  pagerendered: { pageNumber: number; error: unknown }
  updatefindmatchescount: { matchesCount: FindMatches }
  updatefindcontrolstate: {
    state: number
    matchesCount: FindMatches
    rawQuery: unknown
  }
}

export interface PdfEventBus {
  on<K extends keyof PdfEvents>(
    name: K,
    listener: (event: PdfEvents[K]) => void,
  ): void
  dispatch(name: 'find' | 'findbarclose', data: object): void
}

export interface PdfLinkService {
  setViewer(viewer: PdfViewerInstance): void
  setDocument(document: PdfDocument | null): void
}

export interface PdfFindController {
  // pdfjs-dist 5.4.624: a query change is recounted after a short delay;
  // until then counts may still mix the old and new query.
  _dirtyMatch: boolean
  state: { query?: unknown } | null
}

export interface PdfjsViewerModule {
  EventBus: new () => PdfEventBus
  FindState: { NOT_FOUND: number; PENDING: number }
  ScrollMode: { PAGE: number; VERTICAL: number }
  PDFLinkService: new (options: {
    eventBus: PdfEventBus
    externalLinkTarget: number
    externalLinkRel: string
    ignoreDestinationZoom: boolean
  }) => PdfLinkService
  PDFFindController: new (options: {
    eventBus: PdfEventBus
    linkService: PdfLinkService
  }) => PdfFindController
  PDFViewer: new (options: {
    container: HTMLDivElement
    viewer: HTMLDivElement
    eventBus: PdfEventBus
    linkService: PdfLinkService
    findController: PdfFindController
    maxCanvasPixels: number
  }) => PdfViewerInstance
}

// The viewer component reads the library from the global it is given, so
// the library loads first.
export async function loadPdfjs(): Promise<{
  pdfjs: PdfjsLibrary
  viewer: PdfjsViewerModule
}> {
  const pdfjs = (await import(
    /* @vite-ignore */ `${PDFJS_ASSET_PREFIX}pdf.min.mjs`
  )) as PdfjsLibrary
  Object.assign(globalThis, { pdfjsLib: pdfjs })
  const viewer = (await import(
    /* @vite-ignore */ `${PDFJS_ASSET_PREFIX}pdf_viewer.mjs`
  )) as PdfjsViewerModule
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_ASSET_PREFIX}pdf.worker.min.mjs`
  return { pdfjs, viewer }
}
