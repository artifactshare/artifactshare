import { describe, expect, test, vi } from 'vitest'
import { server } from 'vitest/browser'

// Each scenario starts the sandbox Worker; the feature walks take longer than
// the default on slower engines and CI machines.
vi.setConfig({ testTimeout: 60_000 })

const ALL_NAVIGATION = {
  afterNextButton: 2,
  afterArrowRight: 3,
  afterEnd: 4,
  pastEnd: 4,
  afterArrowLeft: 3,
  afterPreviousButton: 2,
  afterHome: 1,
}

type Layout = NonNullable<
  Awaited<ReturnType<typeof server.commands.pdfViewerScenario>>['initial']
>

// Pages; previous, page number, next; settings, search, download: one row,
// in that order, inside the frame and clear of the app header's collapse
// handle over the frame's top-right corner.
function expectOneToolbarRow(layout: Layout, width: number) {
  const { controls, frameWidth } = layout
  expect(controls.map(({ id }) => id)).toEqual([
    'pages',
    'previous',
    'page-number',
    'next',
    'fit',
    'search-toggle',
    // The narrowest phones leave the download to the page list.
    ...(width > 360 ? ['download'] : []),
  ])
  const middles = controls.map(({ top, height }) => top + height / 2)
  expect(Math.max(...middles) - Math.min(...middles)).toBeLessThanOrEqual(2)
  for (let i = 1; i < controls.length; i++)
    expect(controls[i]!.left).toBeGreaterThanOrEqual(controls[i - 1]!.right - 1)
  expect(layout.pageCountRight).toBeLessThanOrEqual(controls[3]!.left + 1)
  expect(controls[0]!.left).toBeGreaterThanOrEqual(0)
  expect(controls.at(-1)!.right).toBeLessThanOrEqual(frameWidth)
  expect(layout.documentScrollWidth).toBeLessThanOrEqual(frameWidth)
  for (const control of controls)
    expect(
      control.right <= frameWidth - 60 || control.top >= 20,
      JSON.stringify({ control, frameWidth }),
    ).toBe(true)
  if (width < 780) {
    expect(layout.toolbarHeight).toBe(72)
    for (const { width: w, height: h } of controls) {
      expect(w).toBeGreaterThanOrEqual(44)
      expect(h).toBeGreaterThanOrEqual(44)
    }
  } else {
    expect(layout.toolbarHeight).toBeLessThanOrEqual(56)
    // The pager stays centered over the page below it.
    expect(
      Math.abs(layout.pagerCenter - layout.frameWidth / 2),
    ).toBeLessThanOrEqual(4)
  }
}

test('keeps the controls in one row on a 320px phone', async () => {
  const { initial, widened } = await server.commands.pdfViewerScenario(
    'pages',
    320,
  )

  expectOneToolbarRow(initial!, 320)
  // Widening the row brings the download back.
  expectOneToolbarRow(widened!, 1440)
})

// Phone touch targets and the taller row last up to the app's stack
// breakpoint, not only on the narrowest phones.
test('keeps phone-sized touch targets on a 600px frame', async () => {
  const { initial } = await server.commands.pdfViewerScenario('pages', 600)

  expectOneToolbarRow(initial!, 600)
})

