import { send } from './messaging.js'
import type { ReporterState } from './state.js'

export function reportHash(ctx: ReporterState) {
  try {
    if (ctx.readyChallenge && ctx.documentToken) {
      send(ctx, {
        kind: 'hash-changed',
        hash: ctx.win.location.hash,
        path: ctx.win.location.pathname,
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
  const original = ctx.win.history[method]
  ctx.win.history[method] = function (
    this: History,
    ...args: Parameters<History['pushState']>
  ) {
    const result = ctx.primordials.reflectApply(original, this, args)
    reportHash(ctx)
    return result
  }
}
