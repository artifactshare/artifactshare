import {
  IconAdjustmentsHorizontal,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconLayoutGrid,
  IconSearch,
  IconX,
} from '@tabler/icons-react'
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { flushSync } from 'react-dom'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { Input } from '~/components/ui/input'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from '~/components/ui/sheet'
import { t, type TKey } from '~/lib/i18n'
import type { PreferencesStore } from './preferences-store'
import {
  offersDownload,
  PAGE_SIZES,
  type PageLayout,
  type PageSize,
  type PdfState,
  type PdfViewerRuntime,
  type SearchMessage,
  type ViewerSnapshot,
} from './runtime'

type ViewerKey = Extract<TKey, `pdfViewer.${string}`>
type Text = (key: ViewerKey, vars?: Record<string, number>) => string
type Surface = 'settings' | 'search' | 'pages' | null
type DownloadHandler = (event: ReactMouseEvent<HTMLAnchorElement>) => void

// Toolbar controls: icon buttons, 44px touch targets on phones.
const CONTROL =
  'h-10 min-w-9 gap-2 px-2.5 max-stack:size-11 max-stack:min-w-11 max-stack:px-0'
const ICON = 'size-4.5'
// Labels next to toolbar icons, shown only where the row has room for them.
const WIDE_LABEL = 'max-wide:hidden'

function isPageLayout(value: string): value is PageLayout {
  return value === 'page' || value === 'scroll'
}

function isPageSize(value: string): value is PageSize {
  return (PAGE_SIZES as readonly string[]).includes(value)
}

function isEditable(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName))
  )
}

// Choosing a display option keeps the menu open, so layout and size can both
// be set; Escape, the button or a click elsewhere closes it.
function keepMenuOpen(event: Event) {
  event.preventDefault()
}

function searchText(text: Text, message: SearchMessage) {
  if (!message) return ''
  if (message.kind === 'matches')
    return text('pdfViewer.matches', {
      current: message.current,
      total: message.total,
    })
  return text(
    message.kind === 'noResults' ? 'pdfViewer.noResults' : 'pdfViewer.noText',
  )
}

function statusText(text: Text, state: PdfState) {
  if (state === 'ready') return ''
  if (state === 'loading') return text('pdfViewer.loading')
  if (state === 'page-error') return text('pdfViewer.pageFailed')
  return text(`pdfViewer.${state}`)
}

// On the narrowest phones the row cannot hold every touch target; the
// download then leaves the row and stays one tap away in the page list. The
// row decides from what it holds, not from a width breakpoint: the pager's
// column is what remains between the start and end controls.
function useDownloadFitsRow(
  pager: RefObject<HTMLDivElement | null>,
  download: RefObject<HTMLAnchorElement | null>,
) {
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const pagerElement = pager.current
    const downloadElement = download.current
    if (!pagerElement || !downloadElement) return
    let downloadWidth = 0
    const measure = () => {
      if (downloadElement.getClientRects().length > 0)
        downloadWidth = downloadElement.getBoundingClientRect().width
      const children = [...pagerElement.children]
      const gap = parseFloat(getComputedStyle(pagerElement).columnGap) || 0
      const needed =
        children.reduce(
          (width, child) => width + child.getBoundingClientRect().width,
          0,
        ) +
        gap * Math.max(0, children.length - 1)
      const spare = pagerElement.clientWidth - needed
      setFits((fitted) =>
        fitted ? spare >= -0.5 : spare >= downloadWidth - 0.5,
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(pagerElement)
    for (const child of pagerElement.children) observer.observe(child)
    return () => observer.disconnect()
  }, [pager, download])
  return fits
}

