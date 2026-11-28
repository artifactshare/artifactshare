import { useEffect } from 'react'

export function useDocumentAttribute(name: string, value: string) {
  useEffect(() => {
    const html = document.documentElement
    const previous = html.getAttribute(name)
    html.setAttribute(name, value)
    return () => {
      if (previous === null) html.removeAttribute(name)
      else html.setAttribute(name, previous)
    }
  }, [name, value])
}
