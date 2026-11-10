import { describe, expect, test } from 'vitest'
import { server } from 'vitest/browser'

// Each controls walk already returns independent snapshots and closes its browser
// context. Reuse those immutable observations within this file/engine only.
const controls = new Map<
  number,
  ReturnType<typeof server.commands.videoViewerScenario>
>()
function controlScenario(width: number) {
  let result = controls.get(width)
  if (!result) {
    result = server.commands.videoViewerScenario('controls', width)
    controls.set(width, result)
  }
  return result
}

// No engine needs to decode a movie here: the media state is set explicitly
// (see video-viewer-browser-command.ts), while delivery, download and the
// terminal states use the real sandbox Worker.

// The stored name is `録画 Demo.mp4`; WebKit on Linux saves the space as `_`.
const savedName = expect.stringMatching(/^録画[ _]Demo\.mp4$/)
describe.each([1440, 390])('video player at %ipx', (width) => {
  test('opens paused with controls below the picture that fit the width', async () => {
    const result = await controlScenario(width)

    // Loading first, with the download already offered; never autoplays.
    expect(result.initial).toMatchObject({
      state: 'loading',
      message: 'Loading video…',
      statusHidden: false,
      downloadOffered: true,
      autoplay: false,
      paused: true,
    })
    const loaded = result.loaded!
    expect(loaded).toMatchObject({
      state: 'ready',
      paused: true,
      nativeControls: false,
      startHidden: false,
      statusHidden: true,
      elapsed: '0:00',
      duration: '1:00',
    })
    expect(loaded.controlsBox.top).toBeGreaterThanOrEqual(
      loaded.picture.bottom - 1,
    )
    expect(loaded.scrollWidth).toBeLessThanOrEqual(loaded.viewport.width)
    for (const control of loaded.controls) {
      expect(control.left, control.id).toBeGreaterThanOrEqual(0)
      expect(control.right, control.id).toBeLessThanOrEqual(
        loaded.viewport.width,
      )
      expect(control.top, control.id).toBeGreaterThanOrEqual(
        loaded.picture.bottom - 1,
      )
      // The app's version chip covers the frame's bottom-right 64x46px.
      const underChip =
        control.right > loaded.viewport.width - 64 &&
        control.bottom > loaded.viewport.height - 46
      expect(underChip, control.id).toBe(false)
    }
    expect(result.offOrigin).toEqual([])
    expect(result.violations).toEqual([])
  })

  test('plays, pauses, seeks within bounds and changes speed', async () => {
    const { steps, speedOptions, settingsOpen, settingsClosed } =
      await controlScenario(width)

    expect(steps!.playing).toMatchObject({
      paused: false,
      startHidden: true,
      playLabel: 'Pause',
    })
    // Once played, a pause keeps the frame clear of the large play button.
    expect(steps!.pausedByButton).toMatchObject({
      paused: true,
      playLabel: 'Play',
      startHidden: true,
    })
    expect(steps!.seekEnd).toMatchObject({
      currentTime: 60,
      elapsed: '1:00',
      seekValue: 100,
      seekText: '1:00 / 1:00',
    })
    expect(steps!.seekMiddle).toMatchObject({
      startHidden: true,
      currentTime: 30,
      elapsed: '0:30',
    })
    expect(settingsOpen).toBe(true)
    expect(speedOptions).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])
    expect(steps!.slowest!.playbackRate).toBe(0.5)
    expect(steps!.fastest!.playbackRate).toBe(2)
    // Escape closed the settings and returned to their button.
    expect(settingsClosed).toBe(true)
    // At the end, the large button offers a replay again.
    expect(steps!.ended).toMatchObject({
      paused: true,
      startHidden: false,
      playLabel: 'Play again',
    })
  })

  test('answers shortcuts only in the player and leaves native keys alone', async () => {
    const { steps } = await controlScenario(width)

    expect(steps!.arrowRight!.currentTime).toBe(35)
    expect(steps!.arrowLeftTwice!.currentTime).toBe(25)
    expect(steps!.space!.paused).toBe(false)
    expect(steps!.k!.paused).toBe(true)
    expect(steps!.arrowLeftAtStart!.currentTime).toBe(0)
    // One native range step (0.1% of 60 s), not the 5 s shortcut.
    expect(steps!.seekArrow!.currentTime).toBeGreaterThan(0)
    expect(steps!.seekArrow!.currentTime).toBeLessThan(1)
    // Space on the play button presses it once; the shortcut does not also
    // toggle playback back.
    expect(steps!.spaceOnPlayButton!.paused).toBe(false)
  })

  test('goes full screen with its controls and comes back', async () => {
    const { steps, fullscreenSettings } = await controlScenario(width)

    const fullscreen = steps!.fullscreen!
    if (fullscreen.fullscreenEnabled) {
      expect(fullscreen.fullscreen).toBe('player')
      expect(fullscreen.fullscreenLabel).toBe('Exit full screen')
      expect(fullscreen.controlsBox.bottom).toBeLessThanOrEqual(
        fullscreen.viewport.height + 1,
      )
      // The playback settings open over the full-screen player and work.
      expect(fullscreenSettings).toEqual({
        open: true,
        insidePlayer: true,
        onScreen: true,
        playbackRate: 1.25,
        fullscreen: 'player',
      })
      expect(steps!.afterFullscreen).toMatchObject({
        fullscreen: null,
        fullscreenLabel: 'Full screen',
      })
    } else if (fullscreen.videoFullscreen) {
      // Only the video can go full screen here: it does, with the
      // system's controls, and no failure notice shows.
      expect(fullscreen.statusHidden).toBe(true)
    } else {
      expect(fullscreen.statusHidden).toBe(false)
    }
  })

  test('says when it is buffering, cannot start or cannot go full screen', async () => {
    const { notices } = await controlScenario(width)

    expect(notices).toEqual({
      buffering: 'Loading…',
      afterBuffering: null,
      playRefused:
        'The video could not start. Try again, or download the video.',
      // Where neither the player nor the video can go full screen, the
      // reader is told so.
      fullscreenUnavailable: 'Full screen isn’t available here.',
      fullscreenElement: null,
    })
  })

  test('keeps the original download after the sandbox cookie expires', async () => {
    const result = await controlScenario(width)

    // A network failure after the cookie expires switches playback to the
    // in-memory copy instead of a failure state.
    expect(result.playsFromLocalCopy!.switched).toBe(true)
    expect(result.playsFromLocalCopy!.state).not.toBe('transport')
    // It continues where the reader was, at the same speed, still playing.
    expect(result.playsFromLocalCopy!.restored).toEqual({
      currentTime: 30,
      playbackRate: 1.5,
      paused: false,
    })
    expect(result.download).toEqual({
      name: savedName,
      sameBytes: true,
      fetchedOriginal: false,
      urlUnchanged: true,
    })
    expect(result.afterBackForward).toEqual({
      name: savedName,
      sameBytes: true,
    })
    // The sandbox Worker itself served the page, its files and the original.
    expect(result.workerStatuses).toEqual(
      expect.arrayContaining([
        '/__as_video/viewer.js: 200',
        '/__as_video/viewer.css: 200',
        '/__as_video/original.mp4: 200',
      ]),
    )
  })
})