export function PdfViewerApp({
  runtime,
  preferences,
  fileName,
  downloadHref,
}: {
  runtime: PdfViewerRuntime
  preferences: PreferencesStore
  fileName: string
  downloadHref: string
}) {
  const { locale, theme } = useSyncExternalStore(
    preferences.subscribe,
    preferences.getSnapshot,
  )
  const viewer = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot)
  const text: Text = (key, vars) => t(locale, key, vars)
  const [surface, setSurface] = useState<Surface>(null)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const pageAreaRef = useRef<HTMLDivElement>(null)
  const pagesButtonRef = useRef<HTMLButtonElement>(null)
  const searchToggleRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const { ready, pageCount } = viewer

  // The viewer UI follows the app's language and theme; the PDF content
  // keeps its own language (see the page area below).
  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dataset.theme = theme
  }, [locale, theme])

  useEffect(() => {
    const container = containerRef.current
    const pageArea = pageAreaRef.current
    if (!container || !pageArea) return
    void runtime.start(container, pageArea)
    return () => runtime.stop()
  }, [runtime])

  // Only one surface is open at a time: opening one closes any other it
  // would overlap. Closing the search ends it.
  const changeSurface = (next: Surface) => {
    runtime.setSearchOpen(next === 'search')
    runtime.setSettingsOpen(next === 'settings')
    if (next !== 'search') setQuery('')
    setSurface(next)
  }

  const openSearch = () => {
    flushSync(() => changeSurface('search'))
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }

  const closeSearch = (returnFocus: boolean) => {
    flushSync(() => changeSurface(null))
    if (returnFocus) searchToggleRef.current?.focus()
  }

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target
    // Keys that confirm or cancel text being composed (Japanese input)
    // belong to the input method.
    if (event.isComposing || event.keyCode === 229) return
    if (
      event.key === 'Escape' &&
      target instanceof Element &&
      target.closest('#search-bar')
    ) {
      event.preventDefault()
      closeSearch(true)
      return
    }
    // Ctrl/Cmd+F inside the viewer opens its own search.
    if (
      ready &&
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      (/^[a-z]$/i.test(event.key)
        ? event.key.toLowerCase() === 'f'
        : event.code === 'KeyF') &&
      surface !== 'pages'
    ) {
      event.preventDefault()
      openSearch()
      return
    }
    if (
      !ready ||
      surface === 'pages' ||
      surface === 'settings' ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (target instanceof Element &&
        target.closest('#search-bar, [role="menu"]')) ||
      isEditable(target)
    )
      return
    if (event.key === 'ArrowRight' || event.key === 'PageDown')
      runtime.nextPage()
    else if (event.key === 'ArrowLeft' || event.key === 'PageUp')
      runtime.previousPage()
    else if (event.key === 'Home') runtime.goTo(1)
    else if (event.key === 'End') runtime.goTo(pageCount)
    else return
    event.preventDefault()
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event)
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [])

  const download: DownloadHandler = (event) =>
    runtime.download(event, event.currentTarget)

  return (
    <div className="bg-muted text-foreground fixed inset-0 flex flex-col overflow-hidden">
      <Toolbar
        runtime={runtime}
        viewer={viewer}
        text={text}
        surface={surface}
        fileName={fileName}
        downloadHref={downloadHref}
        pagesButtonRef={pagesButtonRef}
        searchToggleRef={searchToggleRef}
        onSurface={changeSurface}
        onSearch={() =>
          surface === 'search' ? closeSearch(true) : openSearch()
        }
        onDownload={download}
      />
      <SearchBar
        runtime={runtime}
        open={surface === 'search'}
        query={query}
        message={viewer.search}
        text={text}
        inputRef={searchInputRef}
        onQuery={setQuery}
        onClose={() => closeSearch(true)}
      />
      <div className="relative min-h-0 flex-1">
        {/* pdf.js owns everything inside the page area. The content has no
            language unless the PDF declares one (pdf.js then sets it on the
            page area, and clears it there for each document, hence the
            container): pdf.js measures selectable text in that language and
            Firefox picks fallback fonts by language, so inheriting the UI
            language would misalign the text layer. */}
        <div
          ref={containerRef}
          id="viewer-container"
          lang=""
          // A scrollable region the keyboard can reach and page through.
          tabIndex={0}
          aria-label={text('pdfViewer.content')}
          className="focus-visible:outline-ring absolute inset-0 overflow-auto overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          <div ref={pageAreaRef} id="viewer" className="pdfViewer" />
        </div>
      </div>
      <Status state={viewer.state} text={text}>
        <Button asChild variant="link" className="min-h-11 px-0">
          <a
            id="status-download"
            href={downloadHref}
            download={fileName}
            hidden={!offersDownload(viewer.state)}
          >
            {text('pdfViewer.downloadOriginal')}
          </a>
        </Button>
      </Status>
      <PagesSheet
        runtime={runtime}
        open={surface === 'pages'}
        page={viewer.page}
        pageCount={pageCount}
        text={text}
        fileName={fileName}
        downloadHref={downloadHref}
        pagesButtonRef={pagesButtonRef}
        onOpenChange={(open) => changeSurface(open ? 'pages' : null)}
        onChoose={(chosen) => {
          runtime.goTo(chosen)
          changeSurface(null)
        }}
        onDownload={download}
      />
    </div>
  )
}

