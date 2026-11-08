import { describe, expect, test } from 'vitest'
import { server } from 'vitest/browser'

// No engine needs to decode a movie here: the media state is set explicitly
// (see video-viewer-browser-command.ts), while delivery, download and the
// terminal states use the real sandbox Worker.
describe.each([1440, 390])('video player at %ipx', (width) => {
  test('opens paused with controls below the picture that fit the width', async () => {
    const result = await server.commands.videoViewerScenario('controls', width)

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
    }
    expect(result.offOrigin).toEqual([])
    expect(result.violations).toEqual([])
  })

  test('plays, pauses, seeks within bounds and changes speed', async () => {
    const { steps, speedOptions, settingsOpen, settingsClosed } =
      await server.commands.videoViewerScenario('controls', width)

    expect(steps!.playing).toMatchObject({
      paused: false,
      startHidden: true,
      playLabel: 'Pause',
    })
    expect(steps!.pausedByButton).toMatchObject({
      paused: true,
      playLabel: 'Play',
    })
    expect(steps!.seekEnd).toMatchObject({
      currentTime: 60,
      elapsed: '1:00',
      seekValue: 100,
      seekText: '1:00 / 1:00',
    })
    expect(steps!.seekMiddle).toMatchObject({
      currentTime: 30,
      elapsed: '0:30',
    })
    expect(settingsOpen).toBe(true)
    expect(speedOptions).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])
    expect(steps!.slowest!.playbackRate).toBe(0.5)
    expect(steps!.fastest!.playbackRate).toBe(2)
    expect(settingsClosed).toBe(true)
  })

  test('answers shortcuts only in the player and leaves native keys alone', async () => {
    const { steps } = await server.commands.videoViewerScenario(
      'controls',
      width,
    )

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
    const { steps } = await server.commands.videoViewerScenario(
      'controls',
      width,
    )

    const fullscreen = steps!.fullscreen!
    if (fullscreen.fullscreenEnabled) {
      expect(fullscreen.fullscreen).toBe('player')
      expect(fullscreen.fullscreenLabel).toBe('Exit full screen')
      expect(fullscreen.controlsBox.bottom).toBeLessThanOrEqual(
        fullscreen.viewport.height + 1,
      )
      expect(steps!.afterFullscreen).toMatchObject({
        fullscreen: null,
        fullscreenLabel: 'Full screen',
      })
    } else {
      expect(fullscreen.statusHidden).toBe(false)
    }
  })

  test('keeps the original download after the sandbox cookie expires', async () => {
    const result = await server.commands.videoViewerScenario('controls', width)

    expect(result.download).toEqual({
      name: '録画 Demo.mp4',
      sameBytes: true,
      fetchedOriginal: false,
      urlUnchanged: true,
    })
    expect(result.afterBackForward).toEqual({
      name: '録画 Demo.mp4',
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
  const { steps } = await server.commands.videoViewerScenario('controls', 1440)

  expect(steps!.volume).toMatchObject({ volume: 0.4, muted: false })
  expect(steps!.muted).toMatchObject({ muted: true, muteLabel: 'Unmute' })
  expect(steps!.unmuted).toMatchObject({ muted: false, muteLabel: 'Mute' })
})

test('omits volume on phones and keeps 44px touch targets', async () => {
  const { loaded } = await server.commands.videoViewerScenario('controls', 390)

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

test('plays and seeks a real clip where the engine decodes it', async () => {
  const result = await server.commands.videoViewerScenario('playback', 1440)
  const { decodable, playing, seeked } = result.playback!

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
  expect(seeked!.paused).toBe(true)
  expect(seeked!.currentTime).toBeCloseTo(seeked!.duration / 2, 0)
  expect(seeked!.total).toBe('0:02')
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
    name: '録画 Demo.mp4',
    sameBytes: true,
    urlUnchanged: true,
  })
})

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
