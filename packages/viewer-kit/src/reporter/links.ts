import type { ReporterState } from './state.js'
import { readEventValue, send } from './messaging.js'
import { hitComment } from './badges.js'

export function trusted(ctx: ReporterState, event: Event) {
  try {
    return ctx.primordials.trustedGetter && ctx.primordials.trustedGetter.get
      ? ctx.primordials.trustedGet!(event) === true
      : event.isTrusted === true
  } catch (e) {
    return false
  }
}

export function shouldHandleLink(ctx: ReporterState, url: URL) {
  if (url.origin !== ctx.win.location.origin) return true
  if (url.pathname !== ctx.win.location.pathname) return true
  if (url.search !== ctx.win.location.search && url.search !== '') return true
  return false
}

export function openExternalLink(ctx: ReporterState, href: string) {
  ctx.win.open(href, '_blank', 'noopener,noreferrer')
}

export function isExternallyOpenable(ctx: ReporterState, url: URL) {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

export function prepareLinkClick(ctx: ReporterState, event: MouseEvent) {
  let defaultPrevented = readEventValue(
    ctx,
    ctx.primordials.defaultPreventedGet,
    event,
  )
  let button = readEventValue(ctx, ctx.primordials.buttonGet, event)
  let metaKey = readEventValue(ctx, ctx.primordials.metaKeyGet, event)
  let ctrlKey = readEventValue(ctx, ctx.primordials.ctrlKeyGet, event)
  let shiftKey = readEventValue(ctx, ctx.primordials.shiftKeyGet, event)
  let altKey = readEventValue(ctx, ctx.primordials.altKeyGet, event)
  if (
    !trusted(ctx, event) ||
    defaultPrevented !== false ||
    button !== 0 ||
    metaKey !== false ||
    ctrlKey !== false ||
    shiftKey !== false ||
    altKey !== false
  ) {
    return
  }
  if (hitComment(ctx, event)) return
  let target = readEventValue(
    ctx,
    ctx.primordials.targetGet,
    event,
  ) as Node | null
  let element =
    target && target.nodeType === 1
      ? (target as Element)
      : target && target.parentElement
  if (
    element &&
    ctx.primordials.closest(
      element,
      '.ash-comment-highlight, .ash-comment-highlight-badge',
    )
  ) {
    return
  }
  let anchor = element ? ctx.primordials.closest(element, 'a[href]') : null
  if (!anchor || ctx.primordials.hasAttribute(anchor, 'download')) return
  let rawHref = ctx.primordials.getAttribute(anchor, 'href')
  if (!rawHref || rawHref.charAt(0) === '#') return

  let url
  let href
  let openExternally = false
  try {
    url = new ctx.win.URL(rawHref, ctx.win.location.href)
    if (!shouldHandleLink(ctx, url)) return
    href = url.href
    openExternally =
      url.origin !== ctx.win.location.origin && isExternallyOpenable(ctx, url)
  } catch (e) {
    href = rawHref
  }

  let pending = ctx.primordials.objectCreate(null)
  pending.artifactPrevented = false
  pending.href = href
  pending.openExternally = openExternally
  try {
    ctx.primordials.defineProperty(event, 'preventDefault', {
      configurable: true,
      value: function () {
        pending.artifactPrevented = true
        ctx.primordials.preventDefault(event)
      },
    })
    ctx.primordials.defineProperty(event, 'defaultPrevented', {
      configurable: true,
      get: function () {
        return pending.artifactPrevented
      },
    })
    ctx.primordials.weakMapSet(ctx.pendingLinkClicks, event, pending)
  } catch (e) {
    // If the event cannot be wrapped, suppress navigation rather than bypass the gate.
    ctx.primordials.preventDefault(event)
    return
  }
  ctx.primordials.preventDefault(event)
}

export function finishLinkClick(ctx: ReporterState, event: MouseEvent) {
  let pending = ctx.primordials.weakMapGet(ctx.pendingLinkClicks, event)
  if (!pending) return
  ctx.primordials.weakMapDelete(ctx.pendingLinkClicks, event)
  if (pending.artifactPrevented) return
  if (pending.openExternally && ctx.externalLinkPolicyMode === 'direct') {
    openExternalLink(ctx, pending.href)
    return
  }
  send(ctx, {
    kind: 'link-clicked',
    href: pending.href,
    token: ctx.documentToken,
  })
}
