import { useEffect } from 'react'

function reloadPage() {
  window.location.reload()
}

export function useReloadOnBackForwardRestore(reload: () => void = reloadPage) {
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) reload()
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [reload])
}