// One row of controls: the page list, the pager in the middle, then the
// display settings, search and download. The app header's collapse handle
// overlaps the frame's top-right corner, so the controls stay clear of it:
// beside it on wider frames, below it on phones.
function Toolbar({
  runtime,
  viewer,
  text,
  surface,
  fileName,
  downloadHref,
  pagesButtonRef,
  searchToggleRef,
  onSurface,
  onSearch,
  onDownload,
}: {
  runtime: PdfViewerRuntime
  viewer: ViewerSnapshot
  text: Text
  surface: Surface
  fileName: string
  downloadHref: string
  pagesButtonRef: RefObject<HTMLButtonElement | null>
  searchToggleRef: RefObject<HTMLButtonElement | null>
  onSurface: (surface: Surface) => void
  onSearch: () => void
  onDownload: DownloadHandler
}) {
  const { ready, page, pageCount, layout, size } = viewer
  const [pageDraft, setPageDraft] = useState<string | null>(null)
  const pagerRef = useRef<HTMLDivElement>(null)
  const downloadRef = useRef<HTMLAnchorElement>(null)
  const downloadFits = useDownloadFitsRow(pagerRef, downloadRef)
  const commitPage = () => {
    if (pageDraft !== null) runtime.goTo(Number(pageDraft))
    setPageDraft(null)
  }
  return (
    <header
      id="pdf-toolbar"
      aria-label={text('pdfViewer.toolbar')}
      className="bg-background max-stack:h-18 max-stack:grid-cols-[auto_minmax(0,1fr)_auto] max-stack:gap-0 max-stack:px-2 max-stack:pt-6 max-stack:pb-1 relative z-3 grid h-13 shrink-0 grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)] items-center gap-3 border-b px-16 py-1.5"
    >
      <div className="max-stack:gap-0 flex min-w-0 items-center gap-1">
        <Button
          ref={pagesButtonRef}
          id="pages"
          variant="ghost"
          className={CONTROL}
          aria-label={text('pdfViewer.openPages')}
          aria-haspopup="dialog"
          disabled={!ready}
          onClick={() => onSurface('pages')}
        >
          <IconLayoutGrid className={ICON} aria-hidden="true" />
          <span className={WIDE_LABEL}>{text('pdfViewer.pages')}</span>
        </Button>
      </div>
      <div
        ref={pagerRef}
        className="max-stack:gap-0 flex min-w-0 items-center justify-center gap-1"
      >
        <Button
          id="previous"
          variant="ghost"
          className={CONTROL}
          aria-label={text('pdfViewer.previous')}
          disabled={!ready || page <= 1}
          onClick={() => runtime.previousPage()}
        >
          <IconChevronLeft className={ICON} aria-hidden="true" />
        </Button>
        <label className="text-muted-foreground max-stack:gap-0.5 flex items-center gap-1 text-sm whitespace-nowrap tabular-nums">
          <Input
            id="page-number"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            aria-label={text('pdfViewer.pageNumber')}
            disabled={!ready}
            value={pageDraft ?? String(page)}
            onChange={(event) => setPageDraft(event.target.value)}
            onBlur={commitPage}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              commitPage()
              event.currentTarget.blur()
            }}
            className="text-foreground hover:bg-accent max-stack:size-11 max-stack:text-base h-9 w-10 rounded-md border-0 px-0.5 text-center text-sm shadow-none disabled:bg-transparent"
          />
          <span aria-hidden="true">/</span>
          <output id="page-count">{pageCount || '–'}</output>
        </label>
        <Button
          id="next"
          variant="ghost"
          className={CONTROL}
          aria-label={text('pdfViewer.next')}
          disabled={!ready || page >= pageCount}
          onClick={() => runtime.nextPage()}
        >
          <IconChevronRight className={ICON} aria-hidden="true" />
        </Button>
      </div>
      <div className="max-stack:gap-0 flex min-w-0 items-center justify-end gap-1">
        <DisplaySettings
          open={surface === 'settings'}
          onOpenChange={(open) => onSurface(open ? 'settings' : null)}
          disabled={!ready}
          layout={layout}
          size={size}
          text={text}
          onLayout={(value) => runtime.setLayout(value)}
          onSize={(value) => runtime.setSize(value)}
        />
        <Button
          ref={searchToggleRef}
          id="search-toggle"
          variant="ghost"
          className={CONTROL}
          aria-label={text('pdfViewer.search')}
          aria-expanded={surface === 'search'}
          aria-controls="search-bar"
          disabled={!ready}
          onClick={onSearch}
        >
          <IconSearch className={ICON} aria-hidden="true" />
        </Button>
        <Button asChild variant="ghost" className={CONTROL}>
          <a
            ref={downloadRef}
            id="download"
            href={downloadHref}
            download={fileName}
            aria-label={text('pdfViewer.download')}
            hidden={!downloadFits}
            onClick={onDownload}
          >
            <IconDownload className={ICON} aria-hidden="true" />
            <span className={WIDE_LABEL}>
              {text('pdfViewer.downloadShort')}
            </span>
          </a>
        </Button>
      </div>
    </header>
  )
}

