import { useSyncExternalStore } from 'react'

// Scroll-spy for guide pages: reports which [data-toc-section] is currently in
// view so the rail can highlight it. Modeled as an external store (subscribe to
// an IntersectionObserver, snapshot the active id) rather than useState set from
// a mount effect. Only one guide rail is mounted at a time, so a module-level
// value is safe. Progressive enhancement: without JS the rail links and anchors
// still work, just without the live marker.
let activeId: string | null = null
const listeners = new Set<() => void>()

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  // Start each mount without a marker instead of inheriting the previous guide
  // page's active section. React re-reads the snapshot after subscribe, so the
  // rail paints clean and the observer below fills in the real section. Without
  // this, a client navigation between guide pages (which reuse section ids like
  // share/update) would flash the prior page's highlight.
  activeId = null
  const sections = Array.from(
    document.querySelectorAll<HTMLElement>('[data-toc-section]'),
  )
  let observer: IntersectionObserver | null = null
  if (sections.length > 0) {
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        const top = visible[0]
        if (top && top.target.id !== activeId) {
          activeId = top.target.id
          for (const listener of listeners) listener()
        }
      },
      { rootMargin: '-72px 0px -70% 0px', threshold: 0 },
    )
    for (const section of sections) observer.observe(section)
  }
  return () => {
    listeners.delete(onStoreChange)
    observer?.disconnect()
  }
}

function getSnapshot(): string | null {
  return activeId
}

function getServerSnapshot(): string | null {
  return null
}

export function useGuideToc(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
