import { scheduleScreenReport } from './screen.js'
import { send } from './messaging.js'
import type { ReporterState } from './state.js'
import { commentLocationFromUrl } from './comment-location.js'
import { clearMarks, scheduleChecking } from './highlights.js'

export function liveCommentLocation(ctx: ReporterState): string | null {
  if (!ctx.locationScoped) return ctx.displayedPath
  try {
    return commentLocationFromUrl(
      ctx.win.location.pathname,
      ctx.win.location.hash,
      ctx.fallbackToIndex,
    )
  } catch (e) {
    return null
  }
}

export function retireStaleLocation(ctx: ReporterState) {
  if (!ctx.locationScoped) return
  let location = liveCommentLocation(ctx)
  if (location === ctx.lastLocation) return
  let previous = ctx.lastLocation
  ctx.lastLocation = location
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
  scheduleScreenReport(ctx)
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