// The search bar sits below the control row and the document area shrinks.
// On phones a long message wraps and the bar grows to hold it.
function SearchBar({
  runtime,
  open,
  query,
  message,
  text,
  inputRef,
  onQuery,
  onClose,
}: {
  runtime: PdfViewerRuntime
  open: boolean
  query: string
  message: SearchMessage
  text: Text
  inputRef: RefObject<HTMLInputElement | null>
  onQuery: (query: string) => void
  onClose: () => void
}) {
  const searchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (
      event.key !== 'Enter' ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return
    event.preventDefault()
    runtime.find(query, 'again', event.shiftKey)
  }
  return (
    <search
      id="search-bar"
      hidden={!open}
      className="bg-background max-stack:h-auto max-stack:min-h-13 max-stack:gap-0 max-stack:px-2 max-stack:py-0 relative z-3 flex h-13 shrink-0 items-center justify-end gap-2 border-b px-16 py-1"
    >
      <Input
        ref={inputRef}
        id="search-query"
        type="search"
        autoComplete="off"
        aria-label={text('pdfViewer.searchQuery')}
        placeholder={text('pdfViewer.search')}
        value={query}
        onChange={(event) => {
          onQuery(event.target.value)
          // Text being composed (Japanese input) is searched once it is
          // confirmed.
          const native = event.nativeEvent
          if (!(native instanceof InputEvent && native.isComposing))
            runtime.find(event.target.value, '', false)
        }}
        onCompositionEnd={(event) =>
          runtime.find(event.currentTarget.value, '', false)
        }
        onKeyDown={searchKeyDown}
        className="max-stack:w-0 max-stack:min-w-24 max-stack:flex-1 max-stack:text-base h-9 w-65 shrink text-sm"
      />
      <output
        id="search-results"
        aria-live="polite"
        className="text-muted-foreground max-stack:min-w-0 max-stack:px-1 max-stack:leading-tight max-stack:whitespace-normal text-xs whitespace-nowrap"
      >
        {searchText(text, message)}
      </output>
      <Button
        id="search-previous"
        variant="ghost"
        className={CONTROL}
        aria-label={text('pdfViewer.searchPrevious')}
        onClick={() => runtime.find(query, 'again', true)}
      >
        <IconChevronLeft className={ICON} aria-hidden="true" />
      </Button>
      <Button
        id="search-next"
        variant="ghost"
        className={CONTROL}
        aria-label={text('pdfViewer.searchNext')}
        onClick={() => runtime.find(query, 'again', false)}
      >
        <IconChevronRight className={ICON} aria-hidden="true" />
      </Button>
      <Button
        id="search-close"
        variant="ghost"
        className={CONTROL}
        aria-label={text('pdfViewer.searchClose')}
        onClick={onClose}
      >
        <IconX className={ICON} aria-hidden="true" />
      </Button>
    </search>
  )
}

