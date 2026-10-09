import { startTransition, StrictMode } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { HydratedRouter } from 'react-router/dom'
import { restoreViewerHash } from './lib/viewer-hash'

restoreViewerHash()

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  )
})
