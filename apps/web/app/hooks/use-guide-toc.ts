import { useSyncExternalStore } from 'react'

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

function getServerSnapshot(): string | null {
  return null
}

export function useGuideToc(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
