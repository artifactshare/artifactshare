import { VIDEO_ORIGINAL_PATH } from './paths'

// The player's media state: loading → ready, or one of the terminal failures
// corrupt, unsupported and transport.
export type VideoState =
  | 'loading'
  | 'ready'
  | 'corrupt'
  | 'unsupported'
  | 'transport'

// What the status over the picture says, if anything. Every notice offers the
// original download.
export type VideoNotice =
  | 'loading'
  | 'buffering'
  | 'playFailed'
  | 'fullscreenFailed'
  | 'downloadAtRisk'
  | 'corrupt'
  | 'unsupported'
  | 'transport'

// Whether the whole original is kept in memory for download: not yet, kept,
// or it could not be kept (the link then downloads the attachment).
export type DownloadCopy = 'pending' | 'ready' | 'failed'

export interface VideoSnapshot {
  state: VideoState
  notice: VideoNotice | null
  paused: boolean
  ended: boolean
  // The reader has played or moved the video.
  moved: boolean
  currentTime: number
  // 0 while unknown.
  duration: number
  silent: boolean
  volume: number
  rate: number
  fullscreen: boolean
  download: DownloadCopy
}

const FAILURES: ReadonlySet<VideoState> = new Set([
  'corrupt',
  'unsupported',
  'transport',
])

export function isFailure(state: VideoState): boolean {
  return FAILURES.has(state)
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => void
}
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => void }
// iPhone Safari can put only a video element in full screen, with its own
// controls.
type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void }

// Runs one player document: it owns the page's <video> element (the one the
// generated page shipped with native controls, so the video still plays if
// this script cannot run), its media and error handling, full screen and the
// in-memory copy of the original, and publishes the state the React controls
// render. The document's root keeps data-video-state.
//
// The video element streams the original with Range requests; separately,
// the whole original is fetched once while the sandbox cookie is valid, so
// download keeps working after the cookie expires during long viewing.
export class VideoPlayerRuntime {
  readonly video: HTMLVideoElement
  #snapshot: VideoSnapshot
  readonly #listeners = new Set<() => void>()
  #cleanups: Array<() => void> = []
  #playRequested = false
  #classifying = false
  #original: Blob | null = null
  #acquiring: Promise<void> | null = null
  // The in-memory copy's object URL once playback continues from it.
  readonly #objectUrls = new Map<'playback', string>()

  constructor(video: HTMLVideoElement) {
    this.video = video
    this.#snapshot = {
      state: 'loading',
      notice: 'loading',
      paused: true,
      ended: false,
      moved: false,
      currentTime: 0,
      duration: 0,
      silent: false,
      volume: 1,
      rate: 1,
      fullscreen: false,
      download: 'pending',
    }
    this.#snapshot = { ...this.#snapshot, ...this.#media() }
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  #update(patch: Partial<VideoSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch }
    document.documentElement.dataset.videoState = this.#snapshot.state
    for (const listener of this.#listeners) listener()
  }

