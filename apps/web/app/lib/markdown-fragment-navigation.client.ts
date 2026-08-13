const initializedDocuments = new WeakSet<Document>()

export function enableMarkdownFragmentNavigation(frame: HTMLIFrameElement) {
  const document = frame.contentDocument
  if (!document || initializedDocuments.has(document)) return
  initializedDocuments.add(document)

  document.addEventListener('click', (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    const view = document.defaultView
    if (!view || !(event.target instanceof view.Element)) return
    const anchor = event.target.closest<HTMLAnchorElement>('a[href^="#"]')
    const href = anchor?.getAttribute('href')
    if (!href || href === '#') return

    let id: string
    try {
      id = decodeURIComponent(href.slice(1))
    } catch {
      return
    }
    const target = document.getElementById(id)
    if (!target) return

    event.preventDefault()
    target.scrollIntoView()
  })
}
