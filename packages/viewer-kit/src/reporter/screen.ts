import { MAX_COMMENT_LOCATION_LENGTH } from './comment-location.js'
import { send } from './messaging.js'
import type { ReporterState } from './state.js'

// Local preview only: the URL state an interactive document shows inside the
// sandbox, kept exactly as the document wrote it so it can be restored as is.
// The default screen is ''. Non-URL state is deliberately not tracked.

function fragmentScreen(ctx: ReporterState, hash: string): string {
  // An empty route is how hash routers spell the default screen.
  if (hash === '' || hash === '#' || hash === '#/' || hash === '#!/') return ''
  if (hash.startsWith('#/') || hash.startsWith('#!/')) return hash
  let id = hash.slice(1)
  try {
    id = decodeURIComponent(id)
  } catch {
    /* A malformed escape cannot name an element; it is a screen. */
  }
  // An in-page fragment scrolls to a target in the same screen.
  if (ctx.doc.getElementById(id) || ctx.doc.getElementsByName(id).length > 0)
    return ''
  return hash
}

// A stable short name for a screen too long to store; it cannot be restored.
function digest(value: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return '~' + (hash >>> 0).toString(16) + ':' + value.length
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
  const screen =
    (pathname === ctx.previewHomePath ? '' : pathname) +
    fragmentScreen(ctx, hash)
  return screen.length <= MAX_COMMENT_LOCATION_LENGTH ? screen : digest(screen)
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
  // A digest names a screen that was too long to keep; it cannot be shown.
  if (screen.startsWith('~')) {
    ctx.win.setTimeout(() => reportScreen(ctx, true), 50)
    return
  }
  const hashIndex = screen.indexOf('#')
  const path = hashIndex === -1 ? screen : screen.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : screen.slice(hashIndex)
  try {
    const target = path === '' ? ctx.previewHomePath : path
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