describe.each([1440, 390])('PDF viewer at %ipx', (width) => {
  test('opens landscape slides one page at a time fitted to the visible area', async () => {
    const result = await server.commands.pdfViewerScenario('landscape', width)

    expect(result.state).toBe('ready')
    expect(result.mode).toBe('page')
    expect(result.settings).toEqual({ layout: 'page', size: 'page-fit' })
    expect(result.pageCount).toBe('4')
    const { page, container } = result.initial!
    expect(page.width).toBeLessThanOrEqual(container.width)
    expect(page.height).toBeLessThanOrEqual(container.height)
    // Fit: the limiting side fills the visible area up to viewer padding.
    expect(
      Math.max(page.width / container.width, page.height / container.height),
    ).toBeGreaterThan(0.85)
    // The whole slide, viewer padding included, fits without scrolling.
    expect(result.initial!.verticalOverflow).toBe(0)
    expect(result.selection).toContain('Slide page 1')
    expect(result.navigation).toEqual(ALL_NAVIGATION)
    expect(result.atStart).toMatchObject({
      previousDisabled: true,
      nextDisabled: false,
    })
    expect(result.atEnd).toMatchObject({
      previousDisabled: false,
      nextDisabled: true,
    })
    expect(result.afterResize!.pageNumber).toBe(result.beforeResize)
    expect(result.afterResize!.page.width).toBeLessThanOrEqual(
      result.afterResize!.container.width,
    )
    // Download keeps working without the sandbox cookie: it saves the loaded
    // bytes instead of fetching the original again.
    expect(result.download).toEqual({
      name: expect.stringMatching(/\.pdf$/),
      sameBytes: true,
      fetchedOriginal: false,
    })
    // Back/forward caching keeps the rendered document and its download.
    expect(result.afterBackForward!.renderedPages).toBeGreaterThan(0)
    expect(result.afterBackForward!.sameBytes).toBe(true)
    expect(result.afterResize!.page.height).toBeLessThanOrEqual(
      result.afterResize!.container.height,
    )
    expect(result.afterResize!.verticalOverflow).toBe(0)
    expect(result.pdfjsRequests).toEqual(
      expect.arrayContaining([
        `${result.origin}/__as_pdf/pdfjs/pdf.min.mjs`,
        `${result.origin}/__as_pdf/pdfjs/pdf.worker.min.mjs`,
      ]),
    )
    // The sandbox Worker itself served the viewer, pdf.js and the original.
    expect(result.workerStatuses).toEqual(
      expect.arrayContaining([
        '/Synthetic.pdf: 200',
        '/__as_pdf/viewer.js: 200',
        '/__as_pdf/pdfjs/pdf.min.mjs: 200',
        '/__as_pdf/pdfjs/pdf_viewer.mjs: 200',
        '/__as_pdf/pdfjs/pdf.worker.min.mjs: 200',
        expect.stringMatching(/^\/__as_pdf\/original\.pdf: 20[06]$/),
      ]),
    )
    expect(result.offOrigin).toEqual([])
    expect(result.violations).toEqual([])
  })

  test('opens portrait reports as a continuous scroll fitted to width and capped at 100%', async () => {
    const result = await server.commands.pdfViewerScenario('portrait', width)

    expect(result.state).toBe('ready')
    expect(result.mode).toBe('scroll')
    expect(result.settings).toEqual({ layout: 'scroll', size: 'auto' })
    expect(result.scale).toBeLessThanOrEqual(1.001)
    if (width === 1440) expect(result.scale).toBeGreaterThan(0.99)
    else
      expect(result.initial!.page.width).toBeLessThanOrEqual(
        result.initial!.container.width,
      )
    // The first page opens with its top padding, not scrolled under the toolbar.
    expect(result.initial!.scrollTop).toBe(0)
    expect(result.selection).toContain('Report page 1')
    expect(result.navigation).toEqual(ALL_NAVIGATION)
    expect(result.scrolledPage).toBe(3)
    expect(result.afterResize!.pageNumber).toBe(result.beforeResize)
    expect(result.afterResize!.page.width).toBeLessThanOrEqual(
      result.afterResize!.container.width,
    )
    expect(result.offOrigin).toEqual([])
    expect(result.violations).toEqual([])
  })

  test('keeps the controls in one row with phone-sized touch targets', async () => {
    const { initial } = await server.commands.pdfViewerScenario(
      'landscape',
      width,
    )

    expectOneToolbarRow(initial!, width)
  })

  test('opens a page list that marks the current page, draws lazily and closes every way', async () => {
    const result = await server.commands.pdfViewerScenario('pages', width)

    expect(result.state).toBe('ready')
    // A three-digit page count still fits the one row.
    expectOneToolbarRow(result.initial!, width)
    const list = result.pageList!
    expect(list.beforeOpen).toEqual({ items: 0, drawn: [] })
    expect(list.opened).toEqual({
      open: true,
      modal: true,
      heading: 'Pages',
      current: [{ page: 40, marker: 'page', label: 'Go to page 40' }],
      focusedPage: '40',
      currentVisible: true,
      thumbnailWidth: 240,
    })
    expect(list.currentDrawn).toBe(true)
    // Only the items near the visible part of the list are drawn.
    expect(list.afterOpen.items).toBe(100)
    expect(list.afterOpen.drawn).toEqual(expect.arrayContaining([40, 41]))
    expect(list.afterOpen.drawn).not.toContain(1)
    expect(list.afterOpen.drawn).not.toContain(100)
    expect(list.pageAfterArrowRight).toBe(40)
    expect(list.pageAfterArrowLeft).toBe(40)
    // Hiding the viewer cancels a thumbnail being drawn: it stays undrawn
    // for longer than it takes to draw once the viewer is visible again.
    expect(list.slowWhileHidden).toBe(false)
    expect(list.slowResumed).toBe(true)
    expect(list.resumeMs).toBeLessThan(list.hiddenWaitMs)
    // Hidden, the viewer draws nothing new; visible again, it resumes.
    expect(list.whileHidden.drawn).not.toContain(1)
    expect(list.resumed).toBe(true)
    expect(list.lastDrawn).toBe(true)
    const closed = { open: false, focusedId: 'pages' }
    expect(list.afterEscape).toEqual(closed)
    if (width >= 780) expect(list.afterBackdrop).toEqual(closed)
    expect(list.afterCloseButton).toEqual(closed)
    expect(list.chosen).toEqual({ page: 5, marked: '5', ...closed })
    expect(list.download).toEqual({ sameBytes: true, fetchedOriginal: false })
    expect(result.offOrigin).toEqual([])
    expect(result.violations).toEqual([])
  })

  test('searches across pages forwards and backwards and closes cleanly', async () => {
    const result = await server.commands.pdfViewerScenario('search', width)
    const search = result.search!

    expect(search.closed.open).toBe(false)
    expect(search.openedByShortcut).toMatchObject({
      open: true,
      expanded: 'true',
      focusedId: 'search-query',
    })
    // The search bar takes its row from the document area.
    expect(search.openedByShortcut.containerHeight).toBe(
      search.closed.containerHeight - 52,
    )
    expect(search.first).toMatchObject({ results: '1 of 3', page: 2 })
    expect(search.highlighted.highlights).toBeGreaterThan(0)
    expect(search.second).toMatchObject({ results: '2 of 3', page: 4 })
    expect(search.third).toMatchObject({ results: '3 of 3', page: 6 })
    expect(search.back).toMatchObject({ results: '2 of 3', page: 4 })
    expect(search.nextButton).toMatchObject({ results: '3 of 3', page: 6 })
    expect(search.previousButton).toMatchObject({
      results: '2 of 3',
      page: 4,
    })
    expect(search.absent.results).toBe('No results')
    expect(search.emptied).toMatchObject({ results: '', highlights: 0 })
    expect(search.emptiedWhileSearching).toMatchObject({
      results: '',
      highlights: 0,
    })
    expect(search.resumed).toMatchObject({ results: '2 of 3', page: 4 })
    expect(search.closedByEscape).toMatchObject({
      open: false,
      expanded: 'false',
      focusedId: 'search-toggle',
      highlights: 0,
      results: '',
    })
    // Closing ends the search: it reopens with an empty field.
    expect(search.reopened).toMatchObject({
      open: true,
      focusedId: 'search-query',
      query: '',
      results: '',
    })
    expect(search.closedByButton).toMatchObject({
      open: false,
      focusedId: 'search-toggle',
    })
    expect(result.offOrigin).toEqual([])
    expect(result.violations).toEqual([])
  })

  test('changes page layout and size independently and keeps the current page', async () => {
    const result = await server.commands.pdfViewerScenario('settings', width)
    const flow = result.settingsFlow!

    expect(flow.initial).toMatchObject({
      layout: 'page',
      size: 'page-fit',
      page: 3,
      open: false,
      expanded: 'false',
    })
    // Opened by pointer, the menu itself takes focus.
    expect(flow.opened).toMatchObject({
      open: true,
      expanded: 'true',
      focusInSettings: true,
    })
    expect(flow.opened.popover.left).toBeGreaterThanOrEqual(0)
    expect(flow.opened.popover.right).toBeLessThanOrEqual(width)
    expect(flow.scrollLayout).toMatchObject({
      layout: 'scroll',
      mode: 'scroll',
      size: 'page-fit',
      page: 3,
    })
    for (const [size, state] of Object.entries(flow.sizes))
      expect(state, size).toMatchObject({ layout: 'scroll', size, page: 3 })
    // The slide is 960 CSS pixels wide at 100%; pdf.js rounds the page box
    // down to its canvas pixel grid.
    const atScale = (pageWidth: number, scale: number) =>
      expect(Math.abs(pageWidth / (960 * scale) - 1)).toBeLessThan(0.01)
    const { sizes } = flow
    atScale(sizes['1']!.pageWidth, 1)
    atScale(sizes['1.5']!.pageWidth, 1.5)
    atScale(sizes['2']!.pageWidth, 2)
    expect(sizes.auto!.pageWidth).toBeLessThanOrEqual(
      Math.min(961, sizes.auto!.container.width),
    )
    expect(sizes['page-fit']!.pageWidth).toBeLessThanOrEqual(
      sizes['page-fit']!.container.width,
    )
    expect(sizes['page-fit']!.pageHeight).toBeLessThanOrEqual(
      sizes['page-fit']!.container.height,
    )
    // Fit width leaves pdf.js's scrollbar allowance, and has no 100% cap.
    expect(sizes['page-width']!.pageWidth).toBeGreaterThan(
      sizes['page-width']!.container.width * 0.85,
    )
    expect(sizes['page-width']!.pageWidth).toBeLessThanOrEqual(
      sizes['page-width']!.container.width,
    )
    if (width >= 780)
      expect(sizes['page-width']!.pageWidth).toBeGreaterThan(960)
    expect(flow.pageLayout).toMatchObject({
      layout: 'page',
      mode: 'page',
      size: '2',
      page: 3,
    })
    // Resizing and turning pages keep a fixed size.
    expect(flow.afterResize).toMatchObject({ page: 3, size: '2', open: true })
    // The open popover follows the resized frame.
    expect(flow.afterResize.popover.left).toBeGreaterThanOrEqual(0)
    expect(flow.afterResize.popover.right).toBeLessThanOrEqual(
      flow.afterResize.frameWidth,
    )
    atScale(flow.afterResize.pageWidth, 2)
    expect(flow.afterNext).toMatchObject({ page: 4, size: '2' })
    atScale(flow.afterNext.pageWidth, 2)
    expect(flow.afterEscape).toMatchObject({ open: false, focusedId: 'fit' })
    expect(flow.keyboardOpened).toMatchObject({
      open: true,
      focusedCheckedLayout: true,
    })
    expect(flow.keyboardLayout).toMatchObject({
      layout: 'scroll',
      mode: 'scroll',
      size: '2',
      page: 4,
    })
    // The arrow keys continue from the layouts to the sizes.
    expect(flow.keyboardToSize).toBe('auto')
    expect(flow.keyboardEscape).toMatchObject({
      open: false,
      focusedId: 'fit',
    })
    expect(flow.afterOutsideClick.open).toBe(false)
    expect(flow.settingsToSearch).toMatchObject({
      open: false,
      searchOpen: true,
      focusedId: 'search-query',
    })
    expect(flow.shortcutToSearch).toMatchObject({
      open: false,
      searchOpen: true,
      focusedId: 'search-query',
    })
    expect(flow.searchToSettings).toMatchObject({
      open: true,
      searchOpen: false,
      focusInSettings: true,
    })
    expect(flow.settingsToPages).toMatchObject({
      open: false,
      dialogOpen: true,
    })
    expect(flow.searchToPages).toMatchObject({
      searchOpen: false,
      dialogOpen: true,
    })
    expect(flow.pagesClosed).toMatchObject({
      dialogOpen: false,
      focusedId: 'pages',
    })
    // A swipe turns the page only while one page fits the width.
    expect(flow.fittedSwipe).toBe(3)
    expect(flow.zoomed.horizontalOverflow).toBeGreaterThan(0)
    expect(flow.zoomedSwipe).toBe(3)
    expect(flow.continuousSwipe).toBe(3)
    expect(result.offOrigin).toEqual([])
    expect(result.violations).toEqual([])
  })

  test('refits a slide whose size differs from the first page', async () => {
    const result = await server.commands.pdfViewerScenario(
      'mixed-slides',
      width,
    )

    expect(result.mode).toBe('page')
    expect(result.mixedPage).toBe(2)
    const { page, container, verticalOverflow } = result.mixed!
    expect(verticalOverflow).toBe(0)
    expect(page.width).toBeLessThanOrEqual(container.width)
    expect(page.height).toBeLessThanOrEqual(container.height)
    expect(
      Math.max(page.width / container.width, page.height / container.height),
    ).toBeGreaterThan(0.85)
    // In continuous layout, Fit page still refits the taller slide reached.
    const continuous = result.continuousFit!
    expect(continuous.page.width).toBeLessThanOrEqual(
      continuous.container.width,
    )
    expect(continuous.page.height).toBeLessThanOrEqual(
      continuous.container.height,
    )
  })

  test('scales a report so its widest page fits the width', async () => {
    const result = await server.commands.pdfViewerScenario(
      'mixed-report',
      width,
    )

    expect(result.mode).toBe('scroll')
    expect(result.widestPage).toBeLessThanOrEqual(result.mixed!.container.width)
  })
})

