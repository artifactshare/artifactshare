import { PDF_ORIGINAL_PATH, PDFJS_ASSET_PREFIX } from './paths'
import {
  loadPdfjs,
  type FindMatches,
  type PdfDocument,
  type PdfEventBus,
  type PdfFindController,
  type PdfjsViewerModule,
  type PdfRenderTask,
  type PdfViewerInstance,
} from './pdfjs'

// The viewer's document state. 'page-error' is a page that failed to render
// while it is the current page; the others before 'ready' are terminal.
export type PdfState =
  | 'loading'
  | 'ready'
  | 'page-error'
  | 'password'
  | 'corrupt'
  | 'transport'
  | 'unsupported'

export type PageLayout = 'page' | 'scroll'
export const PAGE_SIZES = [
  'auto',
  'page-fit',
  'page-width',
  '1',
  '1.5',
  '2',
] as const
export type PageSize = (typeof PAGE_SIZES)[number]

export type SearchMessage =
  | { kind: 'matches'; current: number; total: number }
  | { kind: 'noResults' }
  | { kind: 'noText' }
  | null

export type FindType = '' | 'again'

export interface ViewerSnapshot {
  state: PdfState
  // pdf.js has laid out the pages, so the controls can act on them.
  ready: boolean
  page: number
  pageCount: number
  // Display settings live only in memory, chosen from page 1 at load.
  layout: PageLayout
  size: PageSize
  search: SearchMessage
}

// Terminal states other than a lost connection keep the original download.
export function offersDownload(state: PdfState): boolean {
  return state !== 'loading' && state !== 'ready' && state !== 'transport'
}

function failureState(error: unknown): PdfState {
  const name =
    error && typeof error === 'object' && 'name' in error ? error.name : ''
  if (name === 'PasswordException') return 'password'
  if (name === 'InvalidPDFException') return 'corrupt'
  if (
    name === 'ResponseException' ||
    name === 'MissingPDFException' ||
    name === 'UnexpectedResponseException' ||
    (error instanceof TypeError && /fetch|network/i.test(String(error.message)))
  )
    return 'transport'
  return 'unsupported'
}

const THUMBNAIL_WIDTH = 240

