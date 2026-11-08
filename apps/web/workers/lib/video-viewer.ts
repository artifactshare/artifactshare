// The sandbox serves a video artifact as a virtual bundle on its own sandbox
// origin: a generated player page at the entrypoint path, the shared player
// script and style, and the original MP4. Only the original carries artifact
// bytes; the page, script and style are the same on every origin and are
// never stored or charged per artifact. The player is the browser's native
// <video> element with our own controls below it.

export const VIDEO_ORIGINAL_PATH = '/__as_video/original.mp4'
export const VIDEO_PLAYER_SCRIPT_PATH = '/__as_video/viewer.js'
export const VIDEO_PLAYER_STYLE_PATH = '/__as_video/viewer.css'
export const VIDEO_MIME_TYPE = 'video/mp4'

export interface VideoPlayerAsset {
  body: string
  contentType: string
}

export function videoPlayerAsset(path: string): VideoPlayerAsset | null {
  if (path === VIDEO_PLAYER_SCRIPT_PATH)
    return {
      body: VIDEO_PLAYER_SCRIPT,
      contentType: 'text/javascript; charset=utf-8',
    }
  if (path === VIDEO_PLAYER_STYLE_PATH)
    return { body: VIDEO_PLAYER_STYLE, contentType: 'text/css; charset=utf-8' }
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

const ICONS = {
  play: '<path d="m9 5 11 7-11 7z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  back: '<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/><text x="12" y="16" text-anchor="middle" font-size="8" fill="currentColor" stroke="none">10</text>',
  volume:
    '<path d="m11 4-6 5H2v6h3l6 5zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  muted: '<path d="m11 4-6 5H2v6h3l6 5zM16 9l6 6m0-6-6 6"/>',
  settings:
    '<path d="M4 6h8m4 0h4M4 12h3m4 0h9M4 18h10m4 0h2"/><circle cx="14" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  exit: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
} as const

function icon(name: keyof typeof ICONS): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
}

// Each icon pair is rendered once and switched with `hidden`, so the script
// never writes markup.
function iconPair(
  first: keyof typeof ICONS,
  second: keyof typeof ICONS,
): string {
  return `<span data-icon="${first}">${icon(first)}</span><span data-icon="${second}" hidden>${icon(second)}</span>`
}

export const VIDEO_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const

// The generated page. Labels start in English and the player script localizes
// them; the document never contains artifact content other than its escaped
// file name. The native controls stay on until the script takes over, so the
// video still plays if the script cannot run. The video never autoplays.
export function videoPlayerDocument(entrypointPath: string | null): string {
  const fileName = escapeHtml(videoDownloadFileName(entrypointPath))
  const download = `${VIDEO_ORIGINAL_PATH}?download=1`
  const rates = VIDEO_PLAYBACK_RATES.map(
    (rate) =>
      `<option value="${rate}"${rate === 1 ? ' selected' : ''} data-rate="${rate}">${rate}×</option>`,
  ).join('')
  return `<!doctype html>
<html lang="en" data-video-state="loading">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fileName}</title>
<link rel="stylesheet" href="${VIDEO_PLAYER_STYLE_PATH}">
</head>
<body>
<main id="player" class="player" data-label="player" aria-label="Video player">
<div class="video-picture">
<video id="video" controls playsinline preload="metadata" src="${VIDEO_ORIGINAL_PATH}"></video>
<button id="start-play" class="start-play" type="button" data-label="startPlay" aria-label="Play video" hidden>${icon('play')}</button>
<div id="status" class="status" role="status" aria-live="polite"><p id="status-message" data-text="loading">Loading video…</p><a id="status-download" class="status-download" href="${download}" download="${fileName}" data-text="downloadOriginal">Download the original video</a></div>
</div>
<div id="controls" class="video-controls" hidden>
<label class="seek"><span class="sr-only" data-text="seek">Seek</span><input id="seek" type="range" min="0" max="100" step="0.1" value="0" aria-valuetext="0:00" disabled></label>
<div class="control-row">
<div class="controls-start">
<button id="play" type="button" data-label="play" aria-label="Play">${iconPair('play', 'pause')}</button>
<button id="back" type="button" data-label="back" aria-label="Back 10 seconds">${icon('back')}</button>
<span class="time"><output id="elapsed">0:00</output><span class="time-divider" aria-hidden="true">/</span><span id="duration">–:––</span></span>
</div>
<div class="controls-end">
<div class="volume-control">
<button id="mute" type="button" data-label="mute" aria-label="Mute" aria-pressed="false">${iconPair('volume', 'muted')}</button>
<input id="volume" class="volume-slider" type="range" min="0" max="1" step="0.05" value="1" data-label="volume" aria-label="Volume">
</div>
<button id="settings" type="button" data-label="settings" aria-label="Playback settings" aria-expanded="false" aria-controls="playback-options">${icon('settings')}</button>
<button id="fullscreen" type="button" data-label="fullscreen" aria-label="Full screen">${iconPair('fullscreen', 'exit')}</button>
<a id="download" class="download" href="${download}" download="${fileName}" data-label="download" aria-label="Download video">${icon('download')}<span class="desktop-label" data-text="downloadShort">Download</span></a>
</div>
</div>
</div>
<div id="playback-options" class="playback-options" role="region" data-label="settingsRegion" aria-label="Playback settings" hidden>
<label><span data-text="speedShort">Speed</span><select id="speed" data-label="speed" aria-label="Playback speed">${rates}</select></label>
</div>
</main>
<script type="module" src="${VIDEO_PLAYER_SCRIPT_PATH}"></script>
</body>
</html>`
}