function Status({
  state,
  text,
  children,
}: {
  state: PdfState
  text: Text
  children: ReactNode
}) {
  return (
    <div
      id="status"
      role="status"
      aria-live="polite"
      hidden={state === 'ready'}
      className="pointer-events-none fixed inset-0 flex items-center justify-center"
    >
      <div className="text-muted-foreground pointer-events-auto w-4/5 max-w-105 text-center text-sm leading-normal">
        <p id="status-message" className="mb-2">
          {statusText(text, state)}
        </p>
        {children}
      </div>
    </div>
  )
}

function DisplaySettings({
  open,
  onOpenChange,
  disabled,
  layout,
  size,
  text,
  onLayout,
  onSize,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  disabled: boolean
  layout: PageLayout
  size: PageSize
  text: Text
  onLayout: (layout: PageLayout) => void
  onSize: (size: PageSize) => void
}) {
  const sizeLabels: Record<PageSize, string> = {
    auto: text('pdfViewer.sizeAuto'),
    'page-fit': text('pdfViewer.sizePage'),
    'page-width': text('pdfViewer.sizeWidth'),
    '1': '100%',
    '1.5': '150%',
    '2': '200%',
  }
  const item = 'min-h-9 max-stack:min-h-11'
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          id="fit"
          variant="ghost"
          className={CONTROL}
          aria-label={text('pdfViewer.openSettings')}
        >
          <IconAdjustmentsHorizontal className={ICON} aria-hidden="true" />
          <span className={WIDE_LABEL}>{text('pdfViewer.settings')}</span>
          <IconChevronDown
            className={`text-muted-foreground size-3 ${WIDE_LABEL}`}
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={8}
        data-pdf-settings=""
        aria-labelledby={undefined}
        aria-label={text('pdfViewer.settings')}
        className="w-61 p-2"
      >
        <DropdownMenuLabel>{text('pdfViewer.layout')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={layout}
          onValueChange={(value) => {
            if (isPageLayout(value)) onLayout(value)
          }}
        >
          <DropdownMenuRadioItem
            value="page"
            data-layout="page"
            className={item}
            onSelect={keepMenuOpen}
          >
            {text('pdfViewer.layoutPage')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="scroll"
            data-layout="scroll"
            className={item}
            onSelect={keepMenuOpen}
          >
            {text('pdfViewer.layoutScroll')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{text('pdfViewer.size')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={size}
          onValueChange={(value) => {
            if (isPageSize(value)) onSize(value)
          }}
        >
          {PAGE_SIZES.map((option) => (
            <DropdownMenuRadioItem
              key={option}
              value={option}
              data-size={option}
              className={item}
              onSelect={keepMenuOpen}
            >
              {sizeLabels[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// The page list opens from the side, over the pages; on phones it covers
// the frame. It opens at the current page and returns focus to its button.
function PagesSheet({
  runtime,
  open,
  page,
  pageCount,
  text,
  fileName,
  downloadHref,
  pagesButtonRef,
  onOpenChange,
  onChoose,
  onDownload,
}: {
  runtime: PdfViewerRuntime
  open: boolean
  page: number
  pageCount: number
  text: Text
  fileName: string
  downloadHref: string
  pagesButtonRef: RefObject<HTMLButtonElement | null>
  onOpenChange: (open: boolean) => void
  onChoose: (page: number) => void
  onDownload: DownloadHandler
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-pdf-pages=""
        aria-describedby={undefined}
        className="max-stack:w-full max-stack:border-l-0 w-80 max-w-full gap-0 p-0"
        onOpenAutoFocus={(event) => {
          const content = event.currentTarget
          const current =
            content instanceof HTMLElement
              ? content.querySelector<HTMLElement>('[aria-current="page"]')
              : null
          if (!current) return
          event.preventDefault()
          current.focus()
          current.scrollIntoView({ block: 'center' })
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          pagesButtonRef.current?.focus()
        }}
      >
        {/* Clear of the app header's collapse handle over the frame's
            top-right corner. */}
        <div className="flex shrink-0 items-center justify-between gap-4 px-4 pt-5 pb-2">
          <SheetTitle className="text-base">
            {text('pdfViewer.pages')}
          </SheetTitle>
          <SheetClose asChild>
            <Button
              id="pages-close"
              variant="ghost"
              className={CONTROL}
              aria-label={text('pdfViewer.closePages')}
            >
              <IconX className={ICON} aria-hidden="true" />
            </Button>
          </SheetClose>
        </div>
        <PageList
          runtime={runtime}
          page={page}
          pageCount={pageCount}
          text={text}
          onChoose={onChoose}
        />
        <footer className="shrink-0 border-t px-4 py-2">
          <Button
            asChild
            variant="ghost"
            className="text-muted-foreground min-h-11 w-full justify-start gap-2 px-0 hover:bg-transparent"
          >
            <a
              id="pages-download"
              href={downloadHref}
              download={fileName}
              onClick={onDownload}
            >
              <IconDownload className={ICON} aria-hidden="true" />
              {text('pdfViewer.download')}
            </a>
          </Button>
        </footer>
      </SheetContent>
    </Sheet>
  )
}

function PageList({
  runtime,
  page,
  pageCount,
  text,
  onChoose,
}: {
  runtime: PdfViewerRuntime
  page: number
  pageCount: number
  text: Text
  onChoose: (page: number) => void
}) {
  const listRef = useRef<HTMLElement>(null)
  // The runtime draws thumbnails into each item's first child while the
  // list is open.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    runtime.openPageList(list)
    return () => runtime.closePageList()
  }, [runtime])
  return (
    <nav
      ref={listRef}
      id="page-list"
      aria-label={text('pdfViewer.choosePage')}
      className="max-stack:gap-4 grid min-h-0 flex-1 auto-rows-max grid-cols-2 content-start gap-3 overflow-auto overscroll-contain px-4 pt-3 pb-5"
    >
      {Array.from({ length: pageCount }, (_, index) => index + 1).map((n) => (
        <Button
          key={n}
          variant="ghost"
          data-page={n}
          aria-label={text('pdfViewer.goToPage', { n })}
          aria-current={n === page ? 'page' : undefined}
          onClick={() => onChoose(n)}
          className="aria-[current=page]:border-link aria-[current=page]:bg-link-soft aria-[current=page]:text-link h-auto min-h-18 flex-col items-stretch justify-start gap-1.5 p-1.5 transition-colors motion-reduce:transition-none"
        >
          <span className="bg-muted block min-h-16 shrink-0 shadow-xs [&_canvas]:block [&_canvas]:h-auto [&_canvas]:w-full" />
          <span className="text-center text-xs tabular-nums">{n}</span>
        </Button>
      ))}
    </nav>
  )
}