// Runs pdf.js for one viewer document: it owns the page area (the container
// pdf.js renders into), the loaded PDF and the page-list thumbnails, and
// publishes the state the React controls render. The document's root keeps
// data-pdf-state, and the body data-mode and data-size, so the stylesheet
// and pdf.js measurements follow the current layout synchronously.
export class PdfViewerRuntime {
  #snapshot: ViewerSnapshot = {
    state: 'loading',
    ready: false,
    page: 1,
    pageCount: 0,
    layout: 'page',
    size: 'page-fit',
    search: null,
  }
  readonly #listeners = new Set<() => void>()
  readonly #cleanups: Array<() => void> = []
  #stopped = false
  #container: HTMLDivElement | null = null
  #pageArea: HTMLDivElement | null = null
  #viewer: PdfViewerInstance | null = null
  #eventBus: PdfEventBus | null = null
  #findController: PdfFindController | null = null
  #scrollMode: PdfjsViewerModule['ScrollMode'] | null = null
  #document: PdfDocument | null = null
  #downloadable: PdfDocument | null = null
  #settingsOpen = false
  #searchOpen = false
  #searchQuery = ''
  #searchableText: Promise<boolean> | null = null
  readonly #failedPages = new Set<number>()
  #touchStart: { x: number; y: number } | null = null
  // Page list thumbnails, kept across openings of the list.
  #list: HTMLElement | null = null
  #thumbnailObserver: IntersectionObserver | null = null
  readonly #thumbnailCanvases = new Map<number, HTMLCanvasElement>()
  readonly #thumbnailsVisible = new Set<number>()
  readonly #thumbnailsDone = new Set<number>()
  readonly #thumbnailsDrawn = new Set<number>()
  #thumbnailTask: PdfRenderTask | null = null
  #thumbnailsRunning = false
  #pageShown = true

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  #update(patch: Partial<ViewerSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch }
    if (patch.state) document.documentElement.dataset.pdfState = patch.state
    if (patch.layout) document.body.dataset.mode = patch.layout
    if (patch.size) document.body.dataset.size = patch.size
    for (const listener of this.#listeners) listener()
  }

  #listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (event: WindowEventMap[K]) => void,
  ): void
  #listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
  ): void
  #listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void
  #listen(
    target: EventTarget,
    type: string,
    listener: (event: never) => void,
    options?: AddEventListenerOptions,
  ) {
    const handler = listener as EventListener
    target.addEventListener(type, handler, options)
    this.#cleanups.push(() => target.removeEventListener(type, handler))
  }

  // Loads pdf.js and the original into the given container. Landscape pages
  // open one at a time fitted to the visible area, portrait pages as a
  // vertical scroll fitted to width and capped at 100%.
  async start(container: HTMLDivElement, pageArea: HTMLDivElement) {
    this.#container = container
    this.#pageArea = pageArea
    this.#update({ layout: 'page', size: 'page-fit' })
    let library: Awaited<ReturnType<typeof loadPdfjs>>
    try {
      library = await loadPdfjs()
    } catch (error) {
      console.error(error)
      this.#update({ state: 'unsupported' })
      return
    }
    if (this.#stopped) return
    const { pdfjs, viewer: viewerModule } = library
    const {
      EventBus,
      FindState,
      PDFLinkService,
      PDFViewer,
      PDFFindController,
    } = viewerModule
    const eventBus = new EventBus()
    const linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: 2,
      externalLinkRel: 'noopener noreferrer',
      ignoreDestinationZoom: true,
    })
    const findController = new PDFFindController({ eventBus, linkService })
    const viewer = new PDFViewer({
      container,
      viewer: pageArea,
      eventBus,
      linkService,
      findController,
      maxCanvasPixels: 16000000,
    })
    linkService.setViewer(viewer)
    this.#eventBus = eventBus
    this.#findController = findController
    this.#viewer = viewer
    this.#scrollMode = viewerModule.ScrollMode

    eventBus.on('pagesinit', () => {
      this.#update({ ready: true, pageCount: viewer.pagesCount })
      this.#fit()
      this.#keepTopAtLoad()
      this.#sync()
    })
    eventBus.on('pagechanging', () => {
      this.#sync()
      this.#showPageState()
      const { size, layout } = this.#snapshot
      if (size === 'page-fit' && layout === 'page')
        queueMicrotask(() => this.#fit())
    })
    // Every page's own size is known only once all pages have loaded.
    eventBus.on('pagesloaded', () => {
      this.#fit()
      this.#keepTopAtLoad()
    })
    // A page that failed to render shows its message only while it is the
    // current page; rendering it, or moving to a page that rendered, clears
    // it. The loading message stays until a page has actually rendered.
    eventBus.on('pagerendered', ({ pageNumber, error }) => {
      if (error) this.#failedPages.add(pageNumber)
      else this.#failedPages.delete(pageNumber)
      if (!error && this.#snapshot.state === 'loading')
        this.#update({ state: 'ready' })
      this.#showPageState()
    })
    eventBus.on('updatefindmatchescount', ({ matchesCount }) =>
      this.#showMatches(matchesCount),
    )
    eventBus.on(
      'updatefindcontrolstate',
      ({ state, matchesCount, rawQuery }) => {
        if (!this.#searchOpen || rawQuery !== this.#searchQuery) return
        if (state === FindState.NOT_FOUND && !findController._dirtyMatch) {
          void this.#hasSearchableText().then((found) => {
            if (this.#searchOpen && rawQuery === this.#searchQuery)
              this.#update({
                search: { kind: found ? 'noResults' : 'noText' },
              })
          })
        } else if (state !== FindState.PENDING) this.#showMatches(matchesCount)
      },
    )

    this.#listenForSwipes(container)
    const resizeObserver = new ResizeObserver(() => this.#fit())
    resizeObserver.observe(container)
    this.#cleanups.push(() => resizeObserver.disconnect())
    this.#listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.#drawThumbnails()
      else this.#pauseThumbnails()
    })
    this.#listen(window, 'pageshow', () => {
      this.#pageShown = true
      void this.#drawThumbnails()
    })

    try {
      const pdf = await pdfjs.getDocument({
        url: PDF_ORIGINAL_PATH,
        isEvalSupported: false,
        cMapUrl: `${PDFJS_ASSET_PREFIX}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_ASSET_PREFIX}standard_fonts/`,
        wasmUrl: `${PDFJS_ASSET_PREFIX}wasm/`,
        iccUrl: `${PDFJS_ASSET_PREFIX}iccs/`,
      }).promise
      if (this.#stopped) {
        void pdf.destroy()
        return
      }
      // Saved from memory only once pdf.js holds the whole file.
      pdf.getDownloadInfo().then(
        () => {
          if (!this.#stopped) this.#downloadable = pdf
        },
        () => {},
      )
      const first = await pdf.getPage(1)
      const viewport = first.getViewport({ scale: 1 })
      const slides = viewport.width > viewport.height
      this.#update({
        layout: slides ? 'page' : 'scroll',
        size: slides ? 'page-fit' : 'auto',
      })
      viewer.scrollMode = slides
        ? viewerModule.ScrollMode.PAGE
        : viewerModule.ScrollMode.VERTICAL
      this.#document = pdf
      viewer.setDocument(pdf)
      linkService.setDocument(pdf)
      // A page kept for back/forward navigation keeps its document, so it
      // shows the PDF again when restored; only a real unload releases it.
      this.#listen(window, 'pagehide', (event) => {
        this.#pageShown = false
        this.#pauseThumbnails()
        if (event.persisted) return
        this.#release()
      })
    } catch (error) {
      console.error(error)
      this.#update({ state: failureState(error) })
    }
  }

  stop() {
    this.#stopped = true
    this.#pauseThumbnails()
    for (const cleanup of this.#cleanups.splice(0)) cleanup()
    this.#release()
  }

  #release() {
    this.#thumbnailObserver?.disconnect()
    this.#thumbnailObserver = null
    const pdf = this.#document
    this.#downloadable = null
    this.#document = null
    if (!pdf) return
    this.#viewer?.setDocument(null)
    void pdf.destroy()
  }

  #sync() {
    const viewer = this.#viewer
    if (viewer) this.#update({ page: viewer.currentPageNumber })
  }

  // 'page-fit' fits the page being shown in one-page layout, so each page
  // change refits it; in continuous layout one scale fits every page, so
  // scrolling across pages of different sizes never changes the scale.
  // pdf.js 'page-fit' ignores the viewer padding, so the page is fitted to
  // the container minus that padding and never makes the area scroll. Width
  // fits use one scale for all pages, chosen so the widest page fits the
  // width; automatic caps it at 100%. Fixed sizes are kept as set.
  #fit() {
    const viewer = this.#viewer
    const container = this.#container
    const pageArea = this.#pageArea
    if (!this.#snapshot.ready || !viewer || !container || !pageArea) return
    const { size, layout } = this.#snapshot
    if (size === 'page-fit') {
      const padding = getComputedStyle(pageArea)
      const availableWidth =
        container.clientWidth -
        parseFloat(padding.paddingLeft) -
        parseFloat(padding.paddingRight) -
        1
      const availableHeight =
        container.clientHeight -
        parseFloat(padding.paddingTop) -
        parseFloat(padding.paddingBottom) -
        1
      const pageFit = (view: {
        width: number
        height: number
        scale: number
      }) =>
        Math.min(
          (availableWidth * view.scale) / view.width,
          (availableHeight * view.scale) / view.height,
        )
      let scale = Infinity
      if (layout === 'page') {
        const view = viewer.getPageView(viewer.currentPageNumber - 1)
        if (!view) return
        scale = pageFit(view)
      } else {
        for (let index = 0; index < viewer.pagesCount; index++) {
          const view = viewer.getPageView(index)
          if (view) scale = Math.min(scale, pageFit(view))
        }
      }
      if (
        scale > 0 &&
        scale !== Infinity &&
        Math.abs(scale - viewer.currentScale) > 0.0001
      )
        viewer.currentScale = scale
      return
    }
    if (size !== 'auto' && size !== 'page-width') {
      const scale = Number(size)
      if (Math.abs(scale - viewer.currentScale) > 0.0001)
        viewer.currentScale = scale
      return
    }
    viewer.currentScaleValue = 'page-width'
    const unscaledWidth = (index: number) => {
      const view = viewer.getPageView(index)
      return view ? view.width / view.scale : 0
    }
    let widest = 0
    for (let index = 0; index < viewer.pagesCount; index++)
      widest = Math.max(widest, unscaledWidth(index))
    const current = unscaledWidth(viewer.currentPageNumber - 1)
    if (!widest || !current) return
    let scale = (viewer.currentScale * current) / widest
    if (size === 'auto') scale = Math.min(scale, 1)
    if (scale !== viewer.currentScale) viewer.currentScale = scale
  }

  // Setting the scale can scroll the report away from its top padding;
  // until the reader moves, the first page keeps its designed top gap.
  #keepTopAtLoad() {
    if (
      this.#snapshot.layout === 'scroll' &&
      this.#viewer?.currentPageNumber === 1 &&
      this.#container
    )
      this.#container.scrollTop = 0
  }

  #showPageState() {
    const viewer = this.#viewer
    if (!viewer) return
    if (this.#failedPages.has(viewer.currentPageNumber)) {
      this.#update({ state: 'page-error' })
      return
    }
    if (this.#snapshot.state === 'page-error') this.#update({ state: 'ready' })
  }

  nextPage() {
    this.#viewer?.nextPage()
  }

  previousPage() {
    this.#viewer?.previousPage()
  }

  goTo(page: number) {
    const viewer = this.#viewer
    if (
      viewer &&
      this.#snapshot.ready &&
      Number.isInteger(page) &&
      page >= 1 &&
      page <= viewer.pagesCount
    )
      viewer.currentPageNumber = page
    this.#sync()
  }

  // A change of layout or size keeps the page being read.
  setLayout(layout: PageLayout) {
    this.#update({ layout })
    this.#applySettings()
  }

  setSize(size: PageSize) {
    this.#update({ size })
    this.#applySettings()
  }

  #applySettings() {
    const viewer = this.#viewer
    const scrollMode = this.#scrollMode
    if (!viewer || !scrollMode) return
    const page = viewer.currentPageNumber
    viewer.scrollMode =
      this.#snapshot.layout === 'page' ? scrollMode.PAGE : scrollMode.VERTICAL
    this.#fit()
    viewer.currentPageNumber = page
    this.#sync()
  }

  // While the display settings are open a swipe does not turn pages.
  setSettingsOpen(open: boolean) {
    this.#settingsOpen = open
  }

  // Swiping turns pages only one page at a time and while the page fits the
  // width; zoomed wider, a swipe pans the page instead.
  #listenForSwipes(container: HTMLDivElement) {
    const passive = { passive: true }
    this.#listen(
      container,
      'touchstart',
      (event) => {
        const touch = event.touches[0]
        this.#touchStart =
          event.touches.length === 1 && touch
            ? { x: touch.clientX, y: touch.clientY }
            : null
      },
      passive,
    )
    this.#listen(
      container,
      'touchend',
      (event) => {
        const touch = event.changedTouches[0]
        const start = this.#touchStart
        this.#touchStart = null
        if (
          !start ||
          !touch ||
          this.#settingsOpen ||
          this.#snapshot.layout !== 'page' ||
          container.scrollWidth > container.clientWidth + 2
        )
          return
        const dx = touch.clientX - start.x
        const dy = touch.clientY - start.y
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx < 0) this.#viewer?.nextPage()
          else this.#viewer?.previousPage()
        }
      },
      passive,
    )
    this.#listen(
      container,
      'touchcancel',
      () => {
        this.#touchStart = null
      },
      passive,
    )
  }

  // Search with pdf.js's find controller. Whether the PDF has any text at
  // all is checked once, page by page until the first text, so that a
  // scanned PDF says so instead of reporting no results.
  #hasSearchableText() {
    const pdf = this.#document
    this.#searchableText ??= (async () => {
      if (!pdf) return true
      for (let n = 1; n <= pdf.numPages; n++) {
        const content = await (await pdf.getPage(n)).getTextContent()
        if (
          content.items.some(
            (item) => typeof item.str === 'string' && item.str.trim(),
          )
        )
          return true
      }
      return false
    })().catch(() => true)
    return this.#searchableText
  }

  setSearchOpen(open: boolean) {
    if (open === this.#searchOpen) return
    this.#searchOpen = open
    this.#searchQuery = ''
    this.#update({ search: null })
    // Closing ends the search, so reopening starts from an empty field.
    if (!open) this.#eventBus?.dispatch('findbarclose', { source: this })
  }

  // An emptied query replaces the old one in the controller, so late counts
  // for the old query are recognised as stale. A new query never shows the
  // previous query's count or message.
  find(rawQuery: string, type: FindType, findPrevious: boolean) {
    this.#searchQuery = rawQuery
    const query = rawQuery.trim() ? rawQuery : ''
    if (!query || type === '') this.#update({ search: null })
    else void this.#hasSearchableText()
    this.#eventBus?.dispatch('find', {
      source: this,
      type: query ? type : '',
      query,
      highlightAll: true,
      caseSensitive: false,
      entireWord: false,
      findPrevious,
      matchDiacritics: false,
    })
  }

  // After the query changes, pdf.js waits briefly before recounting and
  // until then may add new-query counts to the old total; its pending
  // recount marks counts as not yet valid.
  #showMatches({ current, total }: FindMatches) {
    if (
      this.#searchOpen &&
      !this.#findController?._dirtyMatch &&
      this.#searchQuery.trim() &&
      this.#findController?.state?.query === this.#searchQuery &&
      total > 0 &&
      current > 0
    )
      this.#update({ search: { kind: 'matches', current, total } })
  }

  // Download serves the bytes pdf.js already holds, so it keeps working
  // after the sandbox's short-lived cookie expires during long reading.
  // Only once the whole file is in memory: until then the link itself still
  // works, and waiting for the rest could expire the click.
  download(event: { preventDefault(): void }, link: HTMLAnchorElement) {
    const pdf = this.#downloadable
    if (!pdf) return
    event.preventDefault()
    const name = link.getAttribute('download') || 'document.pdf'
    const href = link.href
    const save = (url: string) => {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    }
    pdf.getData().then(
      (bytes) => {
        const url = URL.createObjectURL(
          new Blob([bytes], { type: 'application/pdf' }),
        )
        save(url)
        setTimeout(() => URL.revokeObjectURL(url), 60000)
      },
      // Like the link itself: a download, never a navigation of the viewer.
      () => save(href),
    )
  }

  // The page list's aspect ratio for a page before its thumbnail is drawn.
  #pageAspectRatio(page: number): string | undefined {
    const view = this.#viewer?.getPageView(page - 1)
    return view ? `${view.width} / ${view.height}` : undefined
  }

  // Page list. Thumbnails are drawn only while the list is open and the
  // viewer page is visible, one at a time, for the items near the visible
  // part of the list, closest to the current page first. Each item's first
  // child holds the thumbnail canvas, which the runtime owns and keeps for
  // the next opening.
  openPageList(list: HTMLElement) {
    this.#list = list
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page)
          if (entry.isIntersecting) this.#thumbnailsVisible.add(page)
          else this.#thumbnailsVisible.delete(page)
        }
        void this.#drawThumbnails()
      },
      { root: list, rootMargin: '400px 0px' },
    )
    this.#thumbnailObserver = observer
    for (const item of list.querySelectorAll<HTMLElement>('[data-page]')) {
      const page = Number(item.dataset.page)
      const slot = item.firstElementChild as HTMLElement | null
      if (!slot) continue
      let canvas = this.#thumbnailCanvases.get(page)
      if (!canvas) {
        canvas = document.createElement('canvas')
        this.#thumbnailCanvases.set(page, canvas)
      }
      slot.replaceChildren(canvas)
      // A blank canvas has a default size, not the page's.
      slot.style.aspectRatio = this.#thumbnailsDrawn.has(page)
        ? `${canvas.width} / ${canvas.height}`
        : (this.#pageAspectRatio(page) ?? '')
      if (this.#thumbnailsDrawn.has(page)) item.dataset.rendered = 'true'
      observer.observe(item)
    }
    void this.#drawThumbnails()
  }

  closePageList() {
    this.#pauseThumbnails()
    this.#thumbnailObserver?.disconnect()
    this.#thumbnailObserver = null
    this.#thumbnailsVisible.clear()
    this.#list = null
  }

  #thumbnailsActive() {
    return (
      this.#list !== null &&
      this.#pageShown &&
      document.visibilityState === 'visible' &&
      this.#document !== null
    )
  }

  #nextThumbnail() {
    const current = this.#viewer?.currentPageNumber ?? 1
    let best = 0
    for (const page of this.#thumbnailsVisible)
      if (
        !this.#thumbnailsDone.has(page) &&
        (!best || Math.abs(page - current) < Math.abs(best - current))
      )
        best = page
    return best
  }

  async #drawThumbnails() {
    if (this.#thumbnailsRunning) return
    this.#thumbnailsRunning = true
    try {
      while (this.#thumbnailsActive()) {
        const n = this.#nextThumbnail()
        const pdf = this.#document
        const canvas = this.#thumbnailCanvases.get(n)
        if (!n || !pdf || !canvas) break
        try {
          // One thumbnail at a time, chosen again after each: the visible
          // items and the current page change while drawing.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          const page = await pdf.getPage(n)
          if (!this.#thumbnailsActive()) break
          const viewport = page.getViewport({
            scale: THUMBNAIL_WIDTH / page.getViewport({ scale: 1 }).width,
          })
          canvas.width = Math.round(viewport.width)
          canvas.height = Math.round(viewport.height)
          if (canvas.parentElement)
            canvas.parentElement.style.aspectRatio = `${canvas.width} / ${canvas.height}`
          const task = page.render({ canvas, viewport })
          this.#thumbnailTask = task
          await task.promise
          this.#thumbnailsDone.add(n)
          this.#thumbnailsDrawn.add(n)
          const item = canvas.parentElement?.parentElement
          if (item) item.dataset.rendered = 'true'
          // Releases what the thumbnail needed, unless the viewer has drawn
          // or is drawing this page and would need it again.
          if (!this.#viewer?.getPageView(n - 1)?.renderingState) page.cleanup()
        } catch (error) {
          // A cancelled thumbnail is drawn again later; one that failed, in
          // loading its page or in drawing it, stays blank and is not retried.
          const cancelled =
            !!error &&
            typeof error === 'object' &&
            'name' in error &&
            error.name === 'RenderingCancelledException'
          if (!cancelled) {
            if (error) console.error(error)
            this.#thumbnailsDone.add(n)
          }
        } finally {
          this.#thumbnailTask = null
        }
      }
    } finally {
      this.#thumbnailsRunning = false
    }
    if (this.#thumbnailsActive() && this.#nextThumbnail())
      void this.#drawThumbnails()
  }

  #pauseThumbnails() {
    this.#thumbnailTask?.cancel()
  }
}
