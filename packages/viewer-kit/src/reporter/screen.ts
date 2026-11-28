import { MAX_COMMENT_LOCATION_LENGTH } from './comment-location.js'
import { send } from './messaging.js'
import type { ReporterState } from './state.js'

function fragmentScreen(ctx: ReporterState, hash: string): string {
  if (hash === '#/' || hash === '#!/') return ''
  return hash.startsWith('#/') || hash.startsWith('#!/') ? hash : ''
}

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
  const screen =
    (pathname === ctx.previewHomePath ? '' : pathname) +
    fragmentScreen(ctx, hash)
  return screen.length <= MAX_COMMENT_LOCATION_LENGTH ? screen : digest(screen)
}

export function reportScreen(ctx: ReporterState, force = false) {
  if (!ctx.previewCapability) return
  const screen = previewScreen(ctx)
  if (screen === null || (!force && screen === ctx.previewLastScreen)) return
  ctx.previewLastScreen = screen
  send(ctx, { kind: 'screen', screen })
}

export function showScreen(ctx: ReporterState, screen: unknown) {
  if (!ctx.previewCapability || typeof screen !== 'string') return
  if (screen.length > MAX_COMMENT_LOCATION_LENGTH) return
  const restore = { screen, readerActed: false }
  ctx.previewRestore = restore
  if (screen.startsWith('~')) {
    finishShowScreen(ctx, restore)
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
  ctx.win.setTimeout(() => finishShowScreen(ctx, restore), 300)
}

function finishShowScreen(
  ctx: ReporterState,
  restore: { screen: string; readerActed: boolean },
) {
  if (ctx.previewRestore !== restore) return
  ctx.previewRestore = null
  reportScreen(ctx, true)
  const outcome = restore.readerActed
    ? 'superseded'
    : previewScreen(ctx) === restore.screen
      ? 'shown'
      : 'not-shown'
  send(ctx, { kind: 'screen-shown', screen: restore.screen, outcome })
}

export function scheduleScreenReport(ctx: ReporterState) {
  if (!ctx.previewCapability) return
  ctx.win.setTimeout(() => reportScreen(ctx), 0)
}

export function installScreenTracking(ctx: ReporterState) {
  const acted = (event: Event) => {
    if (ctx.previewRestore && event.isTrusted)
      ctx.previewRestore.readerActed = true
  }
  ctx.doc.addEventListener('pointerdown', acted, true)
  ctx.doc.addEventListener('keydown', acted, true)
  try {
    ctx.previewHomePath = ctx.win.location.pathname
  } catch {
    ctx.previewHomePath = '/'
  }
}
