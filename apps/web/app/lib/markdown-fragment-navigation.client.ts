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
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  const headings = Array.from(
    document.querySelectorAll<HTMLElement>(
      'article h1[id], article h2[id], article h3[id], article h4[id], article h5[id], article h6[id]',
    ),
  )
  const links = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('nav a[href^="#"]'),
  )
  const updateActiveHeading = () => {
    const active =
      headings.findLast(
        (heading) => heading.getBoundingClientRect().top <= 120,
      ) ?? headings[0]
    for (const link of links) {
      const current = link.getAttribute('href')?.slice(1) === active?.id
      link.classList.toggle('active', current)
      if (current) link.setAttribute('aria-current', 'location')
      else link.removeAttribute('aria-current')
    }
  }
  document.addEventListener('scroll', updateActiveHeading, { passive: true })
  updateActiveHeading()
}
