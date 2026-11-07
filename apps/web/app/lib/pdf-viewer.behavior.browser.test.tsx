import { describe, expect, test } from 'vitest'
import { server } from 'vitest/browser'

const ALL_NAVIGATION = {
  afterNextButton: 2,
  afterArrowRight: 3,
  afterEnd: 4,
  pastEnd: 4,
  afterArrowLeft: 3,
  afterPreviousButton: 2,
  afterHome: 1,
}

describe.each([1440, 390])('PDF viewer at %ipx', (width) => {
  test('opens landscape slides one page at a time fitted to the visible area', async () => {
    const result = await server.commands.pdfViewerScenario('landscape', width)

    expect(result.state).toBe('ready')
    expect(result.mode).toBe('page')
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

    const tops = initial!.controls.map(({ top, height }) => top + height / 2)
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(2)
    expect(initial!.toolbarHeight).toBeLessThanOrEqual(56)
    // The pager stays centered over the page below it.
    expect(
      Math.abs(initial!.pagerCenter - initial!.frameWidth / 2),
    ).toBeLessThanOrEqual(4)
    // The app header's collapse handle covers the frame's top-right corner.
    const { download, frameWidth } = initial!
    expect(
      download.right <= frameWidth - 60 || download.top >= 20,
      JSON.stringify({ download, frameWidth }),
    ).toBe(true)
    if (width < 700)
      for (const { width: w, height: h } of initial!.controls) {
        expect(w).toBeGreaterThanOrEqual(44)
        expect(h).toBeGreaterThanOrEqual(44)
      }
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

  test('reports that the PDF cannot be displayed when pdf.js cannot run', async () => {
    const result = await server.commands.pdfViewerScenario('unsupported', 1440)

    expect(result.state).toBe('unsupported')
    expect(result.message).toMatch(/can’t be displayed in this browser/)
    expect(result.downloadOffered).toBe(true)
  })
})
