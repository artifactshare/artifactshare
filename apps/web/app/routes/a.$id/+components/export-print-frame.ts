import type { PrintFontFace } from '~/lib/export-print-font'
import {
  printViewportRegistrations,
  printFontFaces,
  isExportCssType,
  replaceExportCssImports,
  type InertExportDocument,
  type PrintViewportRegistration,
} from './export-resources'

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
export function printFrameHelper(
  channel: string,
  parentOrigin: string,
  registrations: (PrintViewportRegistration & { stylesheet?: string })[] = [],
  sheetUrls = new Map<string, string>(),
  cssType?: typeof isExportCssType,
  fontFaces: PrintFontFace[] = [],
) {
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
  document.documentElement.style.setProperty(
    '--artifactshare-print-vh',
    '7.6px',
    'important',
  )
  // Inline !important transitions outrank even the first important layer.
  // Finish those after geometry changes without rewriting source attributes.
  const finishTransitions = () => {
    for (const animation of document.getAnimations())
      if (animation instanceof CSSTransition) animation.finish()
  }
  const verticalFlexItem = (element: HTMLElement) => {
    const parent = element.parentElement
    if (!parent) return false
    const style = getComputedStyle(parent)
    return (
      ['flex', 'inline-flex'].includes(style.display) &&
      (/^(vertical|sideways)/.test(style.writingMode)
        ? style.flexDirection.startsWith('row')
        : style.flexDirection.startsWith('column'))
    )
  }
  // Change the actual registrations in place, preserving their stylesheet,
  // conditional group and cascade order. Initial values stay independent of
  // custom properties, while the same height probe can discover their users.
  const registeredRules: Array<{
    owner: CSSStyleSheet | CSSGroupingRule
    index: number
    normal: string
    probe: string
  }> = []
  const prepareRegistrations = () => {
    // Height/orientation media can become active after the parent resizes us.
    // Rebuild from live CSSOM on every pass, including repeat prints.
    registeredRules.length = 0
    const scratch = new CSSStyleSheet()
    const variants = new Map<string, string[]>()
    for (const registration of registrations) {
      const canonical = registration.variants.map((css) => {
        scratch.replaceSync(css)
        return scratch.cssRules[0]?.cssText ?? ''
      })
      if (!canonical[0]) continue // The browser rejected the source registration.
      scratch.replaceSync(`@supports ${registration.condition}{}`)
      const condition = (scratch.cssRules[0] as CSSSupportsRule)?.conditionText
      if (!condition) throw new Error('Invalid print registration condition')
      variants.set(condition, canonical)
    }
    const accounted = new Set<string>()
    const activeSheets = new Set<string>()
    const visit = (owner: CSSStyleSheet | CSSGroupingRule) => {
      if (owner instanceof CSSStyleSheet && owner.href)
        activeSheets.add(owner.href)
      for (const rule of Array.from(owner.cssRules)) {
        const variant =
          rule instanceof CSSSupportsRule
            ? variants.get(rule.conditionText)
            : undefined
        if (variant) {
          const group = rule as CSSSupportsRule
          accounted.add(group.conditionText)
          // A syntactically valid registration may still be rejected in this
          // context (for example inside a style rule). Preserve that rejection.
          if (!group.cssRules.length) continue
          if (
            group.cssRules.length !== 1 ||
            (group.cssRules[0].cssText !== variant[0] &&
              group.cssRules[0].cssText !== variant[vertical ? 2 : 0])
          )
            throw new Error('Print property registration changed')
          registeredRules.push({
            owner: group,
            index: 0,
            normal: variant[vertical ? 2 : 0],
            probe: variant[vertical ? 3 : 1],
          })
        } else if (rule instanceof CSSImportRule) {
          const supports = rule.supportsText
          if (
            (supports &&
              !CSS.supports(supports) &&
              !CSS.supports(`(${supports})`)) ||
            (rule.media.mediaText && !matchMedia(rule.media.mediaText).matches)
          )
            continue
          // A live import must have loaded. Missing sheets are not evidence
          // that their registrations were rejected or their content optional.
          if (!rule.styleSheet)
            throw new Error('Print imported stylesheet missing')
          visit(rule.styleSheet)
        } else if ('cssRules' in rule) {
          visit(rule as CSSGroupingRule)
        }
      }
    }
    for (const sheet of document.styleSheets) {
      // Some engines expose CSSOM for a style element whose type is inactive.
      // Such imports were deliberately not acquired and cannot affect output.
      if (
        sheet.ownerNode instanceof Element &&
        cssType &&
        !cssType(sheet.ownerNode)
      )
        continue
      visit(sheet)
    }
    for (const registration of registrations) {
      scratch.replaceSync(`@supports ${registration.condition}{}`)
      const condition = (scratch.cssRules[0] as CSSSupportsRule)?.conditionText
      // Imports discarded by the parser or disabled by supports() have no live
      // sheet. Their registrations cannot affect layout. A registration in a
      // live sheet must still be present, including duplicate declarations.
      if (
        registration.stylesheet &&
        !activeSheets.has(sheetUrls.get(registration.stylesheet) ?? '')
      )
        continue
      if (variants.has(condition) && !accounted.has(condition))
        throw new Error('Print property registration missing')
    }
  }
  const setRegistrationProbe = (probe: boolean) => {
    for (const rule of registeredRules) {
      rule.owner.deleteRule(rule.index)
      rule.owner.insertRule(probe ? rule.probe : rule.normal, rule.index)
    }
  }
  const anchored = new WeakSet<HTMLElement>()
  const pinned = new WeakSet<Element>()
  const expandedBoxes = new WeakSet<Element>()
  const expandedFlowBoxes = new WeakSet<HTMLElement>()
  let bundledFonts: Promise<FontFace[]> | undefined
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
      finishTransitions()
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
      // Decode fixed bundled bytes directly. No font URL request is needed in
      // this opaque document. Keep the faces for repeat prints, and propagate
      // decode failures through the same bounded preparation lifecycle.
      bundledFonts ??= Promise.all(
        fontFaces.map(async ({ weight, data, unicodeRange }) => {
          const bytes = Uint8Array.from(atob(data), (character) =>
            character.charCodeAt(0),
          )
          const face = new FontFace('ArtifactSharePrintJP', bytes, {
            weight,
            style: 'normal',
            display: 'block',
            ...(unicodeRange ? { unicodeRange } : {}),
          })
          document.fonts.add(face)
          try {
            return await face.load()
          } catch (error) {
            throw new Error(
              `Bundled print font ${weight} (${unicodeRange ? 'Latin' : 'Japanese'}) failed to decode`,
              { cause: error },
            )
          }
        }),
      )
      await bundledFonts
      await document.fonts.ready
      if (Array.from(document.fonts).some((font) => font.status === 'error'))
        throw new Error('Font unavailable')
      prepareRegistrations()
      setRegistrationProbe(false)
      await layout()
      finishTransitions()
      // Probe the fixed root and viewport-height bases together. This preserves
      // dependence through calc(), padding, offsets and flex/grid ancestors;
      // geometry alone cannot distinguish these shells from bounded log boxes.
      const flowBoxes = [
        document.body,
        ...document.body.querySelectorAll<HTMLElement>('*'),
      ].filter((element) => {
        const style = getComputedStyle(element)
        if (
          !['static', 'relative', 'sticky'].includes(style.position) ||
          style.visibility !== 'visible' ||
          element.clientHeight <= 0
        )
          return false
        for (let node = element.parentElement; node; node = node.parentElement)
          if (['fixed', 'absolute'].includes(getComputedStyle(node).position))
            return false
        return true
      })
      // Used CSS height excludes content-box padding: viewport padding alone
      // must not turn an independently bounded code/log box into a page shell.
      const initialSizes = flowBoxes.map((element) =>
        parseFloat(getComputedStyle(element).height),
      )
      const root = document.documentElement
      const heightAxis = vertical
        ? '--artifactshare-print-vi'
        : '--artifactshare-print-vb'
      root.style.setProperty('height', '792px', 'important')
      root.style.setProperty('--artifactshare-print-vh', '7.92px', 'important')
      root.style.setProperty(heightAxis, '7.92px', 'important')
      setRegistrationProbe(true)
      finishTransitions()
      const pageBoxes = new Set(
        flowBoxes.filter(
          (element, index) =>
            parseFloat(getComputedStyle(element).height) >
            initialSizes[index] + 1,
        ),
      )
      root.style.setProperty('height', '760px', 'important')
      root.style.setProperty('--artifactshare-print-vh', '7.6px', 'important')
      root.style.setProperty(heightAxis, '7.6px', 'important')
      setRegistrationProbe(false)
      finishTransitions()
      // Inline sizes from the previous pass no longer respond to the probe.
      // Keep their identity so media-query changes after iframe resizing (and
      // repeat prints) still resize and validate every previously opened shell.
      const expand = new Set(
        flowBoxes.filter((element) => expandedFlowBoxes.has(element)),
      )
      for (const element of pageBoxes) {
        const style = getComputedStyle(element)
        if (
          !['auto', 'scroll'].includes(style.overflowY) ||
          element.scrollHeight <= element.clientHeight
        )
          continue
        expand.add(element)
        // A pane's content must also fit through every page-height wrapper.
        // Grow structural ancestors as well, so flex/grid layout and following
        // siblings use the expanded size instead of merely measuring overflow.
        for (
          let node = element.parentElement;
          node && node !== document.documentElement;
          node = node.parentElement
        )
          if (pageBoxes.has(node)) expand.add(node)
      }
      for (const element of expand) expandedFlowBoxes.add(element)
      // Structural ancestors must follow expanded panes. Other descendants
      // retain their original layout height if enlarging a shell makes them
      // grow (including min-height percentages hidden by intrinsic content
      // during the small root probe).
      const structural = new Set<HTMLElement>(expand)
      for (const element of expand)
        for (let node = element.parentElement; node; node = node.parentElement)
          structural.add(node)
      const descendants = flowBoxes.filter((element) => {
        if (structural.has(element)) return false
        for (let node = element.parentElement; node; node = node.parentElement)
          if (expand.has(node)) return true
        return false
      })
      const descendantHeights = new Map(
        descendants.map((element) => [
          element,
          parseFloat(getComputedStyle(element).height),
        ]),
      )
      // Children first: each parent's scrollHeight then includes its expanded
      // descendants. A minimum size and non-shrinking flex basis prevent flex:1
      // from overriding height and leaving an invisible scroller on tall paper.
      for (const element of flowBoxes.reverse()) {
        if (!expand.has(element)) continue
        const style = getComputedStyle(element)
        const borders =
          (parseFloat(style.borderTopWidth) || 0) +
          (parseFloat(style.borderBottomWidth) || 0)
        // scrollHeight excludes the horizontal scrollbar. offset/client sizes
        // include its actual platform/style-dependent thickness, even when it
        // differs from the browser default (overlay scrollbars contribute zero).
        const scrollbar = Math.max(
          0,
          element.offsetHeight - element.clientHeight - borders,
        )
        const border =
          style.boxSizing === 'border-box'
            ? borders
            : -(parseFloat(style.paddingTop) || 0) -
              (parseFloat(style.paddingBottom) || 0)
        const height = `${element.scrollHeight + border + scrollbar}px`
        element.style.setProperty('height', height, 'important')
        element.style.setProperty('min-height', height, 'important')
        element.style.setProperty('max-height', 'none', 'important')
        if (verticalFlexItem(element)) {
          element.style.setProperty('flex-shrink', '0', 'important')
          element.style.setProperty('flex-basis', 'auto', 'important')
        }
        finishTransitions()
        // Keep the real clipping boundary in measurement. Never report hidden
        // scroll contents as printable merely because expansion was attempted.
      }
      // Snapshot all changes before restoring any descendant, so nested
      // percentage boxes are evaluated against the same expanded layout.
      const growingDescendants = descendants.filter(
        (element) =>
          parseFloat(getComputedStyle(element).height) >
          descendantHeights.get(element)! + 1,
      )
      for (const element of growingDescendants) {
        const height = `${descendantHeights.get(element)!}px`
        element.style.setProperty('height', height, 'important')
        element.style.setProperty('min-height', height, 'important')
        element.style.setProperty('max-height', 'none', 'important')
        if (verticalFlexItem(element)) {
          element.style.setProperty('flex-shrink', '0', 'important')
          element.style.setProperty('flex-basis', 'auto', 'important')
        }
      }
      finishTransitions()
      // Never declare a page shell complete if layout constraints still keep
      // part of its scrolling content outside the actual painted box.
      for (const element of expand)
        if (element.scrollHeight > element.clientHeight + 1)
          throw new Error('Print scroll shell did not expand completely')
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
          finishTransitions()
          const shifted = element.getBoundingClientRect()
          stretches = shifted.height > rect.height + 1
          topAnchored = Math.abs(shifted.top - rect.top) < 1
          element.style.cssText = originalStyle
          finishTransitions()
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
          finishTransitions()
          // Only panes whose height follows the shell need shell expansion.
          // An independent max-height box inside a footer is not such a pane.
          scrollers = scrollers.filter(
            (candidate, index) =>
              candidate === element ||
              candidate.clientHeight > sizes[index] + 1,
          )
          scrollingShell = scrollers.length > 0
          element.style.cssText = originalStyle
          finishTransitions()
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
        finishTransitions()
        anchored.add(element)
      }
      await layout()
      finishTransitions()
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
    })().catch((error: unknown) => {
      console.error('Print frame preparation failed', error)
      parent.postMessage({ channel, sequence: current, kind: 'failed' }, '*')
    })
  })
  parent.postMessage({ channel, sequence: 0, kind: 'ready' }, '*')
}