test('renders the author font embedded in the PDF with aligned selectable text', async () => {
  const result = await server.commands.pdfViewerScenario('embedded-font', 1440)

  expect(result.state).toBe('ready')
  expect(result.selection).toContain('Embedded')
  // The embedded font draws every letter as a solid box; a substituted
  // font would leave most of the ink box empty.
  const { inkDensity, ink, span } = result.embeddedFont!
  expect(inkDensity).toBeGreaterThan(0.7)
  expect(Math.abs(span.left - ink.left)).toBeLessThanOrEqual(4)
  expect(Math.abs(span.right - ink.right)).toBeLessThanOrEqual(8)
  const inkMiddle = (ink.top + ink.bottom) / 2
  expect(inkMiddle).toBeGreaterThan(span.top)
  expect(inkMiddle).toBeLessThan(span.bottom)
  expect(result.offOrigin).toEqual([])
  expect(result.violations).toEqual([])
})

test.each([820, 961])(
  'keeps the end controls clear of the pager at %ipx',
  async (width) => {
    const { initial } = await server.commands.pdfViewerScenario(
      'landscape',
      width,
    )

    expectOneToolbarRow(initial!, width)
  },
)

describe('PDF search messages', () => {
  test('says a PDF without a text layer has no searchable text', async () => {
    const result = await server.commands.pdfViewerScenario('image-only', 1440)

    expect(result.searchOnce!.results).toBe('This PDF has no searchable text')
  })

  test('keeps the search field usable when the Japanese no-text message shows on a 320px phone', async () => {
    const result = await server.commands.pdfViewerScenario('image-only', 320, {
      app: { locale: 'ja', theme: 'system' },
    })

    expect(result.searchOnce!.results).toBe(
      'このPDFには検索できる文字がありません',
    )
    expect(result.searchOnce!.inputWidth).toBeGreaterThanOrEqual(96)
    expect(result.searchOnce!.barOverflow).toBeLessThanOrEqual(0)
  })

  test('finds text on a later page after a page without text', async () => {
    const result = await server.commands.pdfViewerScenario('late-text', 1440)

    expect(result.searchOnce).toMatchObject({ results: '1 of 1', page: 2 })
  })
})

