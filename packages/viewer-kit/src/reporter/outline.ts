import type { ReporterState } from './state.js'

// Reading position for the Markdown outline viewer (data-md-outline-version="2").
// The renderer emits the outline, the compact contents row and the panel; this
// controller only tracks, navigates and moves the rail marker.

interface OutlineItem {
  id: string
  heading: HTMLElement
  fine: boolean
  links: HTMLAnchorElement[]
}

interface OutlineIndicator {
  root: HTMLElement
  svg: SVGSVGElement
  track: SVGPathElement
  marker: SVGPathElement
  placed: boolean
  dirty: boolean
  width: number
  total: number
  spans: Map<string, { start: number; length: number }>
}

const READY_MARK = 'data-md-outline-ready'

export function installMarkdownOutline(ctx: ReporterState) {
  // The reporter runs before the authored <html> start tag, so neither its
  // attributes nor <body> exist yet: never read them here. Mark the root now
  // so narrow screens show the compact row from the first paint; the parser
  // keeps this attribute when it merges the authored root tag.
  // startMarkdownOutline removes it again when the document has no outline.
  ctx.doc.documentElement.setAttribute(READY_MARK, '')
  if (ctx.doc.readyState === 'loading') {
    ctx.doc.addEventListener(
      'DOMContentLoaded',
      () => startMarkdownOutline(ctx),
      {
        once: true,
      },
    )
  } else {
    startMarkdownOutline(ctx)
  }
}