// Runs in the opaque frame, before any artifact styles are parsed. Blob URLs
// created here belong to this document: imported sheets have an origin-clean
// CSSOM even on engines that treat data: imports as cross-origin. No fetch is
// performed, and namespaces/conditional imports remain separate stylesheets.
export async function mountPrintDocument(
  html: string,
  sheets: Array<{ token: string; css: string }>,
  ready: (urls: Map<string, string>) => void,
  cssType: typeof isExportCssType,
) {
  const urls = new Map<string, string>()
  const substitute = (text: string) =>
    text.replace(/urn:artifactshare:print-css:[a-f0-9-]+/g, (token) => {
      const url = urls.get(token)
      return url ?? token
    })
  try {
    // Dependencies precede their importers.
    for (const sheet of sheets)
      urls.set(
        sheet.token,
        URL.createObjectURL(
          new Blob([substitute(sheet.css)], { type: 'text/css' }),
        ),
      )
    window.addEventListener(
      'pagehide',
      () => {
        for (const url of urls.values()) URL.revokeObjectURL(url)
      },
      { once: true },
    )
    const parsed = new DOMParser().parseFromString(
      substitute(html),
      'text/html',
    )
    const root = document.importNode(parsed.documentElement, true)
    const loaded: Promise<void>[] = []
    const styles = Array.from(
      root.querySelectorAll('style,link[rel~="stylesheet" i]'),
    ).filter(
      (element) =>
        cssType(element) &&
        (element.localName === 'style'
          ? element.textContent?.includes('blob:')
          : !element.hasAttribute('disabled') &&
            element.getAttribute('href')?.startsWith('blob:')),
    )
    if (styles.length) {
      // Mounted synchronously during DOMContentLoaded, these sheets delay the
      // document's load event, including recursive imports in SVG styles.
      // SVG style elements do not consistently dispatch their own load event.
      // Non-loading links and browser-rejected CSS types cannot hold this wait.
      loaded.push(
        new Promise<void>((resolve, reject) => {
          const finish = (error?: Error) => {
            window.removeEventListener('load', complete)
            window.removeEventListener('pagehide', cancelled)
            for (const element of styles)
              element.removeEventListener('error', failed)
            if (error) reject(error)
            else resolve()
          }
          const complete = () => finish()
          const failed = () => finish(new Error('Print stylesheet failed'))
          const cancelled = () =>
            finish(new Error('Print stylesheet cancelled'))
          window.addEventListener('load', complete, { once: true })
          window.addEventListener('pagehide', cancelled, { once: true })
          for (const element of styles)
            element.addEventListener('error', failed, { once: true })
        }),
      )
    }
    document.documentElement.replaceWith(root)
    await Promise.all(loaded)
    ready(urls)
  } catch (error) {
    for (const url of urls.values()) URL.revokeObjectURL(url)
    throw error
  }
}