// The accepted player prototype's palette and spacing. The iframe cannot load
// the app stylesheet, so the player repeats the few values it uses, and it
// uses system fonts so it never fetches anything from another origin.
const VIDEO_PLAYER_STYLE = `:root {
  color-scheme: light;
  --bg: #f0efec;
  --paper: #faf9f7;
  --text: #35352f;
  --muted: #777770;
  --line: #e5e4e0;
  --link: #1865a4;
  --picture: #151612;
  font-family: system-ui, -apple-system, 'Segoe UI', 'Hiragino Sans',
    'Hiragino Kaku Gothic ProN', 'Noto Sans JP', Meiryo, sans-serif;
  font-synthesis: none;
  background: var(--bg);
  color: var(--text);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #171815;
    --paper: #222320;
    --text: #e7e8df;
    --muted: #a7a89f;
    --line: #3c3e38;
    --link: #87b9e7;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; overflow: hidden; }
button, input, select, a { font: inherit; }
button, a { touch-action: manipulation; }
button, .download {
  color: inherit;
  cursor: pointer;
  border: 0;
  background: transparent;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 44px;
  height: 44px;
  padding: 0 10px;
  font-size: 13px;
  text-decoration: none;
}
button:not(:disabled):hover, .download:hover {
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
button:disabled { opacity: 0.4; cursor: default; }
button[aria-pressed='true'], button[aria-expanded='true'] {
  color: var(--link);
  background: color-mix(in srgb, var(--link) 7%, transparent);
}
button:focus-visible, input:focus-visible, select:focus-visible,
a:focus-visible, .player:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: -2px;
}
svg { flex-shrink: 0; display: block; }
[data-icon] { display: contents; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
.player {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.video-picture {
  position: relative;
  flex: 1;
  min-height: 100px;
  background: var(--picture);
  overflow: hidden;
}
video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.start-play {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: #151612b8;
  color: white;
}
.start-play svg { width: 28px; height: 28px; margin-left: 3px; }
.start-play:not(:disabled):hover { background: #151612e8; }
.status {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  width: max-content;
  max-width: calc(100% - 32px);
  padding: 8px 14px;
  border-radius: 5px;
  background: #151612e6;
  color: white;
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
  z-index: 3;
}
.status p { margin: 0; }
.status-download {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: #87b9e7;
}
.video-controls {
  flex-shrink: 0;
  padding: 4px 12px 8px;
  background: var(--paper);
}
.seek {
  display: flex;
  align-items: center;
  height: 24px;
  width: 100%;
}
input[type='range'] { accent-color: var(--link); cursor: pointer; }
input[type='range']:disabled { cursor: default; }
#seek { margin: 0; width: 100%; height: 20px; }
.control-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  /* The app's version chip overlaps the frame's bottom-right corner
     (51x28px, 12px from the right edge), so the buttons stay clear of it. */
  padding-right: 60px;
}
.controls-start, .controls-end, .volume-control {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.time {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.time-divider, #duration { color: var(--muted); }
.volume-slider { width: 64px; margin: 0 8px 0 0; height: 20px; }
.playback-options {
  position: absolute;
  right: 12px;
  bottom: 88px;
  width: 224px;
  padding: 16px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 8px 24px #00000018;
  z-index: 4;
  font-size: 13px;
}
.playback-options label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  color: var(--muted);
}
select {
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--paper);
  color: var(--text);
  font-size: 13px;
  padding: 6px;
}
.player:fullscreen { background: #111; }
.player:fullscreen .video-picture { min-height: 0; }
[hidden] { display: none !important; }
@media (max-width: 700px) {
  .video-controls { padding: 4px 4px 6px; }
  .control-row, .controls-start, .controls-end { gap: 0; }
  .time { font-size: 11px; gap: 3px; padding: 0 4px; }
  /* Phones use the device volume. */
  .volume-control { display: none; }
  .controls-start #back { display: none; }
  .desktop-label { display: none; }
  .download { padding: 0; }
  .start-play { width: 52px; height: 52px; }
  .start-play svg { width: 24px; height: 24px; }
  .playback-options { right: 4px; bottom: 84px; }
  select { min-height: 44px; }
}
/* Phones in any orientation (touch without hover) use the device volume. */
@media (hover: none) and (pointer: coarse) {
  .volume-control { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  * { scroll-behavior: auto !important; transition: none !important; }
}
`

