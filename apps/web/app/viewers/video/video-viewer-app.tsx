import {
  IconAdjustmentsHorizontal,
  IconDownload,
  IconMaximize,
  IconMinimize,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconRewindBackward10,
  IconVolume,
  IconVolumeOff,
} from '@tabler/icons-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { flushSync } from 'react-dom'
import { Button } from '~/components/ui/button'
import { t, type TKey } from '~/lib/i18n'
import type { PreferencesStore } from '../shared/preferences-store'
import { useViewerPreferences } from '../shared/use-viewer-preferences'
import { VIDEO_PLAYBACK_RATES } from './paths'
import {
  isFailure,
  type VideoPlayerRuntime,
  type VideoSnapshot,
} from './runtime'

type PlayerKey = Extract<TKey, `videoViewer.${string}`>
type Text = (key: PlayerKey) => string
type DownloadHandler = (event: ReactMouseEvent<HTMLAnchorElement>) => void

// Player controls: icon buttons with 44px touch targets.
const CONTROL = 'h-11 min-w-11 gap-2 px-2.5'
const ICON = 'size-5'
const PRESSED =
  'aria-pressed:bg-link-soft aria-pressed:text-link aria-expanded:bg-link-soft aria-expanded:text-link'
const RANGE = 'accent-link h-5 cursor-pointer disabled:cursor-default'

function formatTime(value: number) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = String(safe % 60).padStart(2, '0')
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}

// Keys that buttons, links, the seek and volume ranges and the speed list
// handle themselves.
function ownsKeys(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(target.tagName))
  )
}

export function VideoViewerApp({
  runtime,
  preferences,
  fileName,
  downloadHref,
}: {
  runtime: VideoPlayerRuntime
  preferences: PreferencesStore
  fileName: string
  downloadHref: string
}) {
  const { locale } = useViewerPreferences(preferences)
  const player = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot)
  const text: Text = (key) => t(locale, key)
  const playerRef = useRef<HTMLElement>(null)

  useEffect(() => {
    runtime.start()
    return () => runtime.stop()
  }, [runtime])

  // Shortcuts only while focus is in the player and not on a control that
  // has its own keys.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.defaultPrevented ||
      ownsKeys(event.target)
    )
      return
    const key = event.key
    if (key === ' ' || key === 'k' || key === 'K') void runtime.togglePlay()
    else if (key === 'ArrowLeft') runtime.seekBy(-5)
    else if (key === 'ArrowRight') runtime.seekBy(5)
    else return
    event.preventDefault()
  }

  const download: DownloadHandler = (event) =>
    runtime.saveOriginal(event.nativeEvent, fileName)
  const failed = isFailure(player.state)
  const paused = player.paused || player.ended

  return (
    <main
      ref={playerRef}
      id="player"
      tabIndex={0}
      aria-label={text('videoViewer.player')}
      onKeyDown={onKeyDown}
      className="bg-background text-foreground focus-visible:outline-ring fixed inset-0 flex flex-col focus-visible:outline-2 focus-visible:-outline-offset-2 [&:fullscreen]:bg-black"
    >
      <div className="video-picture relative min-h-25 flex-1 overflow-hidden bg-black [:fullscreen_&]:min-h-0">
        <VideoSlot video={runtime.video} />
        <Button
          id="start-play"
          variant="ghost"
          className="max-stack:size-13 absolute inset-0 m-auto size-16 rounded-full bg-black/70 text-white hover:bg-black/90 hover:text-white dark:hover:bg-black/90"
          aria-label={text(
            player.ended ? 'videoViewer.replay' : 'videoViewer.startPlay',
          )}
          // The large button invites the first play and a replay; once the
          // reader has played or moved the video, it would only cover the
          // paused frame.
          hidden={!paused || failed || (player.moved && !player.ended)}
          onClick={() => void runtime.togglePlay()}
        >
          <IconPlayerPlayFilled
            className="max-stack:size-6 ml-0.5 size-7"
            aria-hidden="true"
          />
        </Button>
        <Status
          player={player}
          text={text}
          fileName={fileName}
          downloadHref={downloadHref}
          onDownload={download}
        />
      </div>
      <Controls
        runtime={runtime}
        player={player}
        playerRef={playerRef}
        text={text}
        fileName={fileName}
        downloadHref={downloadHref}
        onDownload={download}
      />
    </main>
  )
}

// The page's own <video> element, moved into the picture once; React never
// recreates it, so playback survives every re-render. It moves during the
// first commit, which also clears the mount point, so the element is never
// left out of the document between tasks.
function VideoSlot({ video }: { video: HTMLVideoElement }) {
  const slotRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const slot = slotRef.current
    if (slot && video.parentElement !== slot) slot.appendChild(video)
  }, [video])
  return (
    <div
      ref={slotRef}
      className="size-full [&>video]:block [&>video]:size-full [&>video]:object-contain"
    />
  )
}

