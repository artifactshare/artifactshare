import { loadPublishedViewer } from './+published-viewer-loader-fixture'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { waitForRealTaskCondition } from '~/test/wait-for-real-task-condition'
import {
  ViewerShell,
  type ViewerShellArtifact,
} from './+components/viewer-shell'

const revalidate = vi.hoisted(() => vi.fn())
const viewerLocale = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n(viewerLocale.value) }
})
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useRevalidator: () => ({ revalidate }),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const artifact: ViewerShellArtifact = {
  id: 'abc123def4',
  name: 'Report',
  derivedTitle: null,
  titleOverride: null,
  storageKey: 'test/index.html',
  ownerId: 'u1',
  ownerName: 'Owner',
  ownerEmail: 'owner@example.com',
  ownerImage: null,
  ownerInitial: 'O',
  modifiedTime: null,
  viewCount: 0,
  visibility: 'link',
  currentVersionId: 'v1',
  canViewHistory: false,
}
const user = {
  id: 'u1',
  name: 'Owner',
  email: 'owner@example.com',
  image: null,
  initial: 'O',
}
let root: Root
let host: HTMLDivElement
let router: ReturnType<typeof createMemoryRouter>
let setArtifact: (next: ViewerShellArtifact) => void
let currentVersionId: string
let lookup: ReturnType<typeof vi.fn>
let reads = 0

function versionResponse(versionId: string) {
  const response = Response.json({ currentVersionId: versionId })
  const json = response.json.bind(response)
  vi.spyOn(response, 'json').mockImplementation(async () => {
    const body = await json()
    reads += 1
    return body
  })
  return response
}

