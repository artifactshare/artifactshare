// The sandbox serves a video artifact as a virtual bundle on its own sandbox
// origin: a generated player page at the entrypoint path, the shared player
// script and style, and the original MP4. Only the original carries artifact
// bytes; the page, script and style are the same on every origin and are
// never stored or charged per artifact. The player is the browser's native
// <video> element with our own controls below it.
import {
  VIDEO_ORIGINAL_PATH,
  VIDEO_PLAYBACK_RATES,
  VIDEO_PLAYER_SCRIPT_PATH,
  VIDEO_PLAYER_STYLE_PATH,
} from '../../app/viewers/video/paths'
import { VIDEO_VIEWER_SCRIPT } from './video-viewer-script.generated'
import { VIDEO_VIEWER_STYLE } from './video-viewer-style.generated'

export {
  VIDEO_ORIGINAL_PATH,
  VIDEO_PLAYBACK_RATES,
  VIDEO_PLAYER_SCRIPT_PATH,
  VIDEO_PLAYER_STYLE_PATH,
}
export const VIDEO_MIME_TYPE = 'video/mp4'

export interface VideoPlayerAsset {
  body: string
  contentType: string
}

// The player's own script and style, built from apps/web/app/viewers/video
// by apps/web/scripts/build-viewers.mjs.
export function videoPlayerAsset(path: string): VideoPlayerAsset | null {
  if (path === VIDEO_PLAYER_SCRIPT_PATH)
    return {
      body: VIDEO_VIEWER_SCRIPT,
      contentType: 'text/javascript; charset=utf-8',
    }
  if (path === VIDEO_PLAYER_STYLE_PATH)
    return { body: VIDEO_VIEWER_STYLE, contentType: 'text/css; charset=utf-8' }
  return null
}

// A safe download name: the entrypoint's last segment, reduced to characters
// that need no quoting, always ending in .mp4.
export function videoDownloadFileName(entrypointPath: string | null): string {
  const base = (entrypointPath ?? '').split('/').at(-1) ?? ''
  const stem = base
    .replace(/\.mp4$/i, '')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .replace(/^[.\s_-]+|[.\s_-]+$/g, '')
  // Cut by code point so a character outside the BMP is never split into a
  // lone surrogate, which encodeURIComponent rejects.
  const short = Array.from(stem).slice(0, 120).join('')
  return `${short || 'video'}.mp4`
}

export function videoContentDisposition(
  entrypointPath: string | null,
  attachment: boolean,
): string {
  const name = videoDownloadFileName(entrypointPath)
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '_')
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

// The generated page: a mount point for the player script with the download
// name and link. It holds the <video> element with native controls and a
// download link, so the video still plays and downloads if the script cannot
// run; the player then takes the element over. The document never contains
// artifact content other than its escaped file name, and the video never
// autoplays. It starts in the app's default language and the inherited color
// scheme; the player follows the app's preferences once its parent sends
// them.
export function videoPlayerDocument(entrypointPath: string | null): string {
  const fileName = escapeHtml(videoDownloadFileName(entrypointPath))
  const download = `${VIDEO_ORIGINAL_PATH}?download=1`
  return `<!doctype html>
<html lang="en" data-theme="system" data-video-state="loading">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fileName}</title>
<link rel="stylesheet" href="${VIDEO_PLAYER_STYLE_PATH}">
</head>
<body>
<div id="video-viewer-root" data-file-name="${fileName}" data-download-href="${download}">
<video id="video" controls playsinline preload="metadata" src="${VIDEO_ORIGINAL_PATH}"></video>
<p><a href="${download}" download="${fileName}">Download the original video</a></p>
</div>
<script type="module" src="${VIDEO_PLAYER_SCRIPT_PATH}"></script>
</body>
</html>`
}
