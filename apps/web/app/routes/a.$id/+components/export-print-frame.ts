import type { InertExportDocument } from './export-resources'

type PrintRelayScript = HTMLScriptElement & {
  printRelay?: { sender: Window; frame: HTMLIFrameElement; channel: string }
}

// Executed as a script in the popup, so postMessage's incumbent Window is
// the frame's actual parent. Calling a popup method from the app is not enough.
function printPopupRelay() {
  const script = document.currentScript as PrintRelayScript
  const { sender, frame, channel } = script.printRelay!
  delete script.printRelay
  const origin = sender.location.origin
  let sequence = 0
  const receive = (event: MessageEvent) => {
    if (
      event.source !== sender ||
      event.origin !== origin ||
      event.data?.channel !== channel ||
      event.data?.kind !== 'measure' ||
      !Number.isSafeInteger(event.data.sequence) ||
      event.data.sequence !== sequence + 1
    )
      return
    sequence = event.data.sequence
    frame.contentWindow?.postMessage(
      { kind: 'measure', channel, sequence },
      '*',
    )
  }
  const dispose = () => {
    window.removeEventListener('message', receive)
    window.removeEventListener('pagehide', dispose)
    script.removeEventListener('dispose', dispose)
  }
  window.addEventListener('message', receive)
  window.addEventListener('pagehide', dispose, { once: true })
  script.addEventListener('dispose', dispose, { once: true })
}

export function installPrintRelay(
  doc: Document,
  frame: HTMLIFrameElement,
  channel: string,
) {
  const script = doc.createElement('script') as PrintRelayScript
  script.printRelay = { sender: window, frame, channel }
  script.textContent = `(${printPopupRelay.toString()})()`
  doc.head.appendChild(script)
  return () => {
    script.dispatchEvent(new Event('dispose'))
    script.remove()
  }
}

