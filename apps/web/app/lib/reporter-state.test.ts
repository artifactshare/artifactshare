// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { createReporterState } from '../../../../packages/viewer-kit/src/reporter/state.js'
import { installReporter } from '../../../../packages/viewer-kit/src/reporter/install.js'

afterEach(() => vi.restoreAllMocks())

test('reporter modules have no import-time DOM or listener side effects', async () => {
  vi.resetModules()
  const create = vi.spyOn(document, 'createElement')
  const documentListener = vi.spyOn(document, 'addEventListener')
  const windowListener = vi.spyOn(window, 'addEventListener')
  const timer = vi.spyOn(window, 'setInterval')
  await import('../../../../packages/viewer-kit/src/reporter/install.js')
  expect(create).not.toHaveBeenCalled()
  expect(documentListener).not.toHaveBeenCalled()
  expect(windowListener).not.toHaveBeenCalled()
  expect(timer).not.toHaveBeenCalled()
})

test('top-level installation remains a no-op before capture or state creation', () => {
  const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor')
  const listener = vi.spyOn(window, 'addEventListener')
  const interval = vi.spyOn(window, 'setInterval')
  descriptor.mockClear()
  expect(installReporter(window)).toBeUndefined()
  expect(descriptor).not.toHaveBeenCalled()
  expect(listener).not.toHaveBeenCalled()
  expect(interval).not.toHaveBeenCalled()
})

test('every reporter state owns its mutable collections and generations', () => {
  const first = createReporterState(window)
  const second = createReporterState(window)
  first.pendingHighlights.push({ threadId: 'first', quotedText: 'quote' })
  first.pendingAnchors.push({
    kind: 'text',
    thread: 'first',
    quotedText: 'quote',
  })
  first.highlightNames.push('first')
  first.checkingDeadlines.first = 100
  first.badgeOffsets.first = { x: 1, y: 2 }
  first.svgActiveThreads.first = true
  first.commentLabels.openOne = 'Changed'
  first.reusableBadges.set('first', document.createElement('button'))
  const click = new Event('click')
  first.pendingLinkClicks.set(click, {
    artifactPrevented: true,
    href: 'https://example.com',
    openExternally: true,
  })
  first.mermaidBlocks.first = document.createElement('pre')
  first.mermaidRequested = true
  first.resolveTimer = 123
  first.checkingTimer = 456
  first.anchorSnapshotGeneration++
  first.resolutionGeneration++
  first.pendingVerificationId = 5
  for (const key of [
    'pendingHighlights',
    'pendingAnchors',
    'highlightNames',
    'paintedAnchors',
    'textPaints',
    'badges',
  ] as const) {
    expect(second[key]).toEqual([])
    expect(first[key]).not.toBe(second[key])
  }
  expect(second.checkingDeadlines).toEqual({})
  expect(second.badgeOffsets).toEqual({})
  expect(second.svgActiveThreads).toEqual({})
  expect(second.commentLabels.openOne).not.toBe('Changed')
  expect(second.reusableBadges.size).toBe(0)
  expect(second.pendingLinkClicks.has(click)).toBe(false)
  expect(second.mermaidBlocks).toEqual({})
  expect(second.mermaidRequested).toBe(false)
  expect(second.resolveTimer).toBeUndefined()
  expect(second.checkingTimer).toBeUndefined()
  expect(second.anchorSnapshotGeneration).toBe(0)
  expect(second.resolutionGeneration).toBe(0)
  expect(second.pendingVerificationId).toBeNull()
  expect(first.svgOverlayStyles).not.toBe(second.svgOverlayStyles)
})