  #media(): Partial<VideoSnapshot> {
    const video = this.video
    return {
      paused: video.paused,
      ended: video.ended,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: this.#knownDuration(),
      rate: video.playbackRate,
    }
  }

  #sync = () => this.#update(this.#media())

  // Volume follows the element's volumechange only: an engine without an
  // audio device may never apply a new volume, and the slider then keeps the
  // one the reader chose.
  #syncVolume = () => {
    const video = this.video
    this.#update({
      silent: video.muted || video.volume === 0,
      volume: video.muted ? 0 : video.volume,
    })
  }

  #knownDuration() {
    const { duration } = this.video
    return Number.isFinite(duration) && duration > 0 ? duration : 0
  }

  #failed() {
    return isFailure(this.#snapshot.state)
  }

  #showState(state: 'corrupt' | 'unsupported' | 'transport') {
    this.#update({ state, notice: state })
  }

  #showNotice(notice: VideoNotice) {
    this.#update({ notice })
  }

  #hideStatus() {
    if (this.#failed()) return
    if (this.#snapshot.download === 'failed')
      return this.#showNotice('downloadAtRisk')
    this.#update({ notice: null })
  }

  #listen(target: EventTarget, type: string, listener: (event: Event) => void) {
    target.addEventListener(type, listener)
    this.#cleanups.push(() => target.removeEventListener(type, listener))
  }

  start() {
    const video = this.video
    this.#listen(video, 'play', () => {
      this.#playRequested = true
      this.#update({ moved: true })
    })
    this.#listen(video, 'pause', () => {
      this.#playRequested = false
    })
    this.#listen(video, 'seeked', () => {
      if (video.currentTime > 0) this.#update({ moved: true })
    })
    for (const name of [
      'play',
      'pause',
      'ended',
      'seeked',
      'timeupdate',
      'durationchange',
      'loadedmetadata',
      'emptied',
      'ratechange',
    ])
      this.#listen(video, name, this.#sync)
    this.#listen(video, 'volumechange', this.#syncVolume)
    this.#listen(video, 'loadedmetadata', () => {
      if (this.#snapshot.state === 'loading') this.#update({ state: 'ready' })
      this.#hideStatus()
    })
    this.#listen(video, 'waiting', () => {
      if (!video.paused && !this.#failed()) this.#showNotice('buffering')
    })
    for (const name of ['playing', 'canplay', 'seeked'])
      this.#listen(video, name, () => this.#hideStatus())
    this.#listen(video, 'error', () => void this.#showMediaError())
    this.#listen(video, 'click', () => void this.togglePlay())
    const syncFullscreen = () =>
      this.#update({ fullscreen: Boolean(fullscreenElement()) })
    this.#listen(document, 'fullscreenchange', syncFullscreen)
    this.#listen(document, 'webkitfullscreenchange', syncFullscreen)
    // A page kept for back/forward navigation keeps its copy; only a real
    // unload releases it.
    this.#listen(window, 'pagehide', (event) => {
      if ((event as PageTransitionEvent).persisted) return
      this.#original = null
      for (const url of this.#objectUrls.values()) URL.revokeObjectURL(url)
      this.#update({ download: 'pending' })
    })

    video.controls = false
    this.#sync()
    this.#syncVolume()
    syncFullscreen()
    if (video.error) void this.#showMediaError()
    else if (video.readyState >= 1) {
      this.#update({ state: 'ready' })
      this.#hideStatus()
    }
    void this.#acquire()
  }

  stop() {
    for (const cleanup of this.#cleanups.splice(0)) cleanup()
  }

  async togglePlay() {
    const video = this.video
    if (this.#failed()) return
    if (!video.paused && !video.ended) {
      video.pause()
      return
    }
    try {
      await video.play()
      this.#hideStatus()
    } catch (error) {
      // A pause right after play() interrupts it with AbortError; that is
      // not a failure. A media error reports its own state; anything else is
      // a refused start.
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (!video.error && !this.#failed()) this.#showNotice('playFailed')
    }
  }

  seekTo(seconds: number) {
    const duration = this.#knownDuration()
    if (!duration) return
    this.video.currentTime = Math.min(Math.max(0, seconds), duration)
    this.#sync()
  }

  seekBy(seconds: number) {
    this.seekTo(this.video.currentTime + seconds)
  }

  // A position on the seek bar, from 0 to 100.
  seekToPercent(percent: number) {
    const duration = this.#knownDuration()
    if (duration) this.seekTo((percent / 100) * duration)
  }

  toggleMute() {
    const video = this.video
    if (video.muted && video.volume === 0) video.volume = 1
    video.muted = !video.muted
  }

  setVolume(volume: number) {
    this.#update({ volume })
    this.video.volume = volume
    this.video.muted = volume === 0
  }

  setRate(rate: number) {
    this.video.playbackRate = rate
  }

  // Full screen puts the whole player, controls included, in full screen.
  // Where only the video can (iPhone Safari), the video goes full screen
  // with the system's own controls, as the player did before; where neither
  // can, the reader is told so.
  async toggleFullscreen(player: FullscreenElement) {
    const current = document as FullscreenDocument
    try {
      if (fullscreenElement()) {
        if (current.exitFullscreen) await current.exitFullscreen()
        else current.webkitExitFullscreen?.()
      } else if (player.requestFullscreen) {
        await player.requestFullscreen()
      } else if (player.webkitRequestFullscreen) {
        player.webkitRequestFullscreen()
      } else if ((this.video as FullscreenVideo).webkitEnterFullscreen) {
        ;(this.video as FullscreenVideo).webkitEnterFullscreen!()
      } else {
        throw new Error('fullscreen unavailable')
      }
    } catch {
      this.#showNotice('fullscreenFailed')
    }
  }

  // Media errors: a decode error is a damaged file; a network error, or a
  // "not supported" error whose source request itself fails, is a transport
  // failure; otherwise the browser cannot play this file.
  async #showMediaError() {
    if (this.#classifying || this.#failed()) return
    const code = this.video.error?.code ?? 0
    if (code === 3) return this.#showState('corrupt')
    if (this.#useLocalCopy(this.#playRequested)) return
    if (code === 2) return this.#showState('transport')
    this.#classifying = true
    let reachable = false
    try {
      const probe = await fetch(VIDEO_ORIGINAL_PATH, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Range: 'bytes=0-0' },
      })
      reachable = probe.ok
      await probe.body?.cancel()
    } catch {
      reachable = false
    }
    this.#classifying = false
    this.#showState(reachable ? 'unsupported' : 'transport')
  }

  // Download: the whole original is fetched once with the page's credentials
  // while they are valid, independently of playback, and kept in memory.
  // Until it is complete, or if it fails, the link itself downloads the
  // attachment (never navigating the player away).
  #acquire() {
    // no-store: never wait behind the video element's own cached request.
    this.#acquiring ??= fetch(VIDEO_ORIGINAL_PATH, {
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`original ${response.status}`)
        const blob = await response.blob()
        this.#original =
          blob.type === 'video/mp4'
            ? blob
            : new Blob([blob], { type: 'video/mp4' })
        const wasAtRisk = this.#snapshot.download === 'failed'
        this.#update({ download: 'ready' })
        if (wasAtRisk) this.#hideStatus()
      })
      .catch(() => {
        this.#acquiring = null
        // Say so: the link still downloads now, but only while this page's
        // sign-in lasts.
        this.#update({ download: 'failed' })
        if (this.#snapshot.state !== 'loading') this.#hideStatus()
      })
    return this.#acquiring
  }

  // The sandbox cookie expires after a while, so the element's later Range
  // requests can fail during long viewing. When that happens and the whole
  // original is already in memory, continue from that copy at the same
  // position, speed and play state instead of showing a failure.
  #useLocalCopy(resume: boolean) {
    if (!this.#original || this.#objectUrls.has('playback')) return false
    const video = this.video
    const at = video.currentTime
    const rate = video.playbackRate
    video.addEventListener(
      'loadedmetadata',
      () => {
        video.playbackRate = rate
        if (at > 0) video.currentTime = at
        if (resume) void video.play().catch(() => undefined)
      },
      { once: true },
    )
    // Kept for the rest of the page's life; a real unload revokes it.
    this.#objectUrls.set('playback', URL.createObjectURL(this.#original))
    video.src = this.#objectUrls.get('playback') ?? ''
    return true
  }

  // A download link's click: once the original is kept, it saves that copy;
  // until then the link downloads the attachment, and the copy is fetched
  // again for later.
  saveOriginal(event: Event, fileName: string) {
    if (!this.#original) {
      void this.#acquire()
      return
    }
    event.preventDefault()
    const url = URL.createObjectURL(this.#original)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
}

function fullscreenElement() {
  const current = document as FullscreenDocument
  return current.fullscreenElement ?? current.webkitFullscreenElement ?? null
}