test('offers volume and mute on desktop', async () => {
  const { steps, volumeCapability } = await controlScenario(1440)

  // The slider and mute button are the player's; an engine without an audio
  // device may leave the element's volume unapplied.
  expect(steps!.volume).toMatchObject({ muted: false, mutePressed: 'false' })
  expect(steps!.volume!.volumeSlider).toBeCloseTo(0.4, 2)
  expect(volumeCapability).toBe(
    steps!.volume!.volume === 1 ? 'unapplied' : 'applied',
  )
  if (volumeCapability === 'applied')
    expect(steps!.volume!.volume).toBeCloseTo(0.4, 2)
  else expect(steps!.volume!.volume).toBe(1)
  expect(steps!.muted).toMatchObject({ mutePressed: 'true' })
  expect(steps!.muted).toMatchObject({ muted: true, muteLabel: 'Unmute' })
  expect(steps!.unmuted).toMatchObject({ muted: false, muteLabel: 'Mute' })
})

test('omits volume on phones and keeps 44px touch targets', async () => {
  const { loaded } = await controlScenario(390)

  expect(loaded!.volumeVisible).toBe(false)
  for (const control of loaded!.controls.filter(({ id }) => id !== 'seek')) {
    expect(control.width, control.id).toBeGreaterThanOrEqual(44)
    expect(control.height, control.id).toBeGreaterThanOrEqual(44)
  }
})