function startMarkdownOutline(ctx: ReporterState) {
  const doc = ctx.doc
  const win = ctx.win
  const body = doc.body
  // Without a running controller the outline list itself must stay visible
  // on narrow screens, so every failed start drops the provisional mark.
  const notReady = () => doc.documentElement.removeAttribute(READY_MARK)
  if (
    !body ||
    !body.hasAttribute('data-artifact-markdown') ||
    body.getAttribute('data-md-outline-version') !== '2'
  )
    return notReady()
  const railNav = doc.querySelector<HTMLElement>('[data-md-outline="rail"]')
  const panelNav = doc.querySelector<HTMLElement>('[data-md-outline="panel"]')
  const dialog = doc.querySelector<HTMLDialogElement>('dialog.md-outline-panel')
  const row = doc.querySelector<HTMLElement>('.md-position')
  const rowButton = doc.querySelector<HTMLButtonElement>('.md-position-button')
  const rowTitle = doc.querySelector<HTMLElement>('.md-position-current')
  const sidebar = doc.querySelector<HTMLElement>('.md-sidebar')
  const header = doc.querySelector<HTMLElement>('.md-outline-header')
  const closeButton = doc.querySelector<HTMLButtonElement>(
    '[data-md-outline-close]',
  )
  const article = doc.querySelector<HTMLElement>('article.md')
  if (
    !railNav ||
    !panelNav ||
    !dialog ||
    !row ||
    !rowButton ||
    !rowTitle ||
    !sidebar ||
    !header ||
    !closeButton ||
    !article
  )
    return notReady()

  const items: OutlineItem[] = []
  const itemsById = new Map<string, OutlineItem>()
  const railLinks = railNav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')
  for (let index = 0; index < railLinks.length; index++) {
    const link = railLinks[index]
    const id = link.getAttribute('href')!.slice(1)
    const heading = doc.getElementById(id)
    if (!heading || itemsById.has(id)) continue
    const item = {
      id,
      heading,
      fine: link.parentElement!.hasAttribute('data-fine'),
      links: [] as HTMLAnchorElement[],
    }
    items.push(item)
    itemsById.set(id, item)
  }
  if (!items.length) return notReady()
  const allLinks = doc.querySelectorAll<HTMLAnchorElement>(
    '[data-md-outline] a[href^="#"]',
  )
  for (let index = 0; index < allLinks.length; index++) {
    const item = itemsById.get(allLinks[index].getAttribute('href')!.slice(1))
    if (item) item.links.push(allLinks[index])
  }

  const reducedMotion = win.matchMedia('(prefers-reduced-motion: reduce)')
  const toggles = doc.querySelectorAll<HTMLInputElement>(
    '[data-md-outline-details]',
  )
  let showDetails = false
  for (let index = 0; index < toggles.length; index++)
    if (toggles[index].checked) showDetails = true
  let tracking = items.filter((item) => showDetails || !item.fine)
  let activeId = ''
  let frame = 0
  // An explicitly chosen entry stays selected until the document moves.
  let jumpPosition: number | null = null
  let openY = 0
  let restoreOnClose = false
  let geometryChanged = false
  let titleAnimation: Animation | null = null
  const switchMargin = 12
  const indicators: OutlineIndicator[] = []
  for (const root of [railNav, panelNav]) {
    const svg = root.querySelector<SVGSVGElement>('.md-outline-rail')
    const track = root.querySelector<SVGPathElement>('.md-outline-track')
    const marker = root.querySelector<SVGPathElement>('.md-outline-progress')
    if (svg && track && marker)
      indicators.push({
        root,
        svg,
        track,
        marker,
        placed: false,
        dirty: true,
        width: 0,
        total: 0,
        spans: new Map(),
      })
  }

  const shown = (element: Element) =>
    win.getComputedStyle(element).display !== 'none'
  const contentTop = () =>
    shown(row) ? Math.max(0, row.getBoundingClientRect().bottom) : 0
  // Only the outline copy the reader can currently use carries aria-current.
  const surface = () =>
    dialog.open ? panelNav : shown(sidebar) ? railNav : panelNav
  const applyCurrent = () => {
    const current = surface()
    for (const item of items) {
      for (const link of item.links) {
        if (item.id === activeId && current.contains(link))
          link.setAttribute('aria-current', 'location')
        else link.removeAttribute('aria-current')
      }
    }
  }

  const buildRail = (indicator: OutlineIndicator) => {
    const { root, svg, track, marker } = indicator
    const box = root.getBoundingClientRect()
    const links = Array.from(root.querySelectorAll('a')).filter(
      (link) => link.getClientRects().length > 0,
    )
    if (!box.width || !box.height || !links.length) {
      svg.setAttribute('hidden', '')
      return false
    }
    const points = links.map((link) => {
      const rect = link.getBoundingClientRect()
      return {
        id: link.getAttribute('href')!.slice(1),
        top: rect.top - box.top + root.scrollTop,
        bottom: rect.bottom - box.top + root.scrollTop,
      }
    })
    const top = points[0]!.top
    const bottom = points[points.length - 1]!.bottom
    const path = `M 4 ${top} L 4 ${bottom}`
    indicator.spans.clear()
    for (const point of points)
      indicator.spans.set(point.id, {
        start: point.top - top,
        length: point.bottom - point.top,
      })
    track.setAttribute('d', path)
    marker.setAttribute('d', path)
    svg.style.height = bottom + 'px'
    svg.removeAttribute('hidden')
    indicator.width = box.width
    indicator.total = bottom - top
    indicator.dirty = false
    return true
  }

  // Geometry changes place the marker immediately; only section changes move it.
  const syncIndicators = (animate: boolean) => {
    for (const indicator of indicators) {
      const { root, svg, marker } = indicator
      const box = root.getBoundingClientRect()
      if (!box.width || !box.height) {
        svg.setAttribute('hidden', '')
        indicator.dirty = true
        continue
      }
      const rebuild =
        indicator.dirty || Math.abs(indicator.width - box.width) > 0.5
      if (rebuild && !buildRail(indicator)) continue
      const span = indicator.spans.get(activeId)
      if (!span) {
        marker.setAttribute('hidden', '')
        continue
      }
      const moving =
        animate && indicator.placed && !rebuild && !reducedMotion.matches
      if (!moving) marker.style.transition = 'none'
      marker.removeAttribute('hidden')
      marker.style.strokeDasharray = `${span.length} ${indicator.total + 1}`
      marker.style.strokeDashoffset = String(-span.start)
      if (!moving) {
        void marker.getBoundingClientRect()
        marker.style.removeProperty('transition')
      }
      indicator.placed = true
    }
  }
  const refreshGeometry = () => {
    for (const indicator of indicators) indicator.dirty = true
    syncIndicators(false)
  }

  // Scroll the outline only as far as needed to show the current entry.
  const reveal = (container: HTMLElement, center: boolean) => {
    const link = container.querySelector<HTMLElement>('[aria-current]')
    if (!link || container.scrollHeight <= container.clientHeight) return
    const outer = container.getBoundingClientRect()
    const rect = link.getBoundingClientRect()
    const inset = container === sidebar ? header.offsetHeight + 8 : 12
    const clippedAbove = rect.top < outer.top + inset
    const clippedBelow = rect.bottom > outer.bottom - 12
    if (!clippedAbove && !clippedBelow) return
    if (center) {
      container.scrollTo({
        top:
          container.scrollTop +
          rect.top -
          outer.top -
          (container.clientHeight - rect.height) / 2,
        behavior: 'instant',
      })
      return
    }
    container.scrollTo({
      top: clippedAbove
        ? container.scrollTop - (outer.top + inset - rect.top)
        : container.scrollTop + rect.bottom - outer.bottom + 12,
      behavior: reducedMotion.matches ? 'instant' : 'smooth',
    })
  }

  const setActive = (item: OutlineItem, animate = true) => {
    if (item.id === activeId) return
    const previous = items.findIndex((candidate) => candidate.id === activeId)
    const direction = Math.sign(items.indexOf(item) - previous)
    activeId = item.id
    applyCurrent()
    if (titleAnimation) titleAnimation.cancel()
    titleAnimation = null
    rowTitle.textContent = item.heading.textContent
    if (
      previous >= 0 &&
      !reducedMotion.matches &&
      shown(row) &&
      typeof rowTitle.animate === 'function'
    )
      titleAnimation = rowTitle.animate(
        [
          { opacity: 0.4, transform: `translateY(${direction * 4}px)` },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 160, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      )
    syncIndicators(animate)
    if (shown(sidebar)) reveal(sidebar, false)
  }

  const update = () => {
    frame = 0
    // A selection caused by a layout change places the marker without travel.
    const animate = !geometryChanged
    geometryChanged = false
    if (jumpPosition !== null) {
      if (Math.abs(win.scrollY - jumpPosition) <= 1) return
      jumpPosition = null
    }
    // Headings inside a closed details element are not rendered and must not
    // decide the current section.
    const rendered = tracking.filter(
      (item) => !item.heading.closest('details:not([open])'),
    )
    if (!rendered.length) return
    const root = doc.scrollingElement || doc.documentElement
    // A short final section cannot always reach the reference line.
    if (
      root.scrollHeight > win.innerHeight + 2 &&
      root.scrollTop > 0 &&
      root.scrollTop + win.innerHeight >= root.scrollHeight - 2
    ) {
      setActive(rendered[rendered.length - 1]!, animate)
      return
    }
    const top = contentTop()
    const line = top + (win.innerHeight - top) / 4
    let index = Math.max(
      0,
      rendered.findIndex((item) => item.id === activeId),
    )
    // Separate entry and exit edges keep small reversals from flipping it.
    while (
      index + 1 < rendered.length &&
      rendered[index + 1]!.heading.getBoundingClientRect().top <=
        line - switchMargin
    )
      index++
    while (
      index > 0 &&
      rendered[index]!.heading.getBoundingClientRect().top > line + switchMargin
    )
      index--
    setActive(rendered[index]!, animate)
  }
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(update)
  }
  const scheduleGeometry = () => {
    geometryChanged = true
    schedule()
  }
  // A hidden fine heading selects the visible section that owns it.
  const ownerOf = (item: OutlineItem) => {
    const position = items.indexOf(item)
    let owner = tracking[0]!
    for (const candidate of tracking)
      if (items.indexOf(candidate) <= position) owner = candidate
    return owner
  }

  const jump = (item: OutlineItem) => {
    const heading = item.heading
    // Like native fragment navigation, reveal a heading inside closed details.
    for (
      let ancestor = heading.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    )
      if (
        ancestor.tagName === 'DETAILS' &&
        !(ancestor as HTMLDetailsElement).open
      )
        (ancestor as HTMLDetailsElement).open = true
    win.scrollTo({
      top: Math.max(
        0,
        win.scrollY + heading.getBoundingClientRect().top - contentTop() - 16,
      ),
      behavior: 'instant',
    })
    jumpPosition = win.scrollY
    if (!heading.hasAttribute('tabindex'))
      heading.setAttribute('tabindex', '-1')
    heading.focus({ preventScroll: true })
    setActive(ownerOf(item))
    try {
      if (decodeURIComponent(win.location.hash) !== '#' + item.id)
        win.history.pushState(null, '', '#' + item.id)
    } catch (error) {}
  }

  const openPanel = () => {
    if (dialog.open) return
    openY = win.scrollY
    restoreOnClose = true
    dialog.showModal()
    rowButton.setAttribute('aria-expanded', 'true')
    closeButton.focus({ preventScroll: true })
    applyCurrent()
    refreshGeometry()
    reveal(panelNav, true)
  }

  rowButton.addEventListener('pointerdown', (event) => event.preventDefault())
  rowButton.addEventListener('click', openPanel)
  // Closing without a choice returns to where the reader was.
  const cancelPanel = () => {
    if (dialog.open) dialog.close()
    restoreOnClose = false
    rowButton.setAttribute('aria-expanded', 'false')
    applyCurrent()
    rowButton.focus({ preventScroll: true })
    win.scrollTo({ top: openY, behavior: 'instant' })
    schedule()
  }
  closeButton.addEventListener('click', cancelPanel)
  // Escape and other browser closes arrive as a queued event; Close and a
  // chosen entry are handled synchronously and clear restoreOnClose.
  dialog.addEventListener('close', () => {
    if (!dialog.open && restoreOnClose) cancelPanel()
  })
  for (const item of items) {
    for (const link of item.links) {
      link.addEventListener('click', (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return
        event.preventDefault()
        if (dialog.open) {
          // Unlock the document before navigating; never restore afterwards.
          restoreOnClose = false
          dialog.close()
          rowButton.setAttribute('aria-expanded', 'false')
          applyCurrent()
        }
        jump(item)
      })
    }
  }
  for (let index = 0; index < toggles.length; index++) {
    const toggle = toggles[index]
    toggle.addEventListener('change', () => {
      showDetails = toggle.checked
      for (let other = 0; other < toggles.length; other++)
        toggles[other].checked = showDetails
      tracking = items.filter((item) => showDetails || !item.fine)
      jumpPosition = null
      activeId = ''
      for (const indicator of indicators) indicator.dirty = true
      update()
      if (dialog.open) reveal(panelNav, true)
    })
  }

  win.addEventListener('scroll', schedule, { passive: true })
  // Back/Forward and fragment navigation select the heading in the URL, even
  // when the scroll offset is unchanged (for example clamped final sections).
  const followHistory = () => {
    let id = ''
    try {
      id = decodeURIComponent(win.location.hash.slice(1))
    } catch (error) {}
    const item = itemsById.get(id)
    if (!item) {
      jumpPosition = null
      schedule()
      return
    }
    jumpPosition = win.scrollY
    setActive(ownerOf(item))
  }
  win.addEventListener('popstate', followHistory)
  win.addEventListener('hashchange', followHistory)
  win.addEventListener('resize', () => {
    // The panel belongs to the narrow layout only.
    if (dialog.open && shown(sidebar)) cancelPanel()
    applyCurrent()
    refreshGeometry()
    scheduleGeometry()
  })
  if (doc.fonts && doc.fonts.addEventListener)
    doc.fonts.addEventListener('loadingdone', () => {
      refreshGeometry()
      scheduleGeometry()
    })
  const articleObserver = new win.ResizeObserver(scheduleGeometry)
  articleObserver.observe(article)
  const outlineObserver = new win.ResizeObserver(refreshGeometry)
  outlineObserver.observe(railNav)
  outlineObserver.observe(panelNav)
  reducedMotion.addEventListener('change', () => {
    if (titleAnimation) titleAnimation.cancel()
    syncIndicators(false)
  })
  win.addEventListener('pagehide', (event) => {
    if ((event as PageTransitionEvent).persisted) return
    win.cancelAnimationFrame(frame)
    frame = 0
    articleObserver.disconnect()
    outlineObserver.disconnect()
  })
  win.addEventListener('pageshow', (event) => {
    if (!(event as PageTransitionEvent).persisted) return
    refreshGeometry()
    scheduleGeometry()
  })
  update()
}