beforeEach(() => {
  viewerLocale.value = 'en'
  vi.useFakeTimers({
    toFake: [
      'Date',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
  })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  currentVersionId = 'v1'
  reads = 0
  revalidate.mockReset()
  lookup = vi.fn(async () => versionResponse(currentVersionId))
  vi.stubGlobal('fetch', lookup)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  router?.dispose()
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(
  patch: Partial<ViewerShellArtifact> = {},
  signedIn = false,
  sandboxUrl: string | null = null,
  viewer: Parameters<typeof ViewerShell>[0]['user'] = user,
) {
  function Harness() {
    const [value, update] = useState({ ...artifact, ...patch })
    setArtifact = update
    return (
      <TooltipProvider>
        <ViewerShell
          artifact={value}
          user={signedIn ? viewer : null}
          renderType={null}
          sandboxUrl={sandboxUrl}
          bundlePaths={[]}
        />
      </TooltipProvider>
    )
  }
  router = createMemoryRouter([{ path: '/', Component: Harness }])
  await act(async () => root.render(<RouterProvider router={router} />))
}
async function bodyRead(count: number) {
  await act(async () => {
    await waitForRealTaskCondition(() => reads >= count, 'lookup body read')
  })
}
function notice() {
  return host.textContent?.includes('A new version is available')
}

test('anonymous link checks only current-version, shows an update, and refreshes without history access', async () => {
  const networkLog = vi.spyOn(console, 'info')
  // Focus returns to the stable viewer shell; a blank sandbox would also
  // trigger unrelated recovery requests when the polling timer advances.
  const published = await loadPublishedViewer({
    locale: 'en',
    scheduled: false,
    persona: 'anonymous',
    historical: false,
  })
  await mount(published.artifact, false, null, published.user)
  await bodyRead(1)
  expect(
    networkLog.mock.calls.some(
      ([, event]) => event?.purpose === 'versions' && event?.status === 401,
    ),
  ).toBe(false)
  expect(lookup).toHaveBeenCalledTimes(1)
  expect(lookup.mock.calls[0]![0]).toBe(
    '/api/shareables/abc123def4/current-version',
  )
  expect(notice()).toBe(false)
  const status = host.querySelector(
    '[role="status"][aria-label="Activity and version status"]',
  )
  expect(status).not.toBeNull()
  expect(status!.textContent).toBe('')
  const aside = host.querySelector<HTMLElement>(
    'aside[aria-label="Activity and version status"]',
  )!
  expect(aside.hidden).toBe(true)
  expect(status!.closest('[hidden], [aria-hidden="true"]')).toBeNull()
  currentVersionId = 'v2'
  await act(async () => vi.advanceTimersByTimeAsync(300_000))
  await bodyRead(2)
  expect(notice()).toBe(true)
  expect(
    host.querySelector(
      '[role="status"][aria-label="Activity and version status"]',
    ),
  ).toBe(status)
  expect(status!.textContent).toContain('A new version is available')
  expect(aside.hidden).toBe(false)
  const visibleSentence = aside.querySelector('span')!
  expect(visibleSentence.textContent).toBe('A new version is available')
  expect(visibleSentence.getAttribute('aria-hidden')).toBe('true')
  expect(host.querySelector('aside[role="status"]')).toBeNull()
  expect(
    host
      .querySelector('aside[aria-label="Activity and version status"]')!
      .classList.contains('rounded-[var(--r-md)]'),
  ).toBe(true)
  expect(
    lookup.mock.calls.every(([url]) =>
      String(url).endsWith('/current-version'),
    ),
  ).toBe(true)
  expect(host.textContent).not.toContain('Open history')
  const button = Array.from(host.querySelectorAll('button')).find(
    (entry) => entry.textContent === 'Show latest',
  )
  expect(button).toBeDefined()
  expect(button!.closest('[hidden], [aria-hidden="true"]')).toBeNull()
  button!.focus()
  expect(document.activeElement).toBe(button)
  await act(async () => button!.click())
  const viewer = host.querySelector<HTMLElement>(
    '[role="region"][tabindex="-1"]',
  )
  expect(viewer).not.toBeNull()
  expect(document.activeElement).toBe(viewer)
  expect(revalidate).toHaveBeenCalledOnce()
  expect(notice()).toBe(false)
  expect(
    host.querySelector(
      '[role="status"][aria-label="Activity and version status"]',
    ),
  ).toBe(status)
  expect(status!.textContent).toBe('')
  expect(aside.hidden).toBe(true)
  await act(async () => setArtifact({ ...artifact, currentVersionId: 'v2' }))
  await bodyRead(3)
  expect(notice()).toBe(false)
  expect(document.activeElement).toBe(viewer)
})

test('anonymous update announcements remain accessible with chrome collapsed', async () => {
  await mount({}, false, 'about:blank')
  await bodyRead(1)
  const status = host.querySelector<HTMLElement>(
    '[role="status"][aria-label="Activity and version status"]',
  )!
  expect(status).not.toBeNull()
  expect(status.textContent).toBe('')
  const collapse = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Collapse Artifact Share"]',
  )!
  expect(collapse).not.toBeNull()
  await act(async () => collapse.click())
  const aside = host.querySelector<HTMLElement>(
    'aside[aria-label="Activity and version status"]',
  )!
  expect(aside.hidden).toBe(true)
  expect(status.closest('[hidden], [aria-hidden="true"]')).toBeNull()
  expect(getComputedStyle(status).display).not.toBe('none')
  expect(getComputedStyle(status).visibility).not.toBe('hidden')
  expect(getComputedStyle(status).visibility).not.toBe('collapse')
  currentVersionId = 'v2'
  vi.setSystemTime(Date.now() + 300_000)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await bodyRead(2)
  expect(
    host.querySelector(
      '[role="status"][aria-label="Activity and version status"]',
    ),
  ).toBe(status)
  expect(status.textContent).toBe('A new version is available')
  expect(status.closest('[hidden], [aria-hidden="true"]')).toBeNull()
  expect(aside.hidden).toBe(true)
  expect(host.querySelector('aside[role="status"]')).toBeNull()
  const expand = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Show Artifact Share"]',
  )!
  expect(expand).not.toBeNull()
  await act(async () => expand.click())
  expect(aside.hidden).toBe(false)
  expect(aside.textContent).toContain('A new version is available')
  expect(
    host.querySelector(
      '[role="status"][aria-label="Activity and version status"]',
    ),
  ).toBe(status)
})

test('history viewers keep the visible update sentence accessible', async () => {
  await mount({ canViewHistory: true }, true)
  await bodyRead(1)
  currentVersionId = 'v2'
  await act(async () => vi.advanceTimersByTimeAsync(300_000))
  await bodyRead(2)
  const toggle = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Version status: v-, new version available"]',
  )!
  expect(toggle).not.toBeNull()
  await act(async () => toggle.click())
  const sentence = Array.from(host.querySelectorAll('span')).find(
    (entry) => entry.textContent === 'A new version is available',
  )!
  expect(sentence).toBeDefined()
  expect(sentence.closest('[hidden], [aria-hidden="true"]')).toBeNull()
  const viewer = host.querySelector<HTMLElement>(
    '[role="region"][tabindex="-1"]',
  )!
  expect(viewer).not.toBeNull()
  const focusViewer = vi.spyOn(viewer, 'focus')
  const showLatest = Array.from(host.querySelectorAll('button')).find(
    (entry) => entry.textContent === 'Show latest',
  )!
  expect(showLatest).toBeDefined()
  await act(async () => showLatest.click())
  expect(focusViewer).not.toHaveBeenCalled()
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
})