test('omits volume on a landscape phone wider than the narrow layout', async () => {
  const { loaded } = await server.commands.videoViewerScenario(
    'controls',
    844,
    'landscape-phone',
  )

  // Firefox cannot emulate a coarse, hover-less pointer; the others can.
  if (server.browser !== 'firefox') expect(loaded!.touchDevice).toBe(true)
  expect(loaded!.volumeVisible).toBe(!loaded!.touchDevice)
  for (const control of loaded!.controls.filter(({ id }) => id !== 'seek')) {
    expect(control.width, control.id).toBeGreaterThanOrEqual(44)
    expect(control.height, control.id).toBeGreaterThanOrEqual(44)
  }
})

test('plays and seeks a real clip where the engine decodes it', async (context) => {
  const result = await server.commands.videoViewerScenario('playback', 1440)
  const { decodable, seekable, playing, seeked } = result.playback!

  // Chromium decodes the VP9 clip, so at least one engine really plays it.
  if (server.browser === 'chromium') expect(decodable).toBe(true)
  if (!decodable) {
    // No false playback claim: the engine shows a terminal state instead.
    expect(['corrupt', 'unsupported']).toContain(result.final!.state)
    expect(result.final!.downloadOffered).toBe(true)
    return
  }
  expect(result.initial.paused).toBe(true)
  expect(playing!.currentTime).toBeGreaterThan(0.3)
  if (server.browser === 'chromium') expect(seekable).toBe(true)
  if (!seekable)
    return context.skip(
      `${server.browser} plays the clip but did not complete a seek within 5 s`,
    )
  expect(seeked!.paused).toBe(true)
  expect(seeked!.currentTime).toBeCloseTo(seeked!.duration / 2, 0)
  // The total follows the duration the engine reports for the recorded clip,
  // which differs between engines.
  const whole = Math.floor(seeked!.duration)
  expect(seeked!.total).toBe(
    `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`,
  )
  expect(result.final!.state).toBe('ready')
  // The engine streamed the original with byte ranges.
  expect(result.workerStatuses).toContain('/__as_video/original.mp4: 206')
  expect(result.offOrigin).toEqual([])
  expect(result.violations).toEqual([])
})

test('says when the original could not be kept and still downloads it from the link', async () => {
  const result = await server.commands.videoViewerScenario(
    'acquire-failure',
    1440,
  )

  expect(result.final).toMatchObject({
    state: 'ready',
    statusHidden: false,
    downloadOffered: true,
    downloadHref: '/__as_video/original.mp4?download=1',
  })
  expect(result.final!.message).toMatch(/couldn’t be kept for download/)
  expect(result.fallbackDownload).toEqual({
    name: savedName,
    sameBytes: true,
    urlUnchanged: true,
  })
})

