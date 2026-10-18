import { expect, test, vi } from 'vitest'
import { probeExportPdfBoundary } from './export-pdf-browser-command'

vi.mock('@vitest/browser-playwright', () => ({
  defineBrowserCommand: (command: unknown) => command,
}))

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
