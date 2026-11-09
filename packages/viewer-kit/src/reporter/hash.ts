import { send } from './messaging.js'
import type { ReporterState } from './state.js'
import { commentLocationFromUrl } from './comment-location.js'
import { clearMarks, scheduleChecking } from './highlights.js'

/** The location comments on this document belong to, or null if unusable. */
export function liveCommentLocation(ctx: ReporterState): string | null {
  if (!ctx.locationScoped) return ctx.displayedPath
  try {
    return commentLocationFromUrl(
      ctx.win.location.pathname,
      ctx.win.location.hash,
    )
  } catch (e) {
    return null
  }
}

// A same-document route change retires the previous route's paint, checks and
// pending jump at once. The parent sends the new route's highlights.
export function retireStaleLocation(ctx: ReporterState) {
  if (!ctx.locationScoped) return
  let location = liveCommentLocation(ctx)
  if (location === ctx.lastLocation) return
  let previous = ctx.lastLocation
  ctx.lastLocation = location
  // A selection made on the previous location (possibly still in the DOM
  // while the next route renders) must never become a draft here.
  ctx.locationGeneration++
  if (previous !== null) {
    let selection = ctx.win.getSelection()
    if (selection && selection.rangeCount) selection.removeAllRanges()
  }
  if (ctx.displayedPath === location) return
  ctx.pendingHighlights = []
  ctx.pendingScrollThreadId = null
  ctx.checkingHighlights = []
  ctx.checkingDeadlines = {}
  ctx.lastResolutionSignature = ''
  clearMarks(ctx)
  scheduleChecking(ctx)
}

export function reportHash(ctx: ReporterState, force = false) {
  try {
    retireStaleLocation(ctx)
  } catch (e) {}
  try {
    if (ctx.readyChallenge && ctx.documentToken) {
      const hash = ctx.win.location.hash
      const path = ctx.win.location.pathname
      if (!force && ctx.lastHash === hash && ctx.lastHashPath === path) return
      ctx.lastHash = hash
      ctx.lastHashPath = path
      send(ctx, {
        kind: 'hash-changed',
        hash,
        path,
        token: ctx.documentToken,
      })
    }
  } catch (e) {}
}

export function installHashTracking(ctx: ReporterState) {
  ctx.primordials.addEventListener(ctx.win, 'hashchange', () => reportHash(ctx))
  // Back and forward between same-document history entries.
  ctx.primordials.addEventListener(ctx.win, 'popstate', () => reportHash(ctx))
  wrapHistory(ctx, 'pushState')
  wrapHistory(ctx, 'replaceState')
}

function wrapHistory(ctx: ReporterState, method: 'pushState' | 'replaceState') {
  const prototype = ctx.primordials.getPrototypeOf(ctx.win.history) as History
  const original = prototype[method]
  // Capture once so authored patches can chain through this wrapper safely.
  prototype[method] = function (
    this: History,
    ...args: Parameters<History['pushState']>
  ) {
    const result = ctx.primordials.reflectApply(original, this, args)
    reportHash(ctx)
    return result
  }
}
