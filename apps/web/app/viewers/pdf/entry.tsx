import { createRoot } from 'react-dom/client'
import { PdfViewerApp } from './pdf-viewer-app'
import { createPreferencesStore } from '../shared/preferences-store'
import { PdfViewerRuntime } from './runtime'
import './viewer.css'

// The sandbox serves this module as /__as_pdf/viewer.js on every PDF
// version's origin; the generated page provides the mount point with the
// download name and link.
const preferences = createPreferencesStore()
const mount = document.getElementById('pdf-viewer-root')
if (mount)
  createRoot(mount).render(
    <PdfViewerApp
      runtime={new PdfViewerRuntime()}
      preferences={preferences}
      fileName={mount.dataset.fileName || 'document.pdf'}
      downloadHref={mount.dataset.downloadHref ?? ''}
    />,
  )
