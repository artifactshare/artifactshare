import { useEffect } from 'react'

// The browser can restore a page from its back/forward cache with the exact
// DOM the user left: a submission result or an open dialog from before the
// user moved on. Settings pages show state that has to come from the server, so
// a restored page loads again instead.
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