// The player speaks the app's language, set by the reader in the app, not the
// browser's, and follows the app's theme.
describe.each([
  {
    browser: 'ja-JP',
    own: {
      lang: 'ja',
      player: '動画プレーヤー',
      loading: '動画を読み込んでいます…',
      pause: '一時停止',
      fullscreenFailed: 'この環境では全画面表示を利用できません。',
    },
    app: {
      lang: 'en',
      player: 'Video player',
      loading: 'Loading video…',
      fullscreenFailed: 'Full screen isn’t available here.',
    },
  },
  {
    browser: 'en-US',
    own: {
      lang: 'en',
      player: 'Video player',
      loading: 'Loading video…',
      pause: 'Pause',
      fullscreenFailed: 'Full screen isn’t available here.',
    },
    app: {
      lang: 'ja',
      player: '動画プレーヤー',
      loading: '動画を読み込んでいます…',
      fullscreenFailed: 'この環境では全画面表示を利用できません。',
    },
  },
] as const)(
  'video player in the app language with a $browser browser',
  ({ browser, own, app }) => {
    test('follows late and changed app preferences without interrupting playback', async () => {
      const result = await server.commands.videoViewerScenario(
        'preferences',
        1440,
        'default',
        browser,
      )
      const flow = result.preferences!
      const light = 'rgb(255, 255, 255)'
      const dark = 'rgb(17, 19, 21)'
      const playing = {
        paused: false,
        currentTime: 30,
        playbackRate: 1.5,
        sameVideo: true,
      }

      // Before the app's preferences arrive: the browser's language.
      expect(flow.initial).toMatchObject({
        lang: own.lang,
        theme: 'system',
        player: own.player,
        message: own.loading,
      })
      // Late: the app's language, including the notice already on screen.
      expect(flow.late).toMatchObject({
        lang: app.lang,
        theme: 'light',
        colorScheme: 'light',
        background: light,
        player: app.player,
        message: app.loading,
      })
      // A seek before the first play retires the large play button, which
      // stays hidden while paused.
      expect(flow.loaded).toMatchObject({ startHidden: false, paused: true })
      expect(flow.seekedFirst).toMatchObject({
        startHidden: true,
        paused: true,
        currentTime: 30,
      })
      expect(flow.videoOnlyFullscreen).toEqual({ entered: true, notice: false })
      expect(flow.refused).toMatchObject({
        lang: app.lang,
        message: app.fullscreenFailed,
      })
      // Changed while playing: new labels and notice, same playback.
      expect(flow.changed).toMatchObject({
        lang: own.lang,
        theme: 'dark',
        colorScheme: 'dark',
        background: dark,
        play: own.pause,
        message: own.fullscreenFailed,
        ...playing,
      })
      // Malformed preferences, and preferences not from the parent, change
      // nothing.
      expect(flow.ignored).toMatchObject({
        lang: own.lang,
        theme: 'dark',
        background: dark,
        play: own.pause,
        message: own.fullscreenFailed,
        ...playing,
      })
      // A replacement frame is a fresh player with the current preferences.
      expect(flow.replaced).toMatchObject({
        lang: app.lang,
        theme: 'dark',
        background: dark,
        player: app.player,
        message: app.loading,
        paused: true,
        currentTime: 0,
        sameVideo: false,
      })
      expect(result.offOrigin).toEqual([])
      expect(result.violations).toEqual([])
      // Two player documents load in turn.
    }, 30000)
  },
)

describe('video player terminal states', () => {
  test('says a file it cannot open may be damaged and offers the download', async () => {
    const result = await server.commands.videoViewerScenario('damaged', 1440)

    expect(['unsupported', 'corrupt']).toContain(result.final!.state)
    expect(result.final!.message).toMatch(/damaged/)
    expect(result.final!.downloadOffered).toBe(true)
    expect(result.final!.downloadHref).toBe(
      '/__as_video/original.mp4?download=1',
    )
    expect(result.snapshot).toMatchObject({ startHidden: true, paused: true })
    // The browser's own media requests are answered with byte ranges.
    expect(result.workerStatuses).toContain('/__as_video/original.mp4: 206')
    expect(result.offOrigin).toEqual([])
    expect(result.violations).toEqual([])
  })

  test('asks to reload when the original cannot be fetched and offers the download', async () => {
    const result = await server.commands.videoViewerScenario('transport', 1440)

    expect(result.initial.state).toBe('loading')
    expect(result.final!.state).toBe('transport')
    expect(result.final!.message).toMatch(/could not be loaded.*Reload/)
    expect(result.final!.downloadOffered).toBe(true)
  })
})
