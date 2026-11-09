import { expect, test, vi } from 'vitest'
import { pdfOpenPageMessage, pdfPageSyncMessage } from '../shared/pdf-page'
import { connectPdfPageBridge } from './page-bridge'
import type { ViewerSnapshot } from './runtime'

function setup() {
  let snapshot: Pick<ViewerSnapshot, 'state' | 'ready' | 'page' | 'pageCount'> =
    { state: 'loading', ready: false, page: 1, pageCount: 0 }
  const listeners = new Set<() => void>()
  const runtime = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot as ViewerSnapshot,
    goTo: vi.fn(),
  }
  const update = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const parent = { postMessage: vi.fn() }
  const messageListeners = new Set<(event: MessageEvent) => void>()
  const view = {
    parent,
    addEventListener: (
      _type: string,
      listener: (event: MessageEvent) => void,
    ) => messageListeners.add(listener),
    removeEventListener: (
      _type: string,
      listener: (event: MessageEvent) => void,
    ) => messageListeners.delete(listener),
  } as unknown as Window
  const receive = (data: unknown, source: unknown = parent) => {
    for (const listener of messageListeners)
      listener({ data, source } as MessageEvent)
  }
  const reports = () =>
    parent.postMessage.mock.calls.map(([message]) => message)
  const disconnect = connectPdfPageBridge(runtime, view)
  return { runtime, update, receive, reports, disconnect, parent }
}

const firstToken = 'a'.repeat(64)
const secondToken = 'b'.repeat(64)
const unavailable = (token = firstToken) => ({
  source: 'artifactshare',
  kind: 'pdf-page-changed',
  token,
  state: 'unavailable',
})
const readyAt = (pageNumber: number, token = firstToken) => ({
  source: 'artifactshare',
  kind: 'pdf-page-changed',
  token,
  state: 'ready',
  pageNumber,
  pageCount: 12,
})

test('reports the shown page through load, page errors and recovery', () => {
  const { update, receive, reports, disconnect } = setup()
  // Nothing is reported before the app gives this document its token.
  update({ ready: true, pageCount: 12 })
  expect(reports()).toEqual([])
  receive(pdfPageSyncMessage(firstToken))
  update({ state: 'ready' })
  update({ page: 12 })
  update({ state: 'page-error' })
  update({ state: 'ready' })
  update({ page: 12 }) // unchanged: not repeated
  expect(reports()).toEqual([
    unavailable(),
    readyAt(1),
    readyAt(12),
    unavailable(),
    readyAt(12),
  ])
  disconnect()
  update({ page: 3 })
  expect(reports()).toHaveLength(5)
})

test('opens a page only for the parent, while a page is shown and within the count', () => {
  const { runtime, update, receive } = setup()
  receive(pdfOpenPageMessage(5))
  update({ state: 'ready', ready: true, pageCount: 12 })
  receive(pdfOpenPageMessage(5), {})
  receive(pdfOpenPageMessage(13))
  receive({ ...pdfOpenPageMessage(5), pageNumber: 2.5 })
  receive({ ...pdfOpenPageMessage(5), extra: 1 })
  update({ state: 'page-error' })
  receive(pdfOpenPageMessage(5))
  expect(runtime.goTo).not.toHaveBeenCalled()
  update({ state: 'ready' })
  receive(pdfOpenPageMessage(5))
  expect(runtime.goTo).toHaveBeenCalledExactlyOnceWith(5)
})

test('answers each sync token from the parent with the current page', () => {
  const { update, receive, reports } = setup()
  update({ state: 'ready', ready: true, pageCount: 12, page: 4 })
  receive(pdfPageSyncMessage(firstToken), {})
  receive({ ...pdfPageSyncMessage(firstToken), token: 'short' })
  expect(reports()).toEqual([])
  receive(pdfPageSyncMessage(firstToken))
  receive(pdfPageSyncMessage(secondToken))
  expect(reports()).toEqual([readyAt(4), readyAt(4, secondToken)])
})
