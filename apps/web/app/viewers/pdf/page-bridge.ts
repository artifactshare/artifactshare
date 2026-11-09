import {
  parsePdfOpenPageMessage,
  parsePdfPageSyncMessage,
  pdfPageReport,
} from '../shared/pdf-page'
import type { PdfViewerRuntime } from './runtime'

type PageRuntime = Pick<PdfViewerRuntime, 'subscribe' | 'getSnapshot' | 'goTo'>

// Tells the app which page is shown, whenever it or the document's state
// changes (buttons, keys, search, scrolling), once the app has given this
// document its sync token; and opens a page the app asks for while a page is
// shown. Only the parent window is answered.
export function connectPdfPageBridge(
  runtime: PageRuntime,
  view: Window = window,
): () => void {
  if (view.parent === view) return () => {}
  let token: string | null = null
  let last = ''
  const report = (repeat = false) => {
    if (!token) return
    const message = pdfPageReport(runtime.getSnapshot(), token)
    const key = JSON.stringify(message)
    if (!repeat && key === last) return
    last = key
    view.parent.postMessage(message, '*')
  }
  const onMessage = (event: MessageEvent) => {
    if (event.source !== view.parent) return
    const page = parsePdfOpenPageMessage(event.data)
    if (page !== null) {
      const snapshot = runtime.getSnapshot()
      if (
        snapshot.state === 'ready' &&
        snapshot.ready &&
        page <= snapshot.pageCount
      )
        runtime.goTo(page)
      return
    }
    // Every answer to the app's ready check brings a new token: report the
    // current page with it.
    const next = parsePdfPageSyncMessage(event.data)
    if (next === null) return
    token = next
    report(true)
  }
  view.addEventListener('message', onMessage)
  const unsubscribe = runtime.subscribe(() => report())
  return () => {
    view.removeEventListener('message', onMessage)
    unsubscribe()
  }
}
