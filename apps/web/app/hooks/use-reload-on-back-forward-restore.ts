import { useEventListener } from './use-event-listener'

function reloadPage() {
  window.location.reload()
}

export function useReloadOnBackForwardRestore(reload: () => void = reloadPage) {
  useEventListener('window', 'pageshow', (event) => {
    if (event.persisted) reload()
  })
}