function statusText(text: Text, notice: VideoSnapshot['notice']) {
  return notice ? text(`videoViewer.${notice}`) : ''
}

function Status({
  player,
  text,
  fileName,
  downloadHref,
  onDownload,
}: {
  player: VideoSnapshot
  text: Text
  fileName: string
  downloadHref: string
  onDownload: DownloadHandler
}) {
  return (
    <div
      id="status"
      role="status"
      aria-live="polite"
      hidden={player.notice === null}
      className="pointer-events-none absolute inset-x-4 bottom-4 z-3 flex justify-center"
    >
      <div className="pointer-events-auto max-w-full rounded-md bg-black/90 px-3.5 py-2 text-center text-sm leading-normal text-white">
        <p id="status-message">{statusText(text, player.notice)}</p>
        <Button
          asChild
          variant="link"
          className="min-h-11 px-0 text-white hover:text-white"
        >
          <a
            id="status-download"
            href={downloadHref}
            download={fileName}
            onClick={onDownload}
          >
            {text('videoViewer.downloadOriginal')}
          </a>
        </Button>
      </div>
    </div>
  )
}

// The seek bar above one row of controls: play, back 10 seconds and the
// time on the left; volume, playback settings, full screen and download on
// the right.
function Controls({
  runtime,
  player,
  playerRef,
  text,
  fileName,
  downloadHref,
  onDownload,
}: {
  runtime: VideoPlayerRuntime
  player: VideoSnapshot
  playerRef: RefObject<HTMLElement | null>
  text: Text
  fileName: string
  downloadHref: string
  onDownload: DownloadHandler
}) {
  const failed = isFailure(player.state)
  const paused = player.paused || player.ended
  const { duration } = player
  const total = duration ? formatTime(duration) : '–:––'
  // While the reader drags the bar, playback updates do not move it back.
  const [dragging, setDragging] = useState<string | null>(null)
  const position = duration
    ? String(Math.min(100, (player.currentTime / duration) * 100))
    : '0'
  const endDrag = () => setDragging(null)
  return (
    <div
      id="controls"
      className="bg-background max-stack:px-1 max-stack:pb-1.5 shrink-0 px-3 pt-1 pb-2"
    >
      <label className="flex h-6 w-full items-center">
        <span className="sr-only">{text('videoViewer.seek')}</span>
        <input
          id="seek"
          type="range"
          min="0"
          max="100"
          step="0.1"
          className={`m-0 w-full ${RANGE}`}
          value={dragging ?? position}
          aria-valuetext={`${formatTime(player.currentTime)} / ${total}`}
          disabled={!duration || failed}
          onPointerDown={() => setDragging(position)}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          // A drag can also end without a pointerup reaching the input.
          onLostPointerCapture={endDrag}
          onBlur={endDrag}
          onChange={(event) => {
            const value = event.currentTarget.value
            if (dragging !== null) setDragging(value)
            runtime.seekToPercent(Number(value))
          }}
        />
      </label>
      {/* The app's version chip overlaps the frame's bottom-right corner, so
          the buttons stay clear of it. */}
      <div className="max-stack:gap-0 flex items-center justify-between gap-3 pr-15">
        <div className="max-stack:gap-0 flex min-w-0 items-center gap-1">
          <Button
            id="play"
            variant="ghost"
            className={CONTROL}
            aria-label={text(playbackActionKey(player.ended, paused))}
            disabled={failed}
            onClick={() => void runtime.togglePlay()}
          >
            {paused ? (
              <IconPlayerPlayFilled className={ICON} aria-hidden="true" />
            ) : (
              <IconPlayerPauseFilled className={ICON} aria-hidden="true" />
            )}
          </Button>
          <Button
            id="back"
            variant="ghost"
            className={`${CONTROL} max-stack:hidden`}
            aria-label={text('videoViewer.back')}
            disabled={failed}
            onClick={() => runtime.seekBy(-10)}
          >
            <IconRewindBackward10 className={ICON} aria-hidden="true" />
          </Button>
          <span className="max-stack:gap-0.5 max-stack:px-1 flex items-center gap-1.5 px-2 text-xs whitespace-nowrap tabular-nums">
            <output id="elapsed">{formatTime(player.currentTime)}</output>
            <span className="text-muted-foreground" aria-hidden="true">
              /
            </span>
            <span id="duration" className="text-muted-foreground">
              {total}
            </span>
          </span>
        </div>
        <div className="max-stack:gap-0 flex min-w-0 items-center gap-1">
          {/* Phones, and touch devices without hover in any orientation, use
              the device volume. */}
          <div className="max-stack:hidden touch:hidden flex min-w-0 items-center gap-1">
            <Button
              id="mute"
              variant="ghost"
              className={`${CONTROL} ${PRESSED}`}
              aria-label={text(
                player.silent ? 'videoViewer.unmute' : 'videoViewer.mute',
              )}
              aria-pressed={player.silent}
              onClick={() => runtime.toggleMute()}
            >
              {player.silent ? (
                <IconVolumeOff className={ICON} aria-hidden="true" />
              ) : (
                <IconVolume className={ICON} aria-hidden="true" />
              )}
            </Button>
            <input
              id="volume"
              type="range"
              min="0"
              max="1"
              step="0.05"
              className={`mr-2 w-16 ${RANGE}`}
              aria-label={text('videoViewer.volume')}
              value={String(player.volume)}
              onChange={(event) =>
                runtime.setVolume(Number(event.currentTarget.value))
              }
            />
          </div>
          <PlaybackSettings runtime={runtime} rate={player.rate} text={text} />
          <Button
            id="fullscreen"
            variant="ghost"
            className={CONTROL}
            aria-label={text(
              player.fullscreen
                ? 'videoViewer.exitFullscreen'
                : 'videoViewer.fullscreen',
            )}
            onClick={() => {
              if (playerRef.current)
                void runtime.toggleFullscreen(playerRef.current)
            }}
          >
            {player.fullscreen ? (
              <IconMinimize className={ICON} aria-hidden="true" />
            ) : (
              <IconMaximize className={ICON} aria-hidden="true" />
            )}
          </Button>
          <Button asChild variant="ghost" className={CONTROL}>
            <a
              id="download"
              href={downloadHref}
              download={fileName}
              aria-label={text('videoViewer.download')}
              data-ready={
                player.download === 'ready'
                  ? 'true'
                  : player.download === 'failed'
                    ? 'failed'
                    : undefined
              }
              onClick={onDownload}
            >
              <IconDownload className={ICON} aria-hidden="true" />
              <span className="max-stack:hidden">
                {text('videoViewer.downloadShort')}
              </span>
            </a>
          </Button>
        </div>
      </div>
    </div>
  )
}

