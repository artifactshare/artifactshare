import { createRoot } from 'react-dom/client'
import { createPreferencesStore } from '../shared/preferences-store'
import { VideoPlayerRuntime } from './runtime'
import { VideoViewerApp } from './video-viewer-app'
import './viewer.css'

// The sandbox serves this module as /__as_video/viewer.js on every video
// version's origin. The generated page provides the mount point with the
// download name and link, and a <video> element with native controls and a
// download link that work if this script never runs. The player takes the
// element over and renders its own controls around it.
const preferences = createPreferencesStore()
const mount = document.getElementById('video-viewer-root')
const video = document.getElementById('video')
if (mount && video instanceof HTMLVideoElement) {
  const fileName = mount.dataset.fileName || 'video.mp4'
  const downloadHref = mount.dataset.downloadHref ?? ''
  const runtime = new VideoPlayerRuntime(video)
  // Only the element stays; React's first commit moves it into the picture.
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
