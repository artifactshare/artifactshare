import { send } from './messaging.js'
import type { ReporterState } from './state.js'

export function reportHash(ctx: ReporterState, force = false) {
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