// The settings button opens a small panel above the controls with the
// playback speed. Escape in the panel closes it and returns to the button;
// a click elsewhere closes it.
function PlaybackSettings({
  runtime,
  rate,
  text,
}: {
  runtime: VideoPlayerRuntime
  rate: number
  text: Text
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const speedRef = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      const target = event.target
      if (
        target instanceof Node &&
        (panelRef.current?.contains(target) ||
          buttonRef.current?.contains(target))
      )
        return
      setOpen(false)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [open])

  return (
    <>
      <Button
        ref={buttonRef}
        id="settings"
        variant="ghost"
        className={`${CONTROL} ${PRESSED}`}
        aria-label={text('videoViewer.settings')}
        aria-expanded={open}
        aria-controls="playback-options"
        onClick={() => {
          flushSync(() => setOpen(!open))
          if (!open) speedRef.current?.focus()
        }}
      >
        <IconAdjustmentsHorizontal className={ICON} aria-hidden="true" />
      </Button>
      <div
        ref={panelRef}
        id="playback-options"
        role="region"
        aria-label={text('videoViewer.settings')}
        hidden={!open}
        className="bg-popover text-popover-foreground max-stack:right-1 max-stack:bottom-21 absolute right-3 bottom-22 z-4 w-56 rounded-lg border p-4 text-sm shadow-lg"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          setOpen(false)
          buttonRef.current?.focus()
        }}
      >
        <label className="text-muted-foreground flex items-center justify-between gap-4">
          <span>{text('videoViewer.speedShort')}</span>
          <select
            ref={speedRef}
            id="speed"
            aria-label={text('videoViewer.speed')}
            value={String(rate)}
            onChange={(event) =>
              runtime.setRate(Number(event.currentTarget.value))
            }
            className="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 max-stack:min-h-11 min-h-9 rounded-md border px-1.5 text-sm outline-none focus-visible:ring-3"
          >
            {VIDEO_PLAYBACK_RATES.map((option) => (
              <option key={option} value={String(option)}>
                {option === 1 ? text('videoViewer.normalSpeed') : `${option}×`}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  )
}

function playbackActionKey(ended: boolean, paused: boolean) {
  if (ended) return 'videoViewer.replay' as const
  return paused ? ('videoViewer.play' as const) : ('videoViewer.pause' as const)
}