// The viewer speaks the app's language, set by the reader in the app, not the
// browser's.
describe('PDF viewer in the app language', () => {
  const ja = {
    locale: 'en-US',
    app: { locale: 'ja', theme: 'system' },
  } as const

  test('labels the page list items and fits the row on a phone', async () => {
    const result = await server.commands.pdfViewerScenario('pages', 390, ja)

    expect(result.labels).toEqual({
      lang: 'ja',
      toolbar: 'PDFの操作',
      pages: 'ページ一覧を開く',
      content: 'PDFの内容',
      // The PDF content keeps its own language for text measurement.
      contentLang: '',
    })
    expectOneToolbarRow(result.initial!, 390)
    expect(result.pageList!.opened).toMatchObject({
      heading: 'ページ一覧',
      current: [{ page: 40, marker: 'page', label: '40ページへ移動' }],
    })
  })

  test('shows search counts and messages', async () => {
    const search = (await server.commands.pdfViewerScenario('search', 390, ja))
      .search!
    const imageOnly = await server.commands.pdfViewerScenario(
      'image-only',
      390,
      ja,
    )

    expect(search.first.results).toBe('1 / 3件')
    expect(search.back.results).toBe('2 / 3件')
    expect(search.resumed).toMatchObject({ results: '2 / 3件', page: 4 })
    expect(search.absent.results).toBe('見つかりません')
    expect(imageOnly.searchOnce!.results).toBe(
      'このPDFには検索できる文字がありません',
    )
  })

  test('reports a failure in the app language', async () => {
    const result = await server.commands.pdfViewerScenario('corrupt', 1440, ja)

    expect(result.state).toBe('corrupt')
    expect(result.message).toBe(
      'このPDFは壊れているか、PDFとして読み込めませんでした。',
    )
    expect(result.downloadOffered).toBe(true)
  })

  test('stays in English when the app is English and the browser Japanese', async () => {
    const result = await server.commands.pdfViewerScenario('image-only', 390, {
      locale: 'ja-JP',
      app: { locale: 'en', theme: 'system' },
    })

    expect(result.labels).toMatchObject({
      lang: 'en',
      toolbar: 'PDF controls',
      pages: 'Open the page list',
    })
    expect(result.searchOnce!.results).toBe('This PDF has no searchable text')
  })

  test('opens unframed in the browser language until the app says otherwise', async () => {
    const japanese = await server.commands.pdfViewerScenario(
      'image-only',
      1440,
      {
        locale: 'ja-JP',
      },
    )
    const english = await server.commands.pdfViewerScenario('image-only', 1440)

    expect(japanese.labels).toMatchObject({ lang: 'ja', toolbar: 'PDFの操作' })
    expect(english.labels).toMatchObject({
      lang: 'en',
      toolbar: 'PDF controls',
    })
  })

  test('follows late and changed app preferences without reloading the PDF', async () => {
    const result = await server.commands.pdfViewerScenario(
      'preferences',
      1440,
      { locale: 'ja-JP', colorScheme: 'dark' },
    )
    const flow = result.preferences!
    const light = 'rgb(255, 255, 255)'
    const dark = 'rgb(17, 19, 21)'
    const reading = { page: 3, layout: 'page', sameDocument: true }

    // Before the app's preferences arrive: the browser's language and its
    // dark scheme for the system theme.
    expect(flow.initial).toMatchObject({
      lang: 'ja',
      theme: 'system',
      background: dark,
      ...reading,
    })
    expect(flow.late).toMatchObject({
      lang: 'ja',
      theme: 'light',
      // Native controls follow the app's light theme over the dark browser.
      colorScheme: 'light',
      toolbar: 'PDFの操作',
      background: light,
      contentLang: '',
      ...reading,
    })
    expect(flow.late.renderedPages).toBeGreaterThan(0)
    // The browser now prefers light.
    expect(flow.dark).toMatchObject({
      lang: 'en',
      toolbar: 'PDF controls',
      background: dark,
      ...reading,
    })
    expect(flow.system).toMatchObject({ background: light, ...reading })
    expect(flow.systemChanged).toMatchObject({ background: dark, ...reading })
    // Malformed preferences, and preferences not from the parent, change
    // nothing.
    expect(flow.ignored).toMatchObject({
      lang: 'en',
      theme: 'system',
      ...reading,
    })
    expect(flow.beforeReplacement).toMatchObject({ lang: 'ja', ...reading })
    // A replacement frame is a fresh document with the current preferences.
    expect(flow.replaced).toMatchObject({
      lang: 'ja',
      theme: 'dark',
      toolbar: 'PDFの操作',
      background: dark,
      page: 1,
      layout: 'page',
      size: 'page-fit',
      sameDocument: false,
    })
    expect(result.offOrigin).toEqual([])
    expect(result.violations).toEqual([])
  })
})