// Plain browser JavaScript (no build step). The video element streams the
// original with Range requests; separately, the whole original is fetched
// once while the sandbox cookie is valid, so download keeps working after
// the cookie expires during long viewing.
const VIDEO_PLAYER_SCRIPT = `const ORIGINAL = '${VIDEO_ORIGINAL_PATH}'
const ja = /^ja\\b/i.test(navigator.language || '')
const text = ja
  ? {
      player: '動画プレーヤー',
      startPlay: '動画を再生',
      replay: 'もう一度再生',
      play: '再生',
      pause: '一時停止',
      back: '10秒戻る',
      seek: '再生位置',
      mute: 'ミュート',
      unmute: 'ミュートを解除',
      volume: '音量',
      settings: '再生設定',
      settingsRegion: '再生設定',
      speed: '再生速度',
      speedShort: '速度',
      fullscreen: '全画面表示',
      exitFullscreen: '全画面表示を終了',
      download: '動画をダウンロード',
      downloadShort: 'ダウンロード',
      downloadOriginal: '元の動画をダウンロード',
      normalSpeed: '標準',
      loading: '動画を読み込んでいます…',
      buffering: '読み込んでいます…',
      corrupt: 'この動画は壊れているか、動画として読み込めませんでした。元のファイルをダウンロードして確認してください。',
      unsupported: 'この動画はここでは再生できません。壊れているか、このブラウザーが対応していない形式の可能性があります。元のファイルをダウンロードして、お使いの動画アプリで開いてください。',
      transport: '動画を取得できませんでした。ページを再読み込みしてもう一度お試しください。',
      playFailed: '再生できませんでした。もう一度再生するか、動画をダウンロードしてください。',
      fullscreenFailed: 'この環境では全画面表示を利用できません。',
      downloadAtRisk: '動画をダウンロード用に保持できませんでした。このページを開いているうちに今すぐダウンロードするか、再読み込みしてもう一度お試しください。',
    }
  : {
      player: 'Video player',
      startPlay: 'Play video',
      replay: 'Play again',
      play: 'Play',
      pause: 'Pause',
      back: 'Back 10 seconds',
      seek: 'Seek',
      mute: 'Mute',
      unmute: 'Unmute',
      volume: 'Volume',
      settings: 'Playback settings',
      settingsRegion: 'Playback settings',
      speed: 'Playback speed',
      speedShort: 'Speed',
      fullscreen: 'Full screen',
      exitFullscreen: 'Exit full screen',
      download: 'Download video',
      downloadShort: 'Download',
      downloadOriginal: 'Download the original video',
      normalSpeed: 'Normal',
      loading: 'Loading video…',
      buffering: 'Loading…',
      corrupt: 'This video is damaged or could not be read as a video. Download the original file to check it.',
      unsupported: 'This video can’t be played here. It may be damaged or in a format this browser doesn’t support. Download the original file and open it in your video app.',
      transport: 'The video could not be loaded. Reload the page to try again.',
      playFailed: 'The video could not start. Try again, or download the video.',
      fullscreenFailed: 'Full screen isn’t available here.',
      downloadAtRisk: 'The video couldn’t be kept for download. Download it now while this page is open, or reload the page to try again.',
    }
document.documentElement.lang = ja ? 'ja' : 'en'
for (const element of document.querySelectorAll('[data-label]'))
  element.setAttribute('aria-label', text[element.dataset.label])
for (const element of document.querySelectorAll('[data-text]'))
  element.textContent = text[element.dataset.text]
for (const option of document.querySelectorAll('[data-rate]'))
  if (option.dataset.rate === '1') option.textContent = text.normalSpeed

const byId = (id) => document.getElementById(id)
const root = document.documentElement
const player = byId('player')
const video = byId('video')
const play = byId('play')
const start = byId('start-play')
const back = byId('back')
const seek = byId('seek')
const volume = byId('volume')
const mute = byId('mute')
const settings = byId('settings')
const options = byId('playback-options')
const speed = byId('speed')
const fullscreen = byId('fullscreen')
const download = byId('download')
const status = byId('status')
const statusMessage = byId('status-message')
const statusDownload = byId('status-download')

// States: loading → ready, or one of the terminal failures corrupt,
// unsupported and transport. Every state message offers the download.
const FAILURES = new Set(['corrupt', 'unsupported', 'transport'])
let seekDragging = false
function showState(state, message) {
  root.dataset.videoState = state
  status.hidden = false
  statusMessage.textContent = message
  statusDownload.hidden = false
  if (FAILURES.has(state)) {
    start.hidden = true
    play.disabled = true
    back.disabled = true
    seek.disabled = true
  }
}
function showNotice(message) {
  status.hidden = false
  statusMessage.textContent = message
  statusDownload.hidden = false
}
// True while the full original could not be kept for download.
let downloadAtRisk = false
function hideStatus() {
  if (FAILURES.has(root.dataset.videoState)) return
  if (downloadAtRisk) return showNotice(text.downloadAtRisk)
  status.hidden = true
}
const failed = () => FAILURES.has(root.dataset.videoState)

function time(value) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = String(safe % 60).padStart(2, '0')
  return hours
    ? hours + ':' + String(minutes).padStart(2, '0') + ':' + seconds
    : minutes + ':' + seconds
}
const knownDuration = () =>
  Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
function seekTo(seconds) {
  const duration = knownDuration()
  if (!duration) return
  video.currentTime = Math.min(Math.max(0, seconds), duration)
  syncTime()
}

function syncTime() {
  const duration = knownDuration()
  byId('elapsed').textContent = time(video.currentTime)
  byId('duration').textContent = duration ? time(duration) : '–:––'
  seek.disabled = !duration || failed()
  // While the reader drags the bar, playback updates do not move it back.
  if (!seekDragging)
    seek.value = duration
      ? String(Math.min(100, (video.currentTime / duration) * 100))
      : '0'
  seek.setAttribute(
    'aria-valuetext',
    time(video.currentTime) + ' / ' + (duration ? time(duration) : '–:––'),
  )
}
function setIcon(button, name) {
  for (const span of button.querySelectorAll('[data-icon]'))
    span.hidden = span.dataset.icon !== name
}
function syncPlay() {
  const paused = video.paused || video.ended
  setIcon(play, paused ? 'play' : 'pause')
  play.setAttribute(
    'aria-label',
    video.ended ? text.replay : paused ? text.play : text.pause,
  )
  start.hidden = !paused || failed()
  start.setAttribute('aria-label', video.ended ? text.replay : text.startPlay)
}
function syncVolume() {
  const silent = video.muted || video.volume === 0
  setIcon(mute, silent ? 'muted' : 'volume')
  mute.setAttribute('aria-pressed', String(silent))
  mute.setAttribute('aria-label', silent ? text.unmute : text.mute)
  volume.value = String(video.muted ? 0 : video.volume)
}

async function togglePlay() {
  if (failed()) return
  if (!video.paused && !video.ended) {
    video.pause()
    return
  }
  try {
    await video.play()
    hideStatus()
  } catch (error) {
    // A media error reports its own state; anything else is a refused start.
    if (!video.error && !failed()) showNotice(text.playFailed)
  }
}

// Media errors: a decode error is a damaged file; a network error, or a
// "not supported" error whose source request itself fails, is a transport
// failure; otherwise the browser cannot play this file.
let classifying = false
async function showMediaError() {
  if (classifying || failed()) return
  const code = video.error ? video.error.code : 0
  if (code === 3) return showState('corrupt', text.corrupt)
  if (code === 2) return showState('transport', text.transport)
  classifying = true
  let reachable = false
  try {
    const probe = await fetch(ORIGINAL, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Range: 'bytes=0-0' },
    })
    reachable = probe.ok
    await probe.body?.cancel()
  } catch {}
  classifying = false
  if (reachable) showState('unsupported', text.unsupported)
  else showState('transport', text.transport)
}

play.addEventListener('click', () => void togglePlay())
start.addEventListener('click', () => void togglePlay())
video.addEventListener('click', () => void togglePlay())
for (const name of ['play', 'pause', 'ended']) video.addEventListener(name, syncPlay)
for (const name of ['timeupdate', 'durationchange', 'loadedmetadata', 'seeked', 'emptied'])
  video.addEventListener(name, syncTime)
video.addEventListener('loadedmetadata', () => {
  if (root.dataset.videoState === 'loading') root.dataset.videoState = 'ready'
  hideStatus()
})
video.addEventListener('waiting', () => {
  if (!video.paused && !failed()) showNotice(text.buffering)
})
for (const name of ['playing', 'canplay', 'seeked']) video.addEventListener(name, hideStatus)
video.addEventListener('error', () => void showMediaError())

seek.addEventListener('pointerdown', () => { seekDragging = true })
for (const name of ['pointerup', 'pointercancel', 'change'])
  seek.addEventListener(name, () => { seekDragging = false })
seek.addEventListener('input', () => {
  const duration = knownDuration()
  if (duration) seekTo((Number(seek.value) / 100) * duration)
})
back.addEventListener('click', () => seekTo(video.currentTime - 10))

mute.addEventListener('click', () => {
  if (video.muted && video.volume === 0) video.volume = 1
  video.muted = !video.muted
})
volume.addEventListener('input', () => {
  video.volume = Number(volume.value)
  video.muted = video.volume === 0
})
video.addEventListener('volumechange', syncVolume)

function closeOptions(focusSettings) {
  if (options.hidden) return
  options.hidden = true
  settings.setAttribute('aria-expanded', 'false')
  if (focusSettings) settings.focus()
}
settings.addEventListener('click', () => {
  options.hidden = !options.hidden
  settings.setAttribute('aria-expanded', String(!options.hidden))
  if (!options.hidden) speed.focus()
})
speed.addEventListener('change', () => {
  video.playbackRate = Number(speed.value)
})
video.addEventListener('ratechange', () => {
  speed.value = String(video.playbackRate)
})
document.addEventListener('click', (event) => {
  if (!options.contains(event.target) && !settings.contains(event.target))
    closeOptions(false)
})
options.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.stopPropagation()
    closeOptions(true)
  }
})

const fullscreenElement = () =>
  document.fullscreenElement || document.webkitFullscreenElement || null
fullscreen.addEventListener('click', async () => {
  try {
    if (fullscreenElement()) {
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document)
    } else if (player.requestFullscreen) {
      await player.requestFullscreen()
    } else if (player.webkitRequestFullscreen) {
      player.webkitRequestFullscreen()
    } else if (video.webkitEnterFullscreen) {
      // iPhone Safari only lets the video element itself go full screen.
      video.webkitEnterFullscreen()
    } else {
      throw new Error('fullscreen unavailable')
    }
  } catch {
    showNotice(text.fullscreenFailed)
  }
})
function syncFullscreen() {
  const active = Boolean(fullscreenElement())
  setIcon(fullscreen, active ? 'exit' : 'fullscreen')
  fullscreen.setAttribute('aria-label', active ? text.exitFullscreen : text.fullscreen)
}
document.addEventListener('fullscreenchange', syncFullscreen)
document.addEventListener('webkitfullscreenchange', syncFullscreen)

// Shortcuts only while focus is in the player and not on a control that has
// its own keys (buttons, links, the seek and volume ranges, the speed list).
player.addEventListener('keydown', (event) => {
  const target = event.target
  if (
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.defaultPrevented ||
    (target instanceof HTMLElement &&
      (target.isContentEditable ||
        /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(target.tagName)))
  )
    return
  const key = event.key
  if (key === ' ' || key === 'k' || key === 'K') void togglePlay()
  else if (key === 'ArrowLeft') seekTo(video.currentTime - 5)
  else if (key === 'ArrowRight') seekTo(video.currentTime + 5)
  else return
  event.preventDefault()
})

// Download: the whole original is fetched once with the page's credentials
// while they are valid, independently of playback, and kept in memory. Until
// it is complete, or if it fails, the link itself downloads the attachment
// (never navigating the player away).
let original = null
let acquiring = null
function acquire() {
  // no-store: never wait behind the video element's own cached request.
  acquiring ??= fetch(ORIGINAL, { credentials: 'same-origin', cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error('original ' + response.status)
      const blob = await response.blob()
      original = blob.type === 'video/mp4' ? blob : new Blob([blob], { type: 'video/mp4' })
      download.dataset.ready = 'true'
      if (downloadAtRisk) {
        downloadAtRisk = false
        hideStatus()
      }
    })
    .catch(() => {
      acquiring = null
      // Say so: the link below still downloads now, but only while this
      // page's sign-in lasts.
      download.dataset.ready = 'failed'
      downloadAtRisk = true
      if (root.dataset.videoState !== 'loading') hideStatus()
    })
  return acquiring
}
function saveOriginal(event) {
  // Not kept yet: the link downloads the attachment, and the copy is fetched
  // again for later.
  if (!original) return void acquire()
  event.preventDefault()
  const url = URL.createObjectURL(original)
  const link = document.createElement('a')
  link.href = url
  link.download = download.getAttribute('download') || 'video.mp4'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}
download.addEventListener('click', saveOriginal)
statusDownload.addEventListener('click', saveOriginal)
// A page kept for back/forward navigation keeps its copy; only a real unload
// releases it.
addEventListener('pagehide', (event) => {
  if (event.persisted) return
  original = null
  delete download.dataset.ready
})

player.tabIndex = 0
video.controls = false
byId('controls').hidden = false
syncPlay()
syncTime()
syncVolume()
syncFullscreen()
if (video.error) void showMediaError()
else if (video.readyState >= 1) {
  root.dataset.videoState = 'ready'
  hideStatus()
}
void acquire()
`
