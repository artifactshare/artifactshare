/**
 * One rectangle of ink an element paints: either a `surface` (background,
 * border edge, or replaced element box) or a run of `text`. `fontSize` is
 * carried on text rects only, so that a gap between two different type sizes
 * can be told apart from a gap inside one block of running text.
 *
 * @typedef {{
 *   top: number,
 *   bottom: number,
 *   left: number,
 *   right: number,
 *   width: number,
 *   height: number,
 *   kind: 'surface' | 'text',
 *   fontSize?: number,
 * }} InkRect
 *
 * @typedef {{ tag: string, class: string, text: string }} BoxDescription
 * @typedef {{ tag: string, role?: string, text: string }} ControlDescription
 *
 * @typedef {{
 *   audit: 'vertical',
 *   gap: number,
 *   kind: 'text-text' | 'surface',
 *   parent: BoxDescription,
 *   a: BoxDescription,
 *   b: BoxDescription,
 * }} VerticalGapFinding
 *
 * @typedef {{
 *   audit: 'interactive',
 *   axis: 'vertical' | 'horizontal',
 *   gap: number,
 *   a: ControlDescription,
 *   b: ControlDescription,
 * }} InteractiveGapFinding
 *
 * @typedef {VerticalGapFinding | InteractiveGapFinding} GapFinding
 */

/**
 * The function is self-contained because Playwright serializes it into
 * page.evaluate().
 *
 * @param {{ rootSelector?: string, minGap?: number }} [options]
 * @returns {GapFinding[]}
 */
