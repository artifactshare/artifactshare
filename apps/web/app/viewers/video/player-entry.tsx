import { createRoot } from 'react-dom/client'
import { createPreferencesStore } from '../shared/preferences-store'
import { VideoPlayerRuntime } from './runtime'
import { VideoViewerApp } from './video-viewer-app'
import './viewer.css'

const preferences = createPreferencesStore()
const mount = document.getElementById('video-viewer-root')
const video = document.getElementById('video')
if (mount && video instanceof HTMLVideoElement) {
  const fileName = mount.dataset.fileName || 'video.mp4'
  const downloadHref = mount.dataset.downloadHref ?? ''
  const runtime = new VideoPlayerRuntime(video)
  mount.replaceChildren(video)
  createRoot(mount).render(
    <VideoViewerApp
      runtime={runtime}
      preferences={preferences}
      fileName={fileName}
      downloadHref={downloadHref}
    />,
  )
}
