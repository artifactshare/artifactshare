import { createRoot } from 'react-dom/client'
import { PdfViewerApp } from './pdf-viewer-app'
import { createPreferencesStore } from '../shared/preferences-store'
import { PdfViewerRuntime } from './runtime'
import { connectPdfPageBridge } from './page-bridge'
import './viewer.css'

// The sandbox serves this module as /__as_pdf/viewer.js on every PDF
// version's origin; the generated page provides the mount point with the
// download name and link.
const preferences = createPreferencesStore()
const mount = document.getElementById('pdf-viewer-root')
if (mount) {
  const runtime = new PdfViewerRuntime()
  // Connected before rendering, so no page change goes unreported.
  connectPdfPageBridge(runtime)
  createRoot(mount).render(
    <PdfViewerApp
      runtime={runtime}
      preferences={preferences}
      fileName={mount.dataset.fileName || 'document.pdf'}
      downloadHref={mount.dataset.downloadHref ?? ''}
    />,
  )
}