describe.each([
  ['page-bridge', 'page'],
  ['page-bridge-report', 'scroll'],
] as const)('PDF page reports in the %s fixture', (scenario, layout) => {
  test(`reports the shown page and opens pages its parent asks for (${layout})`, async () => {
    const result = await server.commands.pdfViewerScenario(scenario, 390, {
      app: { locale: 'en', theme: 'light' },
    })
    const flow = result.pageBridge!
    const ready = (pageNumber: number, token = 'a'.repeat(64)) => ({
      token,
      state: 'ready',
      pageNumber,
      pageCount: 14,
    })
    const unavailable = {
      token: 'a'.repeat(64),
      state: 'unavailable',
      pageNumber: undefined,
      pageCount: undefined,
    }

    expect(flow.layout).toBe(layout)
    expect(flow.beforeSync).toBe(0)
    expect(flow.initial).toEqual(ready(1))
    expect(flow.afterButton).toEqual(ready(2))
    expect(flow.afterKey).toEqual(ready(14))
    expect(flow.afterSearch).toEqual(ready(9))
    if (layout === 'scroll') expect(flow.afterScroll).toEqual(ready(3))
    expect(flow.opened).toEqual({ page: 12, report: ready(12) })
    // Out-of-range, malformed and not-from-the-parent commands do nothing.
    expect(flow.ignored).toEqual({ page: 12, reports: [] })
    expect(flow.failed).toEqual(unavailable)
    expect(flow.whileFailed).toBe(6)
    expect(flow.recovered).toEqual(ready(6))
    // A reloaded document opens at its first page (the viewer keeps no
    // reading position across documents) and reports nothing until it is
    // given its own token.
    expect(flow.reloadedBeforeSync).toEqual([])
    expect(flow.reloaded).toEqual([ready(1, 'b'.repeat(64))])
    expect(result.violations).toEqual([])
  })
})

