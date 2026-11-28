import { createRoot } from 'react-dom/client'
import { PdfViewerApp } from './pdf-viewer-app'
import { createPreferencesStore } from '../shared/preferences-store'
import { PdfViewerRuntime } from './runtime'
import { connectPdfPageBridge } from './page-bridge'
import './viewer.css'

const preferences = createPreferencesStore()
const mount = document.getElementById('pdf-viewer-root')
if (mount) {
  const runtime = new PdfViewerRuntime()
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
