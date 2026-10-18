import { expect, test, vi } from 'vitest'
import {
  exportPdfObservation,
  probeExportPdfBoundary,
} from './export-pdf-browser-command'

vi.mock('@vitest/browser-playwright', () => ({
  defineBrowserCommand: (command: unknown) => command,
}))

test('negative control bounds navigation waits and closes its page on failure', async () => {
  const failure = new Error('Navigation deadline')
  const click = vi.fn().mockResolvedValue(undefined)
  const unsafe = {
    waitForResponse: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockRejectedValue(failure),
    locator: vi.fn().mockReturnValue({ click }),
    close: vi.fn().mockResolvedValue(undefined),
  }
  const context = {
    newPage: async () => unsafe,
    route: vi.fn().mockResolvedValue(undefined),
    unroute: vi.fn().mockResolvedValue(undefined),
  }
  await expect(
    exportPdfObservation(
      {
        page: {
          context: () => context,
          url: () => 'http://localhost/',
        },
      } as unknown as Parameters<typeof exportPdfObservation>[0],
      'negative',
    ),
  ).rejects.toBe(failure)
  expect(unsafe.waitForResponse).toHaveBeenCalledWith(
    'http://localhost/__pdf_probe_csp_image',
    { timeout: 5000 },
  )
  expect(unsafe.goto).toHaveBeenCalledWith('http://localhost/__pdf_negative', {
    timeout: 5000,
  })
  expect(unsafe.waitForURL).toHaveBeenCalledWith('**/__pdf_probe_negative', {
    timeout: 5000,
  })
  expect(click).toHaveBeenCalledWith({ timeout: 5000 })
  expect(unsafe.close).toHaveBeenCalledOnce()
  expect(context.unroute).toHaveBeenCalledWith('**/__pdf_negative')
})

test('boundary probe observes navigation rejection before a failed evaluate', async () => {
  let rejectNavigation!: (error: Error) => void
  const navigation = new Promise<never>((_resolve, reject) => {
    rejectNavigation = reject
  })
  const observe = vi.spyOn(navigation, 'catch')
  const failure = new Error('Popup navigated during evaluate')
  const mainFrame = {}
  const frame = { parentFrame: () => mainFrame }
  let observedBeforeEvaluate = false
  const popup = {
    mainFrame: () => mainFrame,
    frames: () => [frame],
    waitForEvent: vi.fn(() => navigation),
    evaluate: vi.fn(async () => {
      observedBeforeEvaluate = observe.mock.calls.length > 0
      throw failure
    }),
  }
  const context = {
    page: {
      context: () => ({ pages: () => [popup] }),
      url: () => 'http://localhost/',
    },
  } as unknown as Parameters<typeof probeExportPdfBoundary>[0]
  await expect(probeExportPdfBoundary(context)).rejects.toBe(failure)
  // Keep the regression itself safe on an unfixed implementation, then reject
  // the independent deadline after evaluate has already failed.
  void navigation.catch(() => {})
  rejectNavigation(new Error('Navigation deadline'))
  await expect(navigation).rejects.toThrow('Navigation deadline')
  expect(observedBeforeEvaluate).toBe(true)
  expect(popup.waitForEvent).toHaveBeenCalledWith('framenavigated', {
    predicate: expect.any(Function),
    timeout: 5000,
  })
})

test('image rendering inspection samples automation screenshots rather than an opaque SVG canvas', async () => {
  const { inspectExportPdf } = await import('./export-pdf-browser-command')
  const mainFrame = {}
  const screenshot = vi.fn().mockResolvedValue(Buffer.from('rendered PNG'))
  const clip = { x: 24, y: 96, width: 100, height: 100 }
  const elementScreenshot = vi.fn(() => {
    throw new Error('Opaque child must not be scrolled for inspection')
  })
  const frame = {
    parentFrame: () => mainFrame,
    evaluate: vi.fn().mockResolvedValue({ imageLoaded: true }),
    locator: vi.fn().mockReturnValue({
      all: async () => [
        {
          boundingBox: async () => clip,
          screenshot: elementScreenshot,
        },
      ],
    }),
  }
  const popup = {
    mainFrame: () => mainFrame,
    frames: () => [frame],
    screenshot,
  }
  const context = {
    page: { context: () => ({ pages: () => [popup] }) },
  } as unknown as Parameters<typeof inspectExportPdf>[0]
  const inspected = await inspectExportPdf(context, false, undefined, true)
  expect(inspected.imageScreenshots).toEqual([
    Buffer.from('rendered PNG').toString('base64'),
  ])
  expect(screenshot).toHaveBeenCalledWith({ clip, timeout: 5000 })
  expect(elementScreenshot).not.toHaveBeenCalled()
  expect(frame.evaluate.mock.calls[0][0].toString()).not.toContain(
    'getImageData',
  )
})

test('stalled request header observation fails with a deadline and still releases the session', async () => {
  vi.useFakeTimers()
  let observe!: (request: unknown) => void
  const context = {
    on: vi.fn((event, listener) => {
      if (event === 'request') observe = listener
    }),
    off: vi.fn(),
    addCookies: vi.fn(),
    clearCookies: vi.fn(),
    route: vi.fn(),
    unroute: vi.fn(),
    request: {
      get: vi.fn(async () => ({ ok: () => true, json: async () => [] })),
      delete: vi.fn(),
    },
  }
  const command = {
    page: { context: () => context, url: () => 'http://localhost/' },
  } as unknown as Parameters<typeof exportPdfObservation>[0]
  try {
    await exportPdfObservation(command, 'start', {})
    observe({
      url: () => 'http://localhost/__pdf_probe_pending',
      method: () => 'GET',
      allHeaders: () => new Promise(() => {}),
    })
    const stopped = exportPdfObservation(command, 'stop')
    const rejected = expect(stopped).rejects.toThrow(
      'PDF request header deadline exceeded',
    )
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(context.off).toHaveBeenCalledWith('request', observe)
    expect(context.unroute).toHaveBeenCalledTimes(4)
    expect(context.clearCookies).toHaveBeenCalledTimes(3)
    expect(context.request.delete).toHaveBeenCalledWith(
      expect.stringContaining('/__pdf_receipts?id='),
      { timeout: 5000 },
    )
    expect(vi.getTimerCount()).toBe(0)
    // The failed session must not keep blocking later inspection/cleanup.
    await expect(exportPdfObservation(command, 'read')).resolves.toEqual([])
  } finally {
    vi.useRealTimers()
  }
})