// This function is serialized into an opaque frame. It has no application
// capabilities and receives only a channel and a monotonic measurement sequence.
export function printFrameHelper(channel: string, parentOrigin: string) {
  // A fixed initial containing block prevents percentage-height layouts from
  // growing again whenever the parent expands the frame to fit their overflow.
  document.documentElement.style.setProperty('height', '760px', 'important')
  // Absolute descendants otherwise use the expanding iframe's initial
  // containing block, making bottom offsets grow on every measurement pass.
  if (getComputedStyle(document.documentElement).position === 'static')
    document.documentElement.style.setProperty(
      'position',
      'relative',
      'important',
    )
  const vertical = /^(vertical|sideways)/.test(
    getComputedStyle(document.documentElement).writingMode,
  )
  document.documentElement.style.setProperty(
    '--artifactshare-print-vb',
    vertical ? '9px' : '7.6px',
    'important',
  )
  document.documentElement.style.setProperty(
    '--artifactshare-print-vi',
    vertical ? '7.6px' : '9px',
    'important',
  )
  const anchored = new WeakSet<HTMLElement>()
  const pinned = new WeakSet<Element>()
  const expandedBoxes = new WeakSet<Element>()
  let sequence = 0
  const layout = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  window.addEventListener('message', (event) => {
    if (
      event.source !== parent ||
      event.origin !== parentOrigin ||
      event.data?.channel !== channel ||
      event.data?.kind !== 'measure' ||
      !Number.isSafeInteger(event.data.sequence) ||
      event.data.sequence <= sequence
    )
      return
    sequence = event.data.sequence
    const current = sequence
    void (async () => {
      // Flush viewport-dependent styles so newly displayed text starts its
      // font loads before waiting for readiness on every sizing pass.
      // All sources are already acquired and sanitized. Printing requires every
      // image, including content below the screen viewport, to start loading.
      for (const image of document.images) image.loading = 'eager'
      await layout()
      await Promise.all(
        Array.from(document.images).map((image) => {
          const source = image.getAttribute('src')?.trim() ?? ''
          const placeholder = !source || source.startsWith('#')
          const selected = image.currentSrc
          const selectedPlaceholder =
            source.startsWith('#') &&
            selected === new URL(source, document.baseURI).href
          // currentSrc reflects picture media/type selection. Merely having a
          // source element (empty or unmatched) does not select an image.
          // A pending or failed real candidate must still go through decode.
          if (
            placeholder &&
            (!selected || selectedPlaceholder) &&
            !image.getAttribute('srcset')?.trim() &&
            image.complete
          )
            return
          return image.decode()
        }),
      )
      await document.fonts.ready
      if (Array.from(document.fonts).some((font) => font.status === 'error'))
        throw new Error('Font unavailable')
      await layout()
      // Keep viewport-anchored offsets at the initial 900 × 760 layout.
      // Fixed scrolling shells may still stretch with the frame; only pin their
      // top, not their height or overflow. Their normal-flow descendants must
      // remain measurable so the complete scroll content can fit on paper.
      for (const element of [
        document.body,
        ...document.body.querySelectorAll<HTMLElement>('*'),
      ]) {
        if (anchored.has(element)) continue
        const style = getComputedStyle(element)
        const fixed = style.position === 'fixed'
        // A positioned wrapper can inherit its height from a fixed shell.
        // Walk the containing-block chain, not just the immediate offsetParent.
        let parentFixed = false
        if (style.position === 'absolute') {
          for (
            let container = element.offsetParent;
            container;
            container = (container as HTMLElement).offsetParent
          ) {
            if (getComputedStyle(container).position === 'fixed') {
              parentFixed = true
              break
            }
          }
        }
        const negativeBottom = parseFloat(style.bottom) < 0
        if (!fixed && !(parentFixed && negativeBottom)) continue
        // WebKit can report a resolved top of zero for an auto-top fixed body.
        // Geometry reflects the actual bottom-anchored position in every engine.
        let top =
          style.top.endsWith('px') && element !== document.body
            ? style.top
            : `${
                (fixed
                  ? element.getBoundingClientRect().top
                  : element.offsetTop) - (parseFloat(style.marginTop) || 0)
              }px`
        const height = style.height
        const originalStyle = element.style.cssText
        const rect = element.getBoundingClientRect()
        const bottomInset = style.bottom
        let stretches = false
        let topAnchored = false
        if (fixed) {
          // Used pixel values cannot distinguish auto-top footers from boxes
          // constrained by both insets. Probe the existing layout, then restore
          // it before any frame is painted or a measurement is sent.
          element.style.setProperty(
            'bottom',
            `${(parseFloat(bottomInset) || 0) - 32}px`,
            'important',
          )
          const shifted = element.getBoundingClientRect()
          stretches = shifted.height > rect.height + 1
          topAnchored = Math.abs(shifted.top - rect.top) < 1
          element.style.cssText = originalStyle
          if (!topAnchored)
            top = `${rect.top - (parseFloat(style.marginTop) || 0)}px`
        }
        const viewportShell =
          topAnchored &&
          rect.height > 0 &&
          rect.bottom >= 760 - Math.max(0, parseFloat(bottomInset) || 0) - 1
        let scrollers =
          fixed && (stretches || viewportShell)
            ? [element, ...element.querySelectorAll<HTMLElement>('*')].filter(
                (candidate) => {
                  const candidateStyle = getComputedStyle(candidate)
                  return (
                    candidateStyle.visibility === 'visible' &&
                    ['auto', 'scroll'].includes(candidateStyle.overflowY) &&
                    candidate.clientHeight > 0 &&
                    candidate.scrollHeight > candidate.clientHeight
                  )
                },
              )
            : []
        let scrollingShell = scrollers.includes(element)
        if (scrollers.length) {
          const sizes = scrollers.map((candidate) => candidate.clientHeight)
          element.style.setProperty(
            'height',
            `${parseFloat(height) + 32}px`,
            'important',
          )
          element.style.setProperty('max-height', 'none', 'important')
          // Only panes whose height follows the shell need shell expansion.
          // An independent max-height box inside a footer is not such a pane.
          scrollers = scrollers.filter(
            (candidate, index) =>
              candidate === element ||
              candidate.clientHeight > sizes[index] + 1,
          )
          scrollingShell = scrollers.length > 0
          element.style.cssText = originalStyle
        }
        if (fixed && bottomInset === 'auto' && !scrollingShell) continue
        element.style.setProperty('top', top, 'important')
        if (scrollingShell || stretches) {
          expandedBoxes.add(element)
          if (scrollingShell) {
            for (const pane of scrollers) expandedBoxes.add(pane)
            // Viewport heights/max-heights must not cap the expandable shell.
            element.style.setProperty('height', 'auto', 'important')
            element.style.setProperty('max-height', 'none', 'important')
          }
          if (negativeBottom || bottomInset === 'auto')
            element.style.setProperty('bottom', '0px', 'important')
        } else {
          // Retaining both top and bottom would stretch an intrinsic footer
          // when the frame grows. Preserve its initial content-box height.
          element.style.setProperty('bottom', 'auto', 'important')
          element.style.setProperty('height', height, 'important')
          pinned.add(element)
        }
        anchored.add(element)
      }
      await layout()
      let bottom = 0
      // Layout is stable for this pass. Cache styles and inherited clipping
      // limits so long/deep reports do not repeat style reads for every child.
      const styles = new Map<Element, CSSStyleDeclaration>()
      const styleOf = (element: Element) => {
        let style = styles.get(element)
        if (!style) {
          style = getComputedStyle(element)
          styles.set(element, style)
        }
        return style
      }
      const hasBox = (style: CSSStyleDeclaration) =>
        style.display !== 'contents' && style.display !== 'none'
      const rootStyle = styleOf(document.documentElement)
      const nextContainer = (element: Element): Element | null => {
        const style = styleOf(element)
        let node = element.parentElement
        // offsetParent can report the static body for a root-positioned box.
        // Walk actual containing-block creators for both positioning modes;
        // a non-positioned body must not add a clipping boundary on that path.
        if (hasBox(style) && ['absolute', 'fixed'].includes(style.position)) {
          while (node) {
            const container = styleOf(node)
            if (
              hasBox(container) &&
              ((style.position === 'absolute' &&
                container.position !== 'static') ||
                [
                  container.transform,
                  container.perspective,
                  container.filter,
                  container.backdropFilter,
                  container.translate,
                  container.rotate,
                  container.scale,
                ].some((value) => value && value !== 'none') ||
                /(?:layout|paint|strict|content)/.test(container.contain) ||
                /(?:transform|perspective|filter)/.test(container.willChange) ||
                container.contentVisibility === 'auto')
            )
              break
            node = node.parentElement
          }
        }
        return node
      }
      const clipping = new Map<Element, number>()
      const clippingBottom = (element: Element) => {
        let node = nextContainer(element)
        const chain: Element[] = []
        while (
          node &&
          node !== document.documentElement &&
          !clipping.has(node)
        ) {
          chain.push(node)
          node = nextContainer(node)
        }
        let limit = node ? (clipping.get(node) ?? Infinity) : Infinity
        for (const ancestor of chain.reverse()) {
          const style = styleOf(ancestor)
          // Root overflow, and body overflow propagated from a visible root,
          // belong to the viewport. Inline/boxless elements cannot clip either.
          const viewportOverflow =
            ancestor === document.body &&
            rootStyle.overflowX === 'visible' &&
            rootStyle.overflowY === 'visible'
          if (
            !viewportOverflow &&
            hasBox(style) &&
            style.display !== 'inline' &&
            !expandedBoxes.has(ancestor) &&
            ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)
          )
            limit = Math.min(
              limit,
              ancestor.getBoundingClientRect().bottom + scrollY,
            )
          clipping.set(ancestor, limit)
        }
        return limit
      }
      for (const element of document.body.querySelectorAll('*')) {
        const style = styleOf(element)
        // Frozen fixed boxes no longer grow with the viewport. Include their
        // extent so a footer on an otherwise short page cannot be clipped.
        if (style.position === 'fixed' && !pinned.has(element)) continue
        const rect = element.getBoundingClientRect()
        let extent = Math.max(
          rect.bottom + scrollY,
          // Descendant scrolling panes include trailing padding/margins in
          // scrollHeight that the final child's border box does not capture.
          expandedBoxes.has(element) &&
            ['auto', 'scroll'].includes(style.overflowY) &&
            element.scrollHeight > element.clientHeight
            ? rect.top +
                element.scrollHeight +
                (parseFloat(style.borderTopWidth) || 0) +
                (parseFloat(style.borderBottomWidth) || 0) +
                scrollY
            : 0,
        )
        // Out-of-flow boxes follow their containing blocks, bypassing DOM
        // scrollers that cannot clip them; expanded shells retain full content.
        extent = Math.min(extent, clippingBottom(element))
        bottom = Math.max(bottom, extent)
      }
      const bodyStyle = getComputedStyle(document.body)
      const bodyRect = document.body.getBoundingClientRect()
      const height = Math.ceil(
        Math.max(
          bottom,
          // Include text-only fixed bodies and the room a scrolling body needs
          // for its bottom margin/border beyond its complete scroll content.
          bodyStyle.position === 'fixed'
            ? Math.max(
                bodyRect.bottom,
                bodyRect.top +
                  document.body.scrollHeight +
                  (parseFloat(bodyStyle.marginBottom) || 0) +
                  (parseFloat(bodyStyle.borderBottomWidth) || 0),
              ) + scrollY
            : 0,
          // Root-generated boxes are absent from body geometry. Include root
          // overflow only when they exist, preserving intrinsic short pages.
          ['::before', '::after'].some((pseudo) => {
            const style = getComputedStyle(document.documentElement, pseudo)
            return (
              style.display !== 'none' &&
              !['none', 'normal', ''].includes(style.content)
            )
          })
            ? document.documentElement.scrollHeight
            : 0,
          document.body.scrollHeight,
          document.body.offsetHeight,
        ),
      )
      parent.postMessage(
        { channel, sequence: current, kind: 'measured', height },
        '*',
      )
    })().catch(() =>
      parent.postMessage({ channel, sequence: current, kind: 'failed' }, '*'),
    )
  })
  parent.postMessage({ channel, sequence: 0, kind: 'ready' }, '*')
}

export function isolatedPrintHtml(
  doc: InertExportDocument,
  channel: string,
): string {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
  const meta = doc.createElement('meta')
  meta.httpEquiv = 'Content-Security-Policy'
  meta.content = policy
  doc.head.insertBefore(meta, doc.head.firstChild)
  // Nonce hiding can clear the content attribute when a script is inserted.
  // Serialize the trusted script explicitly so its nonce survives outerHTML.
  const code = `(${printFrameHelper.toString()})(${JSON.stringify(channel)},${JSON.stringify(window.location.origin)})`
  const html = doc.documentElement.outerHTML
  const end = html.lastIndexOf('</body>')
  return `<!doctype html>${html.slice(0, end)}<script nonce="${nonce}">${code}</script>${html.slice(end)}`
}