export function auditGaps({
  rootSelector = 'body',
  minGap: verticalMinGap = 4,
} = {}) {
  const root = document.querySelector(rootSelector)
  if (!root) return []
  const interactiveMinGap = 4
  /**
   * @param {Element} element
   * @returns {InkRect[]}
   */
  const rects = (element) => {
    const style = getComputedStyle(element)
    /** @type {InkRect[]} */
    const result = []
    // opacity composites the whole subtree away; visibility can be overridden
    // by descendants, so it only hides this element's own ink below.
    if (parseFloat(style.opacity) < 0.05) return result
    const selfHidden =
      style.visibility === 'hidden' || style.visibility === 'collapse'
    if (style.display === 'contents') {
      // contents wrappers render nothing themselves but their children do
      for (const child of element.children) result.push(...rects(child))
      return result
    }
    /**
     * @param {DOMRect} rect
     * @param {InkRect['kind']} kind
     */
    const add = (rect, kind) => {
      // DOMRect properties live on the prototype, so spreading one yields {}.
      if (rect.width >= 2 && rect.height >= 2)
        result.push({
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
          kind,
        })
    }
    /** @param {string} color */
    const isOpaque = (color) => {
      const alpha = color.match(
        /rgba?\([^,]+,[^,]+,[^,]+(?:,\s*([^)]+))?\)/,
      )?.[1]
      return color !== 'transparent' && Number.parseFloat(alpha ?? '1') > 0
    }
    let ancestor = element.parentElement
    let ancestorBackground = null
    while (ancestor) {
      const ancestorStyle = getComputedStyle(ancestor)
      if (isOpaque(ancestorStyle.backgroundColor)) {
        ancestorBackground = ancestorStyle.backgroundColor
        break
      }
      ancestor = ancestor.parentElement
    }
    const background =
      style.backgroundImage !== 'none' ||
      (isOpaque(style.backgroundColor) &&
        style.backgroundColor !== ancestorBackground)
    const replacement =
      /^(IMG|SVG|VIDEO|CANVAS|IFRAME|INPUT|TEXTAREA|SELECT|BUTTON)$/.test(
        element.tagName,
      )
    if (!selfHidden && (background || replacement))
      add(element.getBoundingClientRect(), 'surface')
    const box = element.getBoundingClientRect()
    /**
     * The four border edges in `Top, Right, Bottom, Left` order. `side`
     * decides which box edge the band hugs; `lineStyle` and `lineWidth` are
     * the computed `border<Side>Style` and `border<Side>Width`.
     *
     * @type {{
     *   side: 'Top' | 'Right' | 'Bottom' | 'Left',
     *   lineStyle: string,
     *   lineWidth: string,
     * }[]}
     */
    const borderEdges = [
      {
        side: 'Top',
        lineStyle: style.borderTopStyle,
        lineWidth: style.borderTopWidth,
      },
      {
        side: 'Right',
        lineStyle: style.borderRightStyle,
        lineWidth: style.borderRightWidth,
      },
      {
        side: 'Bottom',
        lineStyle: style.borderBottomStyle,
        lineWidth: style.borderBottomWidth,
      },
      {
        side: 'Left',
        lineStyle: style.borderLeftStyle,
        lineWidth: style.borderLeftWidth,
      },
    ]
    for (const { side, lineStyle, lineWidth } of borderEdges) {
      if (!selfHidden && lineStyle !== 'none' && parseFloat(lineWidth) > 0) {
        const horizontalBand = side === 'Top' || side === 'Bottom'
        const width = horizontalBand ? box.width : parseFloat(lineWidth)
        const height = horizontalBand ? parseFloat(lineWidth) : box.height
        if (width > 0 && height > 0)
          result.push({
            top: side === 'Bottom' ? box.bottom - height : box.top,
            bottom: side === 'Top' ? box.top + height : box.bottom,
            left: box.left,
            right: box.right,
            width,
            height,
            kind: 'surface',
          })
      }
    }
    for (const child of element.childNodes) {
      if (
        !selfHidden &&
        child.nodeType === Node.TEXT_NODE &&
        child.textContent?.trim()
      ) {
        const range = document.createRange()
        range.selectNodeContents(child)
        const fontSize = parseFloat(style.fontSize)
        for (const rect of range.getClientRects()) {
          add(rect, 'text')
          if (result.length && result[result.length - 1].kind === 'text')
            result[result.length - 1].fontSize = fontSize
        }
      } else if (child.nodeType === Node.ELEMENT_NODE)
        result.push(...rects(/** @type {Element} */ (child)))
    }
    return result
  }
  /** @param {Element} element */
  const describedText = (element) => {
    if (element.closest('[data-gap-audit-redact]')) return '[redacted]'
    const copy = /** @type {Element} */ (element.cloneNode(true))
    for (const secret of copy.querySelectorAll('[data-gap-audit-redact]'))
      secret.textContent = '[redacted]'
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  }
  /**
   * @param {Element} element
   * @returns {BoxDescription}
   */
  const describe = (element) => ({
    tag: element.tagName.toLowerCase(),
    class:
      typeof element.className === 'string'
        ? element.className.split(/\s+/).filter(Boolean).slice(0, 2).join(' ')
        : '',
    text: describedText(element),
  })
  /** @type {GapFinding[]} */
  const findings = []
  /** @param {Element} parent */
  const walk = (parent) => {
    const children = [...parent.children].filter((element) => {
      const style = getComputedStyle(element)
      return (
        !element.hasAttribute('data-gap-audit-exempt') &&
        style.display !== 'contents' &&
        parseFloat(style.opacity) >= 0.05 &&
        !element.closest('[data-gap-audit-exempt]') &&
        !element.closest('a,button,summary,label')
      )
    })
    const parentWraps = getComputedStyle(parent).flexWrap === 'wrap'
    for (let i = 0; !parentWraps && i < children.length; i++)
      for (let j = i + 1; j < children.length; j++) {
        const a = children[i],
          b = children[j],
          sa = getComputedStyle(a),
          sb = getComputedStyle(b)
        if (
          ![sa.display, sb.display].every((display) =>
            ['block', 'flex', 'grid', 'list-item'].includes(display),
          )
        )
          continue
        const ar = a.getBoundingClientRect(),
          br = b.getBoundingClientRect()
        if (ar.width < 8 || ar.height < 8 || br.width < 8 || br.height < 8)
          continue
        if (
          Math.abs(ar.top - br.top) < 2 ||
          ar.right <= br.left ||
          br.right <= ar.left
        )
          continue
        const first = ar.top <= br.top ? [a, b] : [b, a]
        const firstRect = first[0] === a ? ar : br
        const secondRect = first[1] === b ? br : ar
        if (secondRect.top < firstRect.bottom - 2) continue
        if (first[1].hasAttribute('data-gap-audit-allow-touch')) continue
        const ai = rects(first[0]),
          bi = rects(first[1])
        if (!ai.length || !bi.length) continue
        const bottom = Math.max(...ai.map((rect) => rect.bottom)),
          top = Math.min(...bi.map((rect) => rect.top))
        const gap = top - bottom
        const bottomRect = ai.reduce((best, rect) =>
          rect.bottom > best.bottom ? rect : best,
        )
        const topRect = bi.reduce((best, rect) =>
          rect.top < best.top ? rect : best,
        )
        const kind =
          bottomRect.kind === 'text' && topRect.kind === 'text'
            ? 'text-text'
            : 'surface'
        if (
          kind === 'text-text' &&
          bottomRect.fontSize !== undefined &&
          topRect.fontSize !== undefined &&
          Math.abs(bottomRect.fontSize - topRect.fontSize) > 0.5
        )
          continue
        const threshold = kind === 'text-text' ? 2 : verticalMinGap
        if (gap > -2 && gap < threshold)
          findings.push({
            audit: 'vertical',
            gap,
            kind,
            parent: describe(parent),
            a: describe(first[0]),
            b: describe(first[1]),
          })
      }
    for (const child of parent.children) {
      const childStyle = getComputedStyle(child)
      if (parseFloat(childStyle.opacity) < 0.05) continue
      walk(child)
    }
  }
  walk(root)

  const interactiveSelector = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
  ].join(',')
  const candidates = [...root.querySelectorAll(interactiveSelector)].filter(
    (element) => {
      const clientRects = element.getClientRects()
      const rect = element.getBoundingClientRect()
      const elementStyle = getComputedStyle(element)
      if (
        elementStyle.visibility === 'hidden' ||
        elementStyle.visibility === 'collapse'
      )
        return false
      /** @type {Element | null} */
      let ancestor = element
      while (ancestor) {
        const style = getComputedStyle(ancestor)
        if (
          style.display === 'none' ||
          parseFloat(style.opacity) < 0.05 ||
          ancestor.getAttribute('aria-hidden') === 'true'
        )
          return false
        ancestor = ancestor.parentElement
      }
      return clientRects.length > 0 && rect.width > 0 && rect.height > 0
    },
  )
  const interactiveElements = candidates.filter(
    (element) =>
      !candidates.some((other) => other !== element && other.contains(element)),
  )
  /**
   * @param {Element} element
   * @returns {ControlDescription}
   */
  const describeInteractive = (element) => ({
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || undefined,
    text:
      element
        .getAttribute('aria-label')
        ?.replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || describedText(element),
  })
  for (let i = 0; i < interactiveElements.length; i++)
    for (let j = i + 1; j < interactiveElements.length; j++) {
      const a = interactiveElements[i],
        b = interactiveElements[j],
        ar = a.getBoundingClientRect(),
        br = b.getBoundingClientRect()
      const overlap =
        ar.left < br.right &&
        br.left < ar.right &&
        ar.top < br.bottom &&
        br.top < ar.bottom
      if (overlap) continue
      const vertical = ar.left < br.right && br.left < ar.right
      const horizontal = ar.top < br.bottom && br.top < ar.bottom
      const gap = vertical
        ? Math.max(br.top - ar.bottom, ar.top - br.bottom)
        : horizontal
          ? Math.max(br.left - ar.right, ar.left - br.right)
          : Infinity
      const axis = vertical ? 'vertical' : horizontal ? 'horizontal' : null
      if (!axis || gap < 0 || gap >= interactiveMinGap) continue
      const common = a.closest('[data-gap-audit-composite]')
      if (common && common === b.closest('[data-gap-audit-composite]')) continue
      findings.push({
        audit: 'interactive',
        axis,
        gap,
        a: describeInteractive(a),
        b: describeInteractive(b),
      })
    }
  return findings
}

/**
 * @param {{ rootSelector?: string, minGap?: number }} [options]
 * @returns {VerticalGapFinding[]}
 */
export function auditVerticalGaps(options = {}) {
  return auditGaps(options).filter(
    /** @returns {finding is VerticalGapFinding} */
    (finding) => finding.audit === 'vertical',
  )
}
