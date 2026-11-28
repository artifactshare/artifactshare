import { useState, useSyncExternalStore } from 'react'

// One store per mount. A shared module store let a second table of contents
// reset the first one's highlight and receive its notifications.
function createGuideTocStore() {
  let activeId: string | null = null
  const listeners = new Set<() => void>()

  function subscribe(onStoreChange: () => void): () => void {
    listeners.add(onStoreChange)
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

  return { subscribe, getSnapshot }
}

function getServerSnapshot(): string | null {
  return null
}

export function useGuideToc(): string | null {
  const [store] = useState(createGuideTocStore)
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    getServerSnapshot,
  )
}
