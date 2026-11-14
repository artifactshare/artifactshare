import {
  canonicalCommentPathname,
  canonicalCommentRouteHash,
  MAX_COMMENT_LOCATION_LENGTH,
} from './comment-location.js'
import { send } from './messaging.js'
import type { ReporterState } from './state.js'

// Local preview only: the URL state an interactive document shows inside the
// sandbox. The default screen is ''. Non-URL state is deliberately not tracked.

function fragmentScreen(ctx: ReporterState, hash: string): string | null {
  if (hash === '' || hash === '#') return ''
  const route = canonicalCommentRouteHash(hash)
  if (route === null) return null
  if (route !== '') return route
  let id: string
  try {
    id = decodeURIComponent(hash.slice(1))
  } catch {
    return null
  }
  // An in-page fragment scrolls to a target in the same screen.
  if (ctx.doc.getElementById(id) || ctx.doc.getElementsByName(id).length > 0)
    return ''
  try {
    return '#' + encodeURIComponent(id)
  } catch {
    return null
  }
}

export function previewScreen(ctx: ReporterState): string | null {
  let pathname: string
  let hash: string
  try {
    pathname = ctx.win.location.pathname
    hash = ctx.win.location.hash
  } catch {
    return null
  }
  if (!ctx.previewHomePath) ctx.previewHomePath = pathname
  let path = ''
  if (pathname !== ctx.previewHomePath) {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return null
    }
    const canonical = canonicalCommentPathname(decoded, true)
    if (canonical === null) return null
    path = canonical
  }
  const fragment = fragmentScreen(ctx, hash)
  if (fragment === null) return null
  const screen = path + fragment
  return screen.length <= MAX_COMMENT_LOCATION_LENGTH ? screen : null
}

/** Reports the current screen when it changed (or when forced). */
export function reportScreen(ctx: ReporterState, force = false) {
  if (!ctx.previewCapability) return
  // History API changes have no event; a cheap string comparison catches
  // them. Hosted viewers never start this check.
  if (!ctx.previewScreenTimer)
    ctx.previewScreenTimer = ctx.win.setInterval(() => reportScreen(ctx), 250)
  const screen = previewScreen(ctx)
  if (screen === null || (!force && screen === ctx.previewLastScreen)) return
  ctx.previewLastScreen = screen
  send(ctx, { kind: 'screen', screen })
}

/** Restores a screen the parent recorded, then reports the result. */
export function showScreen(ctx: ReporterState, screen: unknown) {
  if (!ctx.previewCapability || typeof screen !== 'string') return
  if (screen.length > MAX_COMMENT_LOCATION_LENGTH) return
  const hashIndex = screen.indexOf('#')
  const path = hashIndex === -1 ? screen : screen.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : screen.slice(hashIndex)
  try {
    // Stored paths are decoded; encode each segment again for the URL.
    const target =
      path === ''
        ? ctx.previewHomePath
        : path.split('/').map(encodeURIComponent).join('/')
    if (
      target &&
      target[0] === '/' &&
      !target.startsWith('//') &&
      target !== ctx.win.location.pathname
    ) {
      // Same-document only: a router listening to popstate renders the route.
      ctx.win.history.pushState(null, '', target + ctx.win.location.search)
      ctx.win.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    }
    // Fragment navigation only: WebKit forbids the History API in the
    // opaque-origin sandbox. An in-page fragment already shows the default
    // screen, so it is left in place.
    if (hash !== fragmentScreen(ctx, ctx.win.location.hash))
      ctx.win.location.hash = hash
  } catch {
    /* Report whatever screen is current. */
  }
  // Routers render on the events above; report after they had a chance.
  ctx.win.setTimeout(() => reportScreen(ctx, true), 50)
}

export function installScreenTracking(ctx: ReporterState) {
  const check = () => reportScreen(ctx)
  ctx.win.addEventListener('hashchange', check)
  ctx.win.addEventListener('popstate', check)
}