export function isolatedPrintHtml(
  doc: InertExportDocument,
  channel: string,
): string {
  const registrations = (printViewportRegistrations.get(doc) ?? []).map(
    (registration) => ({
      ...registration,
      stylesheet: undefined as string | undefined,
    }),
  )
  const sheets: Array<{ token: string; css: string }> = []
  const embedded = new Map<string, string>()
  const localSheet = (uri: string): string => {
    if (!uri.startsWith('data:text/css;base64,'))
      throw new Error('Print stylesheet was not embedded')
    // CSS fragments do not select stylesheet content. Keep one blob identity
    // for equal bytes so an inactive fragment alias cannot replace provenance.
    const content = uri.split('#', 1)[0]
    const existing = embedded.get(content)
    if (existing) return existing
    const token = `urn:artifactshare:print-css:${crypto.randomUUID()}`
    const bytes = atob(content.slice(content.indexOf(',') + 1))
    const css = new TextDecoder().decode(
      Uint8Array.from(bytes, (c) => c.charCodeAt(0)),
    )
    for (const registration of registrations)
      if (css.includes(registration.condition)) registration.stylesheet = token
    const rewritten = replaceExportCssImports(css, localSheet)
    embedded.set(content, token)
    sheets.push({ token, css: rewritten })
    return token
  }
  for (const style of doc.querySelectorAll('style')) {
    if (isExportCssType(style))
      style.textContent = replaceExportCssImports(
        style.textContent ?? '',
        localSheet,
      )
    // Inactive CSS was intentionally not acquired. Do not expose its raw
    // imports to a second parser in the renderable frame.
    else style.remove()
  }
  for (const link of doc.querySelectorAll('link[rel~="stylesheet" i]')) {
    const href = link.getAttribute('href')?.trim() ?? ''
    if (
      link.hasAttribute('disabled') ||
      !href ||
      href.startsWith('#') ||
      !isExportCssType(link)
    ) {
      // Even a fragment URL resolves against the embedding application's URL
      // in srcdoc. Never mount a link that was intentionally not acquired.
      link.remove()
      continue
    }
    link.setAttribute('href', localSheet(href))
  }
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' data: blob:; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
  const meta = doc.createElement('meta')
  meta.httpEquiv = 'Content-Security-Policy'
  meta.content = policy
  doc.head.insertBefore(meta, doc.head.firstChild)
  // The first (anonymous) important layer outranks artifact stylesheet rules,
  // including later named layers, without changing [style] selector matching.
  // Keep it after the CSP and before every artifact stylesheet.
  const motion = doc.createElement('style')
  motion.textContent = '@layer{*,*::before,*::after{transition:none!important}}'
  doc.head.insertBefore(motion, meta.nextSibling)
  // Nonce hiding can clear the content attribute when a script is inserted.
  // Serialize the trusted script explicitly so its nonce survives outerHTML.
  const code = `(${printFrameHelper.toString()})(${JSON.stringify(channel)},${JSON.stringify(window.location.origin)},${JSON.stringify(registrations).replaceAll('<', '\\u003c')},sheetUrls,(${isExportCssType.toString()}),${JSON.stringify(printFontFaces.get(doc) ?? [])})`
  const html = doc.documentElement.outerHTML
  const end = html.lastIndexOf('</body>')
  if (!sheets.length)
    return `<!doctype html>${html.slice(0, end)}<script nonce="${nonce}">const sheetUrls = new Map();${code}</script>${html.slice(end)}`
  // Mount only after all CSS URLs belong to this opaque document. Its initial
  // CSP stays active while imported nodes load; inert parsing executes no script.
  const args = JSON.stringify([html, sheets]).replaceAll('<', '\\u003c')
  return `<!doctype html><html><head>${meta.outerHTML}<script nonce="${nonce}">document.addEventListener('DOMContentLoaded',()=>{(${mountPrintDocument.toString()})(...${args},(sheetUrls)=>{${code}},(${isExportCssType.toString()})).catch(error=>console.error('Print stylesheet preparation failed',error))},{once:true})</script></head><body></body></html>`
}