describe('PDF viewer terminal states', () => {
  test('shows loading, then a reload message when the original cannot be fetched', async () => {
    const result = await server.commands.pdfViewerScenario('transport', 1440)

    expect(result.initialState).toBe('loading')
    expect(result.state).toBe('transport')
    expect(result.message).toMatch(/could not be loaded.*Reload/)
    expect(result.downloadOffered).toBe(false)
  })

  test('says a password-protected PDF cannot be opened here and offers the download', async () => {
    const result = await server.commands.pdfViewerScenario('password', 1440)

    expect(result.state).toBe('password')
    expect(result.message).toMatch(/password-protected.*can’t be opened here/)
    expect(result.downloadOffered).toBe(true)
    expect(result.downloadHref).toBe('/__as_pdf/original.pdf?download=1')
  })

  test('reports a damaged PDF', async () => {
    const result = await server.commands.pdfViewerScenario('corrupt', 1440)

    expect(result.state).toBe('corrupt')
    expect(result.message).toMatch(/damaged/)
    expect(result.downloadOffered).toBe(true)
  })

  test('says a page that cannot be drawn failed, with the download, until a page that drew is shown', async () => {
    const result = await server.commands.pdfViewerScenario('page-failure', 1440)
    const { failed, recovered } = result.pageFailure!

    expect(failed).toEqual({
      state: 'page-error',
      message:
        'This page could not be displayed. Download the original PDF to view it.',
      downloadOffered: true,
      page: 4,
    })
    expect(recovered).toMatchObject({ state: 'ready', page: 1 })
    expect(recovered.statusHidden).toBe(true)
  })

  test('downloads the original while the PDF is still loading without leaving the viewer', async () => {
    const result = await server.commands.pdfViewerScenario(
      'slow-original',
      1440,
    )

    expect(result.earlyDownload).toEqual({
      clickedWhile: 'loading',
      name: 'Synthetic.pdf',
      sameBytes: true,
      stayed: true,
    })
    expect(result.state).toBe('ready')
  })

  test('reports that the PDF cannot be displayed when pdf.js cannot run', async () => {
    const result = await server.commands.pdfViewerScenario('unsupported', 1440)

    expect(result.state).toBe('unsupported')
    expect(result.message).toMatch(/can’t be displayed in this browser/)
    expect(result.downloadOffered).toBe(true)
  })
})
