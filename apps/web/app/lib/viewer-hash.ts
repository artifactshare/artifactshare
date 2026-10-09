/** Carry a viewer fragment through auth's fragment-free callback validator. */
export function viewerReturnPath(path: string, hash: string) {
  const url = new URL(path, 'https://example.test')
  url.hash = ''
  url.searchParams.delete('as_hash')
  if (hash.startsWith('#') && hash.length <= 2048)
    url.searchParams.set('as_hash', hash)
  // URLSearchParams leaves '*' literal, but auth's callback query grammar does not.
  return url.pathname + url.search.replace(/\*/g, '%2A')
}

// Keep this literal identical in server/client builds so hydration does not
// compare differently minified function sources. The client mount path below
// receives the restored fragment before choosing src.
export const VIEWER_FRAME_BOOTSTRAP_SCRIPT =
  "{const u=new URL(window.location.href),h=u.searchParams.get('as_hash');if(h!==null){u.searchParams.delete('as_hash');if(h.startsWith('#')&&h.length<=2048)u.hash=h;window.history.replaceState(window.history.state,'',u.pathname+u.search+u.hash)}const f=document.currentScript.previousElementSibling;if(!f.hasAttribute('src'))f.src=f.dataset.src+window.location.hash}"

// Run at app entry before the router reads the browser location.
export function restoreViewerHash() {
  const url = new URL(window.location.href)
  const hash = url.searchParams.get('as_hash')
  if (hash === null) return
  url.searchParams.delete('as_hash')
  if (hash.startsWith('#') && hash.length <= 2048) url.hash = hash
  window.history.replaceState(
    window.history.state,
    '',
    url.pathname + url.search + url.hash,
  )
}

let activeHashSync: { latest: () => string } | undefined

export function latestViewerHash() {
  return activeHashSync?.latest() ?? window.location.hash
}

/** Bound outer history writes while retaining the most recently accepted state. */
export function createViewerHashSync() {
  let pending: { hash: string; path: string } | null = null
  const currentPath = () => window.location.pathname + window.location.search
  const notify = () =>
    window.dispatchEvent(new Event('artifactshare:hash-changed'))
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    clearTimeout(timer)
    timer = undefined
    pending = null
    if (activeHashSync === sync) activeHashSync = undefined
    notify()
  }
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    const next = pending?.hash
    if (
      !pending ||
      pending.path !== currentPath() ||
      next === window.location.hash
    ) {
      clear()
      return
    }
    try {
      window.history.replaceState(
        window.history.state,
        '',
        next || window.location.pathname + window.location.search,
      )
      clear()
    } catch {
      // Retain a denied write and retry at the same bounded rate, even if no
      // further report arrives. New reports replace pending; clear cancels it.
      if (pending !== null) timer = setTimeout(flush, 200)
    }
  }
  const sync = {
    clear,
    flush,
    latest: () =>
      pending?.path === currentPath() ? pending.hash : window.location.hash,
    accept(hash: string) {
      pending = { hash, path: currentPath() }
      activeHashSync = sync
      notify()
      if (timer !== undefined) return
      timer = setTimeout(flush, 200)
    },
  }
  return sync
}
