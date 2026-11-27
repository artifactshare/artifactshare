import { parentWindow } from './typed-fakes/parent-window'
import { errors } from 'playwright'
import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { defineBrowserCommand } from '@vitest/browser-playwright'
import type { Frame, Locator, Page } from 'playwright'
import { signSandboxUrl } from '../lib/sandbox-token'
import type { Locale } from '../lib/i18n'
import {
  viewerPreferencesMessage,
  type ViewerPreferences,
} from '../viewers/shared/preferences'
import { VIDEO_ORIGINAL_PATH } from '../../workers/lib/video-viewer'
import { sandboxWorker } from './sandbox-harness'
import {
  PARENT_PATH,
  parentDocument,
  type ParentWindow,
} from './pdf-viewer-browser-command'
import {
  inState,
  viewerQueries,
  type ViewerPart,
  type ViewerQueries,
} from './viewer-queries'

const secret = 'video-viewer-browser-fixture-only-'.repeat(3)

// Every part of the player a reader acts on, by the role it is published
// under and the catalogue keys behind its name; a control that toggles
// carries one name per state. The picture, the controls row, the total time
// and the media element keep their own hooks: the player gives them no name.
const VIDEO_PARTS = {
  player: { role: 'main', names: ['videoViewer.player'] },
  picture: { css: '.video-picture' },
  // The one button over the picture, which invites the first play and then
  // a replay.
  startPlay: { role: 'button', within: 'picture', css: 'button' },
  controls: { css: '#controls' },
  // Named by its own label text rather than an aria-label, which is also
  // what tells it apart from the volume slider inside the frame.
  seek: {
    role: 'slider',
    names: ['videoViewer.seek'],
    within: 'controls',
    css: 'input[type="range"]:not([aria-label])',
  },
  play: {
    role: 'button',
    names: ['videoViewer.play', 'videoViewer.pause', 'videoViewer.replay'],
    within: 'controls',
  },
  back: { role: 'button', names: ['videoViewer.back'] },
  elapsed: { role: 'status', within: 'controls' },
  duration: { css: '#duration' },
  mute: { role: 'button', names: ['videoViewer.mute', 'videoViewer.unmute'] },
  volume: { role: 'slider', names: ['videoViewer.volume'] },
  settings: { role: 'button', names: ['videoViewer.settings'] },
  playbackOptions: { role: 'region', names: ['videoViewer.settings'] },
  speed: { role: 'combobox', names: ['videoViewer.speed'] },
  fullscreen: {
    role: 'button',
    names: ['videoViewer.fullscreen', 'videoViewer.exitFullscreen'],
  },
  enterFullscreen: { role: 'button', names: ['videoViewer.fullscreen'] },
  exitFullscreen: { role: 'button', names: ['videoViewer.exitFullscreen'] },
  download: {
    role: 'link',
    names: ['videoViewer.download'],
    within: 'controls',
  },
  status: { role: 'status', css: '[role="status"]' },
  statusMessage: { within: 'status', css: 'p' },
  statusDownload: {
    role: 'link',
    names: ['videoViewer.downloadOriginal'],
    within: 'status',
    css: 'a',
  },
  // The page's own media element, which carries no role of its own. The
  // fixtures also reach it by this id where they stand in for the engine.
  video: { css: '#video' },
} as const satisfies Record<string, ViewerPart>

type VideoQueries = ViewerQueries<typeof VIDEO_PARTS>
type VideoSelectors = ReturnType<VideoQueries['selectors']>

const videoQueries = (frame: Frame, locale: Locale) =>
  viewerQueries(VIDEO_PARTS, frame, locale)

// controls: the media element's own requests are held, so it stays loading
//   and the test sets the media state explicitly. Download still fetches the
//   real original. No engine has to decode anything.
// damaged: the real Worker serves an ftyp header followed by junk, which no
//   engine can open.
// transport: every request for the original fails.
// playback: the real Worker serves a playable clip; the test plays and seeks
//   it only where the engine actually decodes it.
// acquire-failure: like controls, but the player's own fetch of the whole
//   original fails, so only the attachment link can download.
// preferences: like controls, framed in a stand-in for the app page that
//   sends the app's language and theme late, changes them and replaces the
//   frame.
export type VideoScenario =
  | 'controls'
  | 'damaged'
  | 'transport'
  | 'playback'
  | 'acquire-failure'
  | 'preferences'

// A synthetic ISO base media header (ftyp box) and bytes that are not a movie.
const FIXTURE = new Uint8Array([
  0,
  0,
  0,
  0x18,
  ...new TextEncoder().encode('ftypisom'),
  0,
  0,
  2,
  0,
  ...new TextEncoder().encode('isommp41'),
  0,
  0,
  0,
  0x10,
  ...new TextEncoder().encode('junk'),
  ...Array.from({ length: 4096 }, (_, index) => (index * 31) % 251),
])

// A 2-second 64x48 VP9 clip in MP4 (solid colour frames), recorded once with
// Chromium's MediaRecorder from a canvas. Chromium decodes it; engines that
// cannot decode it report a terminal state instead of playing.
const PLAYABLE_CLIP = new Uint8Array(
  Buffer.from(
    [
      'AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMnZwMDltcDQxAAACt21vb3YAAAB4bXZoZAEA',
      'AAAAAAAA5xV21gAAAADnFXbWAAAD6AAAAAAAAAfoAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAA',
      'AAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'AAIAAAIPdHJhawAAAGh0a2hkAQAAAwAAAADnFXbWAAAAAOcVdtYAAAABAAAAAAAAAAAAAAfo',
      'AAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAABA',
      'AAAAMAAAAAABn21kaWEAAAAsbWRoZAEAAAAAAAAA5xV21gAAAADnFXbWAAB1MAAAAAAAAAfo',
      'VcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAT5t',
      'aW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAlZGluZgAAAB1kcmVmAAAAAAAAAAEAAAANdXJs',
      'IAAAAAEAAAAA/XN0YmwAAAAQc3RzYwAAAAAAAAAAAAAAEHN0dHMAAAAAAAAAAAAAABRzdHN6',
      'AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAALFzdHNkAAAAAAAAAAEAAAChdnAwOQAA',
      'AAAAAAABAAAAAQAAAAAAAAAAAAAAAABAADAASAAAAEgAAAAAAAAAAQpWUEMgQ29kaW5nAAAA',
      'AAAAAAAAAAAAAAAAAAAAAAAAABj//wAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAAAA',
      'AAAAAAAAABR2cGNDAQAAAAAAgQENAQAAAAAAE2NvbHJuY2x4AAEADQABgAAAAChtdmV4AAAA',
      'IHRyZXgAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAAAAAEIbW9vZgAAABBtZmhkAAAAAAAAAAEA',
      'AADwdHJhZgAAABR0ZmhkAAIAIAAAAAEBAQAAAAAAFHRmZHQBAAAAAAAAAAAAAAAAAADAdHJ1',
      'bgEAAwUAAAAVAAABEAIAAAAAAAu+AAAAXQAACxYAAAAjAAAMXwAAACQAAAshAAAAMAAADGEA',
      'AABUAAALpwAAACsAAAupAAAAJgAAC9gAAAAmAAALnQAAACcAAAuqAAAAXAAAC8kAAAARAAAL',
      'ywAAACcAAAr2AAAAKAAAC+EAAAA1AAAL4AAAAGYAAAwZAAAAMAAACqsAAAAnAAAM0QAAACYA',
      'AAu5AAAAKAAACooAAABwAAAD5wAAACcAAARhbWRhdIJJg0JQA/AC9go4JBwYfAAAIEAAa0P/',
      '/4h1gR4V5prVBhtsKpsstGbM3SbHRh7b0iYv/+lSPe9jejL0DnbkcXAB+SArLblpjr+aYVDw',
      'Bf///vBv////+q/Do8OiAIYAQJLxET4AAAxwAABzD1v80AAAP////4XF////AghmLSmAhgBA',
      'kvDRMoAADHAAAHMPW//93CAAA/////zo9//+z6GYtKYAhgBAkpwsSyAAA3AAAHTSP//1un//',
      '+t0///1un/+ta////9qB/////2nnUpJdpAgAhgBAkpwsSgAAA3AAAHTSKNjGLtj/////l0j/',
      '///W7AVbWdwZf///+XSP//63ttj///54H///6Y66P//54H//tjx9j//zwP//bHXR///PA//9',
      'scAAhgBAkpwoSOAAA3AAAHTSP/64f/9QP/+oH+hj//////HQ///9MmDYIVTYAIYAQJLwkR6A',
      'AAxwAABzD1v/9CQAAf////7VEf////3YUhmLSmAAhgBAkvCRHAAADHAAAHMPW///IfYAAP//',
      '//+vqD///18EMxaUwACGAECS8JEaAAAMcAAAcw9b//56CAAD/////oih/////xX8hmLSmACG',
      'AECSnCBF4AADcAAAdNI8BfYP5CNj//////I1v////72iCwfyEbHGP////5Gt////fAKQn///',
      '/V9////bgYcT///V9//+uCS0v//+r7//9cDDif//6vv//1wAAIYAQJKcIEVgAANwAAB7McVA',
      'hgBAkvCBE4AADHAAAHMPW//9UwAAB/////1z6f////67AQzFpTAAhgDAkvBhBwAADHAAAHMP',
      'W///uwzAAAf/////Qm0/////kH0MxaUwAIYAQJKcHESAAANwAAB00j///+m2P///+m2P///+',
      'm2P//9Nsf////yaf/////0a3QbBCqbAAhgBAkpwcRCAAA3AAAHTSP5l/2cfzh06f/////vOn',
      '/////1CLx+cP9nGOW7/////7zp////9Qleb9v////55R////vgslW////nlH//98GUxv///8',
      '8o///vgslW////nlH//98EAAhgBAkpwcQ8AAA3AAAHTSP//xAH//+IA///xAH/+H8//////7',
      'Zjv///4PdSkl2kCAhgBAkvBxDYAADHAAAHMPW//+T/gAA/////8HGD/////nIlDMWlMAhgBA',
      'kvBhDAAADHAAAHMPW///qCyAAD/////28Vn///8mCGYtKYCGAECS8GELAAAMcAAAcw9b//90',
      'GQAAf////+xGJ/////5/6QzFpTAAhgBAkpwYQoAAA3AAAHTSP/gA//gA//gA/MB//////2fj',
      'f////+X5W+/AB//AB+YD8wH////+z8b////y/Sw+gD/////x4/////9EmX4D////jx////0S',
      'laQP///+PH////RJl+A////48f///9EgAIYAQJLwYQkAAAxwAABzD1v//517AAB/////p4r/',
      '////4VIQzFpTAAAAAExtZnJhAAAANHRmcmEBAAAAAAAAAQAAAD8AAAABAAAAAAAAAAAAAAAA',
      'AAAC2wAAAAEAAAABAAAAAQAAABBtZnJvAAAAAAAAAEw=',
    ].join(''),
    'base64',
  ),
)

// Seeds one link-shared video version in the real sandbox Worker's D1 and R2
// and returns a signer of the anonymous entry URL the app would hand to the
// player (each signed entry opens once).
async function seedVideoArtifact(
  env: { DB: D1Database; BUCKET: R2Bucket },
  bytes: Uint8Array,
): Promise<() => Promise<string>> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8)
  const ids = {
    workspace: `ws-vid-${suffix}`,
    user: `user-vid-${suffix}`,
    container: `inbox-vid-${suffix}`,
    artifact: `vid${suffix}a`.slice(0, 10),
    version: `ver-vid-${suffix}`,
  }
  const r2Key = `artifacts/${ids.artifact}/${ids.version}/original.mp4`
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at, plan, link_sharing_enabled) VALUES (?, 'Synthetic', ?, 'plus', 1)",
    ).bind(ids.workspace, now),
    env.DB.prepare(
      'INSERT INTO users (id, email, email_verified, name, created_at, updated_at, workspace_id) VALUES (?, ?, 1, ?, ?, ?, ?)',
    ).bind(
      ids.user,
      `${ids.user}@example.test`,
      'Synthetic author',
      now,
      now,
      ids.workspace,
    ),
    env.DB.prepare(
      "INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at) VALUES (?, ?, 'inbox', ?, ?, 'Home', ?, ?)",
    ).bind(ids.container, ids.workspace, ids.user, ids.user, now, now),
    env.DB.prepare(
      "INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, current_version_id, created_at, updated_at, container_id) VALUES (?, ?, ?, '録画 Demo.mp4', 'video', 'link', ?, ?, ?, ?)",
    ).bind(
      ids.artifact,
      ids.workspace,
      ids.user,
      ids.version,
      now,
      now,
      ids.container,
    ),
    env.DB.prepare(
      "INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at) VALUES (?, ?, 'video', 'published', '/録画 Demo.mp4', ?, ?, 'synthetic', ?, ?, ?)",
    ).bind(
      ids.version,
      ids.artifact,
      r2Key,
      bytes.byteLength,
      ids.user,
      now,
      now,
    ),
  ])
  await env.BUCKET.put(r2Key, bytes, {
    httpMetadata: { contentType: 'video/mp4' },
  })
  return () =>
    signSandboxUrl(
      {
        uid: null,
        wid: ids.workspace,
        aid: ids.artifact,
        vid: ids.version,
        fid: r2Key,
        mt: null,
        t: 'video',
        jti: `jti-${crypto.randomUUID()}`,
      },
      secret,
      { APP_ENV: 'development' },
      '/録画 Demo.mp4',
    )
}

// The media element's own requests (as opposed to the player's fetches).
function isMediaRequest(request: IncomingMessage): boolean {
  const destination = request.headers['sec-fetch-dest']
  if (destination) return destination === 'video' || destination === 'audio'
  return request.headers.range !== undefined
}

// Replaces the element's media state with a 60-second clip the test controls,
// then reports metadata the way a decodable clip would.
function simulateLoadedClip(frame: Frame, q: VideoQueries) {
  return frame.evaluate((selector) => {
    const video = document.querySelector(selector) as HTMLVideoElement
    let time = 0
    let paused = true
    const define = (name: string, descriptor: PropertyDescriptor) =>
      Object.defineProperty(video, name, { configurable: true, ...descriptor })
    define('duration', { get: () => 60 })
    define('readyState', { get: () => 1 })
    define('ended', { get: () => false })
    define('paused', { get: () => paused })
    define('currentTime', {
      get: () => time,
      set: (value: number) => {
        time = value
        video.dispatchEvent(new Event('timeupdate'))
        video.dispatchEvent(new Event('seeked'))
      },
    })
    video.play = () => {
      paused = false
      video.dispatchEvent(new Event('play'))
      return Promise.resolve()
    }
    video.pause = () => {
      paused = true
      video.dispatchEvent(new Event('pause'))
    }
    video.dispatchEvent(new Event('durationchange'))
    video.dispatchEvent(new Event('loadedmetadata'))
  }, q.selector('video'))
}

function snapshot(frame: Frame, q: VideoQueries) {
  return frame.evaluate((selectors) => {
    const find = (selector: string) =>
      document.querySelector<HTMLElement>(selector)!
    const video = find(selectors.video) as HTMLVideoElement
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect()
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      }
    }
    // What a reader hears the control called: its own label, or the text of
    // the label around it.
    const named = (element: Element) =>
      element.getAttribute('aria-label') ??
      element.closest('label')?.textContent?.trim() ??
      ''
    const controls = [
      ...find(selectors.controls).querySelectorAll('button, a, input, select'),
    ].filter(visible)
    const seek = find(selectors.seek) as HTMLInputElement
    const mute = find(selectors.mute)
    const fullscreenElement = document.fullscreenElement
    return {
      state: document.documentElement.dataset.videoState,
      paused: video.paused,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      muted: video.muted,
      volume: video.volume,
      nativeControls: video.controls,
      elapsed: find(selectors.elapsed).textContent,
      duration: find(selectors.duration).textContent,
      seekValue: Number(seek.value),
      seekText: seek.getAttribute('aria-valuetext'),
      playLabel: named(find(selectors.play)),
      startHidden: find(selectors.startPlay).hidden,
      statusHidden: find(selectors.status).hidden,
      muteLabel: named(mute),
      mutePressed: mute.getAttribute('aria-pressed'),
      volumeSlider: Number((find(selectors.volume) as HTMLInputElement).value),
      volumeVisible: visible(mute) || visible(find(selectors.volume)),
      touchDevice: matchMedia('(hover: none) and (pointer: coarse)').matches,
      picture: rect(find(selectors.picture)),
      controlsBox: rect(find(selectors.controls)),
      controls: controls.map((element) => ({
        name: named(element),
        ...rect(element),
      })),
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      fullscreenEnabled: document.fullscreenEnabled,
      fullscreen: !fullscreenElement
        ? null
        : fullscreenElement === find(selectors.player)
          ? 'player'
          : 'other',
      // Set by the stub that stands in for the video's own full screen.
      videoFullscreen:
        document.documentElement.dataset.testVideoFullscreen === 'true',
      fullscreenLabel: named(find(selectors.fullscreen)),
    }
  }, q.selectors())
}

// Sets a range the way a reader's drag does. React ignores a value set
// through the element's own property, so this uses the native setter.
function setRangeValue(frame: Frame, selector: string, value: number) {
  return frame.evaluate(
    ([target, next]) => {
      const input = document.querySelector(target) as HTMLInputElement
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, String(next))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    [selector, String(value)] as const,
  )
}

async function framedPlayer(page: Page, name: string) {
  const element = await page.waitForSelector(`iframe[name="${name}"]`)
  const frame = (await element.contentFrame())!
  await frame.waitForURL(/Demo\.mp4/, {
    timeout: 15000,
    waitUntil: 'domcontentloaded',
  })
  await frame.waitForFunction(
    (controls) =>
      document.querySelector<HTMLElement>(controls)?.hidden === false,
    VIDEO_PARTS.controls.css,
    { timeout: 15000 },
  )
  return frame
}

function preferencesState(frame: Frame, q: VideoQueries) {
  return frame.evaluate((selectors) => {
    const find = (selector: string) =>
      document.querySelector<HTMLElement>(selector)
    const video = find(selectors.video) as HTMLVideoElement & { probe?: true }
    const status = find(selectors.status)!
    return {
      lang: document.documentElement.lang,
      theme: document.documentElement.dataset.theme ?? null,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      background: getComputedStyle(find(selectors.controls)!).backgroundColor,
      // Both are found by the name the catalogue gives them in the language
      // the app asked for.
      playerNamed: find(selectors.player) !== null,
      settingsNamed: find(selectors.settings) !== null,
      // Which of the play button's names it carries now.
      play: find(selectors.play)?.getAttribute('aria-label') ?? null,
      message: status.hidden
        ? null
        : find(selectors.statusMessage)!.textContent,
      startHidden: find(selectors.startPlay)!.hidden,
      paused: video.paused,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      // Set on the element below: still there means the same element kept
      // playing through every change.
      sameVideo: video.probe === true,
    }
  }, q.selectors())
}

// The player starts in the browser's language, takes the app's preferences
// late and as they change without touching playback, ignores malformed ones
// and any not sent by its parent, and a replacement frame gets the current
// ones.
async function preferencesFlow(
  page: Page,
  frame: Frame,
  browser: Locale,
  signEntry: () => Promise<string>,
) {
  const app = browser === 'en' ? 'ja' : 'en'
  // Each language has its own queries: the names the player publishes move
  // with the language the app asks for.
  const queries = (locale: Locale) => videoQueries(frame, locale)
  const own = queries(browser)
  const asked = queries(app)
  const send = async (preferences: ViewerPreferences) => {
    await parentWindow(page).sendPreferences(
      viewerPreferencesMessage(preferences),
    )
    await frame.waitForFunction(
      (wanted) =>
        `${document.documentElement.lang} ${document.documentElement.dataset.theme}` ===
        wanted,
      `${preferences.locale} ${preferences.theme}`,
      { timeout: 5000 },
    )
    return preferencesState(frame, queries(preferences.locale))
  }
  const initial = await preferencesState(frame, own)
  // Late: the loading notice on screen follows the app's language.
  const late = await send({ locale: app, theme: 'light' })
  await simulateLoadedClip(frame, asked)
  const loaded = await preferencesState(frame, asked)
  // A seek before the first play also retires the large play button.
  await setRangeValue(frame, asked.selector('seek'), 50)
  const seekedFirst = await preferencesState(frame, asked)
  await asked.find('settings').click()
  await asked.find('speed').selectOption('1.5')
  await asked.find('speed').press('Escape')
  await asked.find('play').click()
  await frame.evaluate((selector) => {
    ;(
      document.querySelector(selector) as HTMLVideoElement & { probe?: true }
    ).probe = true
  }, asked.selector('video'))
  // Where only the video can go full screen (iPhone Safari), the video does,
  // with the system's controls, and no failure notice shows.
  const videoOnlyFullscreen = await frame.evaluate(async (selectors) => {
    const player = document.querySelector(selectors.player) as HTMLElement & {
      webkitRequestFullscreen?: unknown
    }
    const video = document.querySelector(
      selectors.video,
    ) as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void
    }
    Object.defineProperty(player, 'requestFullscreen', {
      value: undefined,
      configurable: true,
    })
    Object.defineProperty(player, 'webkitRequestFullscreen', {
      value: undefined,
      configurable: true,
    })
    let entered = false
    video.webkitEnterFullscreen = () => {
      entered = true
    }
    document.querySelector<HTMLElement>(selectors.fullscreen)!.click()
    // test-wait: elapsed-time — the fullscreen request must be handled before the notice is read.
    await new Promise((resolve) => setTimeout(resolve, 100))
    delete (player as { requestFullscreen?: unknown }).requestFullscreen
    delete player.webkitRequestFullscreen
    delete video.webkitEnterFullscreen
    return {
      entered,
      notice: !document.querySelector<HTMLElement>(selectors.status)!.hidden,
    }
  }, asked.selectors())
  // A visible failure notice: the player refuses to go full screen.
  await frame.evaluate((selector) => {
    document.querySelector<HTMLElement>(selector)!.requestFullscreen = () =>
      Promise.reject(new Error('refused'))
  }, asked.selector('player'))
  await asked.find('fullscreen').click()
  await frame.waitForFunction(
    (status) => !document.querySelector<HTMLElement>(status)!.hidden,
    asked.selector('status'),
    { timeout: 5000 },
  )
  const refused = await preferencesState(frame, asked)
  const changed = await send({ locale: browser, theme: 'dark' })
  // Counts the messages the player has handled: its own listener runs
  // before this later one for each message.
  await frame.evaluate(() => {
    const counter = window as unknown as { handled: number }
    counter.handled = 0
    addEventListener('message', () => {
      counter.handled += 1
    })
  })
  await page.evaluate(() => {
    const parent = window as unknown as ParentWindow
    for (const invalid of [
      { locale: 'fr', theme: 'dark' },
      { locale: 'ja', theme: 'sepia' },
      { locale: 'en' },
    ])
      parent.postToViewer({
        source: 'artifactshare-parent',
        kind: 'viewer-preferences',
        ...invalid,
      })
  })
  // Well formed, but from the player's own window instead of its parent.
  await frame.evaluate(
    (message) => window.postMessage(message, '*'),
    viewerPreferencesMessage({ locale: app, theme: 'light' }),
  )
  await frame.waitForFunction(
    () => (window as unknown as { handled: number }).handled >= 4,
    undefined,
    { timeout: 5000 },
  )
  const ignored = await preferencesState(frame, own)
  await send({ locale: app, theme: 'dark' })
  const next = new URL(await signEntry())
  await page.evaluate(
    (src) => (window as unknown as ParentWindow).replaceViewer(src, 'viewer-2'),
    `${next.pathname}${next.search}`,
  )
  const replacement = await framedPlayer(page, 'viewer-2')
  // The app sends the current preferences when a new document answers its
  // ready check (see sandbox-frame-recovery). This stand-in sends them on the
  // frame's load, which WebKit and Firefox hold back while the media requests
  // are held, so it sends them again once the new player is up.
  await page.evaluate(
    (message) => (window as unknown as ParentWindow).sendPreferences(message),
    viewerPreferencesMessage({ locale: app, theme: 'dark' }),
  )
  await replacement.waitForFunction(
    (wanted) => document.documentElement.lang === wanted,
    app,
    { timeout: 5000 },
  )
  const replaced = await preferencesState(
    replacement,
    videoQueries(replacement, app),
  )
  return {
    initial,
    late,
    loaded,
    seekedFirst,
    refused,
    videoOnlyFullscreen,
    changed,
    ignored,
    replaced,
  }
}

// Runs the real sandbox Worker (wrangler.sandbox.jsonc) with a seeded
// link-shared video version. A loopback proxy forwards every browser request
// unchanged to the Worker under the version's sandbox hostname; it only holds
// the media element's own requests (controls) or fails the original
// (transport). The player is then driven the way a viewer does.
export const videoViewerScenario = defineBrowserCommand(
  async (
    { page },
    scenario: VideoScenario,
    width: number,
    // A landscape phone: touch input and a short viewport wider than 700px.
    device: 'default' | 'landscape-phone' = 'default',
    // The browser's language.
    locale: 'en-US' | 'ja-JP' = 'en-US',
  ) => {
    const touch = device === 'landscape-phone'
    // The preferences scenario frames the player in a parent page the way
    // the app does; the fixture lets that page be a frame ancestor.
    const framed = scenario === 'preferences'
    let parentPage = ''
    const height = touch ? 390 : width < 700 ? 844 : 900
    const sandbox = await sandboxWorker(secret)
    const requests: string[] = []
    const workerStatuses: string[] = []
    let origin = ''
    let workerOrigin = ''
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', origin)
        if (framed && url.pathname === PARENT_PATH) {
          response
            .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(parentPage)
          return
        }
        if (url.pathname === VIDEO_ORIGINAL_PATH) {
          const held =
            scenario === 'controls' ||
            scenario === 'acquire-failure' ||
            scenario === 'preferences'
          if (held && isMediaRequest(request)) return
          // The player's own full fetch has no query; the attachment link
          // (?download=1) still reaches the Worker.
          if (scenario === 'acquire-failure' && url.search === '') {
            response.writeHead(500).end()
            return
          }
          if (scenario === 'transport') {
            // test-wait: elapsed-time — the stub holds the response to act as a slow transport failure.
            await new Promise((resolve) => setTimeout(resolve, 1000))
            response.writeHead(500).end()
            return
          }
        }
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(request.headers))
          if (
            value !== undefined &&
            ![
              'host',
              'connection',
              'content-length',
              'accept-encoding',
            ].includes(name)
          )
            headers[name] = Array.isArray(value) ? value.join(', ') : value
        const result = await sandbox.fetch(
          `${workerOrigin}${url.pathname}${url.search}`,
          { method: request.method, headers, redirect: 'manual' },
        )
        workerStatuses.push(`${url.pathname}: ${result.status}`)
        for (const [name, value] of result.headers)
          if (
            ![
              'set-cookie',
              'content-length',
              'content-encoding',
              'transfer-encoding',
            ].includes(name)
          )
            response.setHeader(
              name,
              framed && name === 'content-security-policy'
                ? value.replace(
                    /frame-ancestors [^;]+/,
                    "frame-ancestors 'self'",
                  )
                : value,
            )
        const cookies = result.headers.getSetCookie()
        if (cookies.length) response.setHeader('Set-Cookie', cookies)
        response.statusCode = result.status
        response.end(Buffer.from(await result.arrayBuffer()))
      } catch (error) {
        workerStatuses.push(`${request.url}: ${String(error)}`)
        response.writeHead(500).end()
      }
    })
    const createContext = () =>
      page
        .context()
        .browser()!
        .newContext({
          viewport: { width, height },
          locale,
          colorScheme: 'light',
          reducedMotion: 'reduce',
          ...(touch
            ? {
                hasTouch: true,
                // Firefox does not support isMobile emulation.
                isMobile:
                  page.context().browser()!.browserType().name() !== 'firefox',
              }
            : {}),
        })
    let browserContext: Awaited<ReturnType<typeof createContext>> | undefined
    // The player speaks the browser's language until the app asks for
    // another one.
    const viewerLocale: Locale = locale === 'ja-JP' ? 'ja' : 'en'
    try {
      const fixture = scenario === 'playback' ? PLAYABLE_CLIP : FIXTURE
      const signEntry = await seedVideoArtifact(await sandbox.getEnv(), fixture)
      const entry = new URL(await signEntry())
      workerOrigin = entry.origin
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture port')
      origin = `http://127.0.0.1:${address.port}`
      browserContext = await createContext()
      // Every query waits for its own control instead of hanging the test.
      browserContext.setDefaultTimeout(15000)
      await browserContext.addInitScript(() => {
        const violations: string[] = []
        ;(window as unknown as { violations: string[] }).violations = violations
        addEventListener('securitypolicyviolation', (event) =>
          violations.push(`${event.violatedDirective} ${event.blockedURI}`),
        )
      })
      browserContext.on('request', (request) => requests.push(request.url()))
      const player = await browserContext.newPage()
      if (framed) {
        parentPage = parentDocument(`${entry.pathname}${entry.search}`, null)
        // The held media requests keep some engines from firing load.
        await player.goto(`${origin}${PARENT_PATH}`, {
          timeout: 15000,
          waitUntil: 'domcontentloaded',
        })
        const frame = await framedPlayer(player, 'viewer-1')
        const flow = await preferencesFlow(
          player,
          frame,
          viewerLocale,
          signEntry,
        )
        const violations: string[] = []
        for (const each of player.frames())
          violations.push(
            ...(await each.evaluate(
              () =>
                (window as unknown as { violations?: string[] }).violations ??
                [],
            )),
          )
        return {
          preferences: flow,
          violations,
          origin,
          offOrigin: requests.filter(
            (url) => !url.startsWith(origin) && !url.startsWith('blob:'),
          ),
          workerStatuses,
        }
      }
      const entryResponse = await player.goto(
        `${origin}${entry.pathname}${entry.search}`,
        { timeout: 15000, waitUntil: 'domcontentloaded' },
      )
      if (entryResponse?.status() !== 200)
        throw new Error(`Sandbox entry failed: ${workerStatuses.join(', ')}`)
      const frame = player.mainFrame()
      const q = videoQueries(frame, viewerLocale)
      // The player has mounted its controls.
      await frame.waitForFunction(
        (controls) =>
          document.querySelector<HTMLElement>(controls)?.hidden === false,
        VIDEO_PARTS.controls.css,
      )
      const status = () =>
        frame.evaluate((selectors) => {
          const video = document.getElementById('video') as HTMLVideoElement
          const download = document.querySelector<HTMLAnchorElement>(
            selectors.statusDownload,
          )!
          return {
            state: document.documentElement.dataset.videoState,
            message: document.querySelector(selectors.statusMessage)!
              .textContent,
            statusHidden: document.querySelector<HTMLElement>(selectors.status)!
              .hidden,
            downloadOffered: !download.hidden,
            downloadHref: download.getAttribute('href'),
            autoplay: video.autoplay,
            paused: video.paused,
          }
        }, q.selectors())
      const initial = await status()
      const common = () =>
        frame.evaluate(() => ({
          violations: (window as unknown as { violations: string[] })
            .violations,
        }))

      const offOrigin = () =>
        // WebKit reports its own media pipeline's blob: URLs.
        requests.filter(
          (url) => !url.startsWith(origin) && !url.startsWith('blob:'),
        )
      const saveFromLink = async (link: Locator) => {
        const [saved] = await Promise.all([
          player.waitForEvent('download'),
          link.click(),
        ])
        // A stream works with a local or a remotely connected browser.
        const chunks: Buffer[] = []
        for await (const chunk of await saved.createReadStream())
          chunks.push(chunk as Buffer)
        return { name: saved.suggestedFilename(), bytes: Buffer.concat(chunks) }
      }

      if (scenario === 'playback') {
        const failedState = () =>
          ['corrupt', 'unsupported', 'transport'].includes(
            document.documentElement.dataset.videoState ?? '',
          )
        await frame.waitForFunction(
          () => document.documentElement.dataset.videoState !== 'loading',
          undefined,
          { timeout: 15000 },
        )
        const media = () =>
          frame.evaluate((selectors) => {
            const video = document.getElementById('video') as HTMLVideoElement
            return {
              readyState: video.readyState,
              error: video.error?.code ?? null,
              duration: video.duration,
              currentTime: video.currentTime,
              paused: video.paused,
              seeking: video.seeking,
              elapsed: document.querySelector(selectors.elapsed)!.textContent,
              total: document.querySelector(selectors.duration)!.textContent,
            }
          }, q.selectors())
        const before = await media()
        // Decodable means playback really advances; an engine that cannot
        // decode the clip reports a media error once it tries.
        if (!(await frame.evaluate(failedState))) {
          await q.find('startPlay').click()
          await frame.waitForFunction(
            () =>
              (document.getElementById('video') as HTMLVideoElement)
                .currentTime > 0.3 ||
              ['corrupt', 'unsupported', 'transport'].includes(
                document.documentElement.dataset.videoState ?? '',
              ),
            undefined,
            { timeout: 10000 },
          )
        }
        const playing = await media()
        const decodable =
          playing.currentTime > 0.3 && !(await frame.evaluate(failedState))
        if (!decodable) {
          await frame.waitForFunction(failedState, undefined, {
            timeout: 10000,
          })
          return {
            initial,
            final: await status(),
            playback: { decodable, before },
            ...(await common()),
            origin,
            offOrigin: offOrigin(),
            workerStatuses,
          }
        }
        await q.find('play').click()
        await frame.evaluate(() => {
          const video = document.getElementById('video') as HTMLVideoElement
          video.addEventListener(
            'seeked',
            () => {
              document.documentElement.dataset.testSeeked = 'true'
            },
            { once: true },
          )
        })
        await setRangeValue(frame, q.selector('seek'), 50)
        // Seekable means the engine completes the seek at the target time;
        // some engines decode the clip but never finish seeking it.
        const seekCompleted = await frame
          .waitForFunction(
            () => {
              const video = document.getElementById('video') as HTMLVideoElement
              return (
                document.documentElement.dataset.testSeeked === 'true' &&
                !video.seeking &&
                video.readyState >= 2 &&
                Math.abs(video.currentTime - video.duration / 2) < 0.5
              )
            },
            undefined,
            { timeout: 5000 },
          )
          .then(() => true)
          .catch((error: unknown) => {
            if (!(error instanceof errors.TimeoutError)) throw error
            return false
          })
        const seeked = await media()
        return {
          initial,
          final: await status(),
          playback: {
            decodable,
            seekable: seekCompleted,
            before,
            playing,
            seeked,
          },
          ...(await common()),
          origin,
          offOrigin: offOrigin(),
          workerStatuses,
        }
      }

      if (scenario === 'acquire-failure') {
        await simulateLoadedClip(frame, q)
        await frame.waitForFunction(
          (download) =>
            document.querySelector<HTMLElement>(download)!.dataset.ready ===
            'failed',
          q.selector('download'),
          { timeout: 10000 },
        )
        const afterFailure = await status()
        const playerUrl = player.url()
        const saved = await saveFromLink(q.find('statusDownload'))
        return {
          initial,
          final: afterFailure,
          fallbackDownload: {
            name: saved.name,
            sameBytes: Buffer.compare(saved.bytes, Buffer.from(FIXTURE)) === 0,
            urlUnchanged: player.url() === playerUrl,
          },
          ...(await common()),
          origin,
          offOrigin: offOrigin(),
          workerStatuses,
        }
      }

      if (scenario !== 'controls') {
        await frame.waitForFunction(
          () => document.documentElement.dataset.videoState !== 'loading',
          undefined,
          { timeout: 20000 },
        )
        return {
          initial,
          final: await status(),
          snapshot: await snapshot(frame, q),
          ...(await common()),
          origin,
          // WebKit reports its own media pipeline's blob: URLs.
          offOrigin: requests.filter(
            (url) => !url.startsWith(origin) && !url.startsWith('blob:'),
          ),
          workerStatuses,
        }
      }

      await simulateLoadedClip(frame, q)
      const loaded = await snapshot(frame, q)
      const steps: Record<string, Awaited<ReturnType<typeof snapshot>>> = {}
      const setRange = (part: 'seek' | 'volume', value: number) =>
        setRangeValue(frame, q.selector(part), value)

      // Play and pause with the buttons; nothing played before.
      await q.find('startPlay').click()
      steps.playing = await snapshot(frame, q)
      await q.find('play').click()
      steps.pausedByButton = await snapshot(frame, q)

      // Seek bar bounds and times.
      await setRange('seek', 100)
      steps.seekEnd = await snapshot(frame, q)
      await setRange('seek', 50)
      steps.seekMiddle = await snapshot(frame, q)

      // Shortcuts while the player has focus.
      await q.find('player').focus()
      await player.keyboard.press('ArrowRight')
      steps.arrowRight = await snapshot(frame, q)
      await player.keyboard.press('ArrowLeft')
      await player.keyboard.press('ArrowLeft')
      steps.arrowLeftTwice = await snapshot(frame, q)
      await player.keyboard.press('Space')
      steps.space = await snapshot(frame, q)
      await player.keyboard.press('k')
      steps.k = await snapshot(frame, q)
      await setRange('seek', 0)
      await q.find('player').focus()
      await player.keyboard.press('ArrowLeft')
      steps.arrowLeftAtStart = await snapshot(frame, q)
      // The seek bar keeps its own arrow keys (one native step, not 5 s) and
      // Space on a button activates only that button, once.
      await q.find('seek').focus()
      await player.keyboard.press('ArrowRight')
      steps.seekArrow = await snapshot(frame, q)
      await q.find('play').focus()
      await player.keyboard.press('Space')
      steps.spaceOnPlayButton = await snapshot(frame, q)
      await q.find('play').click()

      // Speed endpoints through the settings popover.
      await q.find('settings').click()
      const settingsOpen = await frame.evaluate(
        (options) => !document.querySelector<HTMLElement>(options)!.hidden,
        q.selector('playbackOptions'),
      )
      const speedOptions = await frame.evaluate(
        (speed) =>
          [
            ...document.querySelectorAll<HTMLOptionElement>(`${speed} option`),
          ].map((option) => Number(option.value)),
        q.selector('speed'),
      )
      await q.find('speed').selectOption('0.5')
      steps.slowest = await snapshot(frame, q)
      await q.find('speed').selectOption('2')
      steps.fastest = await snapshot(frame, q)
      await player.keyboard.press('Escape')
      // Escape in the panel closes it and returns to its button.
      const settingsClosed = await frame.evaluate(
        (selectors) =>
          document.querySelector<HTMLElement>(selectors.playbackOptions)!
            .hidden && !!document.activeElement?.matches(selectors.settings),
        q.selectors(),
      )

      // At the end the large button offers a replay.
      await frame.evaluate(() => {
        const video = document.getElementById('video') as HTMLVideoElement
        Object.defineProperty(video, 'ended', {
          configurable: true,
          get: () => true,
        })
        video.pause()
        video.dispatchEvent(new Event('ended'))
      })
      steps.ended = await snapshot(frame, q)
      await frame.evaluate(() => {
        const video = document.getElementById('video') as HTMLVideoElement
        Object.defineProperty(video, 'ended', {
          configurable: true,
          get: () => false,
        })
        video.dispatchEvent(new Event('seeked'))
      })

      // Notices over the picture: buffering while playing, a refused start
      // and a player that cannot go full screen. Each clears on the next
      // seek.
      const notice = () =>
        frame.evaluate(
          (selectors) =>
            document.querySelector<HTMLElement>(selectors.status)!.hidden
              ? null
              : document.querySelector(selectors.statusMessage)!.textContent,
          q.selectors(),
        )
      const clearNotice = () =>
        frame.evaluate(() =>
          document.getElementById('video')!.dispatchEvent(new Event('seeked')),
        )
      const noticeShown = () =>
        frame.waitForFunction(
          (shown) => !document.querySelector<HTMLElement>(shown)!.hidden,
          q.selector('status'),
          { timeout: 5000 },
        )
      await frame.evaluate(() => {
        const video = document.getElementById('video') as HTMLVideoElement
        void video.play()
        video.dispatchEvent(new Event('waiting'))
      })
      await noticeShown()
      const notices: Record<string, string | null> = {}
      notices.buffering = await notice()
      await frame.evaluate(() => {
        const video = document.getElementById('video') as HTMLVideoElement
        video.dispatchEvent(new Event('playing'))
        video.pause()
      })
      notices.afterBuffering = await notice()
      await frame.evaluate(() => {
        const video = document.getElementById('video') as HTMLVideoElement & {
          allowedPlay?: () => Promise<void>
        }
        video.allowedPlay = video.play
        video.play = () =>
          Promise.reject(new DOMException('Not allowed', 'NotAllowedError'))
      })
      await q.find('play').click()
      await noticeShown()
      notices.playRefused = await notice()
      await frame.evaluate(() => {
        const video = document.getElementById('video') as HTMLVideoElement & {
          allowedPlay?: () => Promise<void>
        }
        video.play = video.allowedPlay!
      })
      await clearNotice()
      // Neither the player nor the video can go full screen.
      await frame.evaluate((selector) => {
        const element = document.querySelector(selector)!
        for (const name of ['requestFullscreen', 'webkitRequestFullscreen'])
          Object.defineProperty(element, name, {
            configurable: true,
            value: undefined,
          })
        Object.defineProperty(
          document.getElementById('video')!,
          'webkitEnterFullscreen',
          { configurable: true, value: undefined },
        )
      }, q.selector('player'))
      await q.find('fullscreen').click()
      await noticeShown()
      notices.fullscreenUnavailable = await notice()
      notices.fullscreenElement = await frame.evaluate(
        (selector) =>
          !document.fullscreenElement
            ? null
            : document.fullscreenElement === document.querySelector(selector)
              ? 'player'
              : 'other',
        q.selector('player'),
      )
      await frame.evaluate((selector) => {
        const element = document.querySelector(selector)!
        for (const name of ['requestFullscreen', 'webkitRequestFullscreen'])
          Reflect.deleteProperty(element, name)
        Reflect.deleteProperty(
          document.getElementById('video')!,
          'webkitEnterFullscreen',
        )
      }, q.selector('player'))
      await clearNotice()

      let volumeCapability: 'not-offered' | 'applied' | 'unapplied' =
        'not-offered'
      let nativeVolumeSupported: boolean | null = null
      // Volume and mute (desktop only).
      if (width >= 700 && !touch) {
        // volumechange is dispatched asynchronously.
        const pressed = (value: string) =>
          frame.waitForSelector(
            inState(q.selector('mute'), `[aria-pressed="${value}"]`),
            { state: 'attached' },
          )
        nativeVolumeSupported = await frame.evaluate(() => {
          const video = document.getElementById('video') as HTMLVideoElement
          const previous = video.volume
          video.volume = 0.6
          const supported = Math.abs(video.volume - 0.6) < 0.01
          video.volume = previous
          return supported
        })
        await setRange('volume', 0.4)
        // An engine without an audio device (WebKit in a Linux container)
        // may never apply the volume; the test then checks the controls.
        await frame
          .waitForFunction(
            () =>
              Math.abs(
                (document.getElementById('video') as HTMLVideoElement).volume -
                  0.4,
              ) < 0.01,
            undefined,
            { timeout: 2000 },
          )
          .then(() => true)
          .catch((error: unknown) => {
            if (!(error instanceof errors.TimeoutError)) throw error
            return false
          })
        steps.volume = await snapshot(frame, q)
        // Classify the captured observation, including application just after timeout.
        volumeCapability =
          Math.abs(steps.volume.volume - 0.4) < 0.01 ? 'applied' : 'unapplied'
        await q.find('mute').click()
        await pressed('true')
        steps.muted = await snapshot(frame, q)
        await q.find('mute').click()
        await pressed('false')
        steps.unmuted = await snapshot(frame, q)
      }

      // Full screen keeps the controls with the picture. The name of the
      // button follows fullscreenchange, which engines dispatch later.
      const waitForFullscreenName = (
        part: 'enterFullscreen' | 'exitFullscreen',
      ) => q.find(part).waitFor({ state: 'attached', timeout: 3000 })

      // Where the player cannot go full screen but the video can (iPhone
      // Safari, and WebKit in tests), the video's own full screen is used;
      // a stub records it so the system player does not take over the test.
      await frame.evaluate(() => {
        const video = document.getElementById('video') as HTMLVideoElement & {
          webkitEnterFullscreen?: () => void
        }
        if (!document.fullscreenEnabled && video.webkitEnterFullscreen)
          Object.defineProperty(video, 'webkitEnterFullscreen', {
            configurable: true,
            value: () => {
              document.documentElement.dataset.testVideoFullscreen = 'true'
            },
          })
      })
      await q.find('fullscreen').click()
      await frame.waitForFunction(
        (selectors) => {
          const video = document.getElementById('video') as HTMLVideoElement
          if (document.fullscreenEnabled)
            return (
              document.fullscreenElement ===
                document.querySelector(selectors.player) &&
              !!document.querySelector(selectors.exitFullscreen)
            )
          if ('webkitEnterFullscreen' in video)
            return (
              document.documentElement.dataset.testVideoFullscreen === 'true'
            )
          return !document.querySelector<HTMLElement>(selectors.status)!.hidden
        },
        q.selectors(),
        { timeout: 3000 },
      )
      steps.fullscreen = await snapshot(frame, q)
      let fullscreenSettings = null
      if (steps.fullscreen.fullscreen) {
        // The settings open inside the full-screen player and still work.
        await q.find('settings').click()
        await q.find('speed').selectOption('1.25')
        fullscreenSettings = await frame.evaluate((selectors) => {
          const panel = document.querySelector<HTMLElement>(
            selectors.playbackOptions,
          )!
          const box = panel.getBoundingClientRect()
          return {
            open: !panel.hidden,
            insidePlayer: document
              .querySelector(selectors.player)!
              .contains(document.querySelector(selectors.speed)),
            onScreen:
              box.width > 0 &&
              box.top >= 0 &&
              box.bottom <= innerHeight &&
              box.right <= innerWidth,
            playbackRate: (document.getElementById('video') as HTMLVideoElement)
              .playbackRate,
            fullscreen: !document.fullscreenElement
              ? null
              : document.fullscreenElement ===
                  document.querySelector(selectors.player)
                ? 'player'
                : 'other',
          }
        }, q.selectors())
        await q.find('settings').click()
        await q.find('fullscreen').click()
        await frame.waitForFunction(() => document.fullscreenElement === null)
        await waitForFullscreenName('enterFullscreen')
      }
      steps.afterFullscreen = await snapshot(frame, q)

      // Download keeps working after the sandbox cookie expires: the player
      // fetched the whole original while it was valid.
      await frame.waitForFunction(
        (download) =>
          document.querySelector<HTMLElement>(download)!.dataset.ready ===
          'true',
        q.selector('download'),
        { timeout: 10000 },
      )
      await browserContext.clearCookies()
      const playerUrl = player.url()
      const originalFetches = () =>
        requests.filter((url) => new URL(url).pathname === VIDEO_ORIGINAL_PATH)
          .length
      const fetchesBeforeDownload = originalFetches()
      const save = async () => {
        const [saved] = await Promise.all([
          player.waitForEvent('download'),
          q.find('download').click(),
        ])
        // A stream works with a local or a remotely connected browser.
        const chunks: Buffer[] = []
        for await (const chunk of await saved.createReadStream())
          chunks.push(chunk as Buffer)
        return {
          name: saved.suggestedFilename(),
          sameBytes:
            Buffer.compare(Buffer.concat(chunks), Buffer.from(FIXTURE)) === 0,
        }
      }
      const download = {
        ...(await save()),
        fetchedOriginal: originalFetches() > fetchesBeforeDownload,
        urlUnchanged: player.url() === playerUrl,
      }
      // A later network failure of the element (the expired cookie) switches
      // playback to the in-memory copy instead of a failure state.
      // It continues at the same position and speed, still playing.
      const playsFromLocalCopy = await frame.evaluate(() => {
        const video = document.getElementById('video') as HTMLVideoElement
        void video.play()
        video.currentTime = 30
        video.playbackRate = 1.5
        Object.defineProperty(video, 'error', {
          configurable: true,
          get: () => ({ code: 2 }),
        })
        video.dispatchEvent(new Event('error'))
        const switched =
          video.currentSrc.startsWith('blob:') || video.src.startsWith('blob:')
        Object.defineProperty(video, 'error', {
          configurable: true,
          get: () => null,
        })
        // The copy loads from its start, paused at the normal speed, until
        // its metadata arrives.
        video.pause()
        video.currentTime = 0
        video.playbackRate = 1
        video.dispatchEvent(new Event('loadedmetadata'))
        return {
          switched,
          state: document.documentElement.dataset.videoState,
          restored: {
            currentTime: video.currentTime,
            playbackRate: video.playbackRate,
            paused: video.paused,
          },
        }
      })
      // A page kept for back/forward navigation keeps its copy.
      await frame.evaluate(() =>
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
      )
      const afterBackForward = await save()

      return {
        initial,
        loaded,
        steps,
        settingsOpen,
        settingsClosed,
        speedOptions,
        fullscreenSettings,
        volumeCapability,
        nativeVolumeSupported,
        notices,
        download,
        afterBackForward,
        playsFromLocalCopy,
        ...(await common()),
        origin,
        offOrigin: requests.filter(
          (url) => !url.startsWith(origin) && !url.startsWith('blob:'),
        ),
        workerStatuses,
      }
    } finally {
      await browserContext?.close()
      if (server.listening) {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
      }
    }
  },
)

type Rect = {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}
type Snapshot = {
  state?: string
  paused: boolean
  currentTime: number
  playbackRate: number
  muted: boolean
  volume: number
  nativeControls: boolean
  elapsed: string | null
  duration: string | null
  seekValue: number
  seekText: string | null
  playLabel: string | null
  startHidden: boolean
  statusHidden: boolean
  muteLabel: string | null
  mutePressed: string | null
  volumeSlider: number
  volumeVisible: boolean
  touchDevice: boolean
  picture: Rect
  controlsBox: Rect
  controls: Array<Rect & { name: string }>
  viewport: { width: number; height: number }
  scrollWidth: number
  fullscreenEnabled: boolean
  videoFullscreen: boolean
  fullscreen: string | null
  fullscreenLabel: string | null
}
type Status = {
  state?: string
  message: string | null
  statusHidden: boolean
  downloadOffered: boolean
  downloadHref: string | null
  autoplay: boolean
  paused: boolean
}
type Saved = { name: string; sameBytes: boolean }
type PreferencesState = {
  lang: string
  theme: string | null
  colorScheme: string
  background: string
  playerNamed: boolean
  settingsNamed: boolean
  play: string | null
  message: string | null
  startHidden: boolean
  paused: boolean
  currentTime: number
  playbackRate: number
  sameVideo: boolean
}
type Media = {
  readyState: number
  error: number | null
  duration: number
  currentTime: number
  paused: boolean
  seeking: boolean
  elapsed: string | null
  total: string | null
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    videoViewerScenario: (
      scenario: VideoScenario,
      width: number,
      device?: 'default' | 'landscape-phone',
      locale?: 'en-US' | 'ja-JP',
    ) => Promise<{
      initial: Status
      final?: Status
      snapshot?: Snapshot
      loaded?: Snapshot
      steps?: Record<string, Snapshot>
      volumeCapability?: 'not-offered' | 'applied' | 'unapplied'
      nativeVolumeSupported?: boolean | null
      settingsOpen?: boolean
      settingsClosed?: boolean
      speedOptions?: number[]
      fullscreenSettings?: {
        open: boolean
        insidePlayer: boolean
        onScreen: boolean
        playbackRate: number
        fullscreen: string | null
      } | null
      notices?: Record<
        | 'buffering'
        | 'afterBuffering'
        | 'playRefused'
        | 'fullscreenUnavailable'
        | 'fullscreenElement',
        string | null
      >
      preferences?: Record<
        | 'initial'
        | 'late'
        | 'loaded'
        | 'seekedFirst'
        | 'refused'
        | 'changed'
        | 'ignored'
        | 'replaced',
        PreferencesState
      > & { videoOnlyFullscreen: { entered: boolean; notice: boolean } }
      download?: Saved & { fetchedOriginal: boolean; urlUnchanged: boolean }
      playsFromLocalCopy?: {
        switched: boolean
        state?: string
        restored: { currentTime: number; playbackRate: number; paused: boolean }
      }
      afterBackForward?: Saved
      fallbackDownload?: Saved & { urlUnchanged: boolean }
      playback?: {
        decodable: boolean
        seekable?: boolean
        before: Media
        playing?: Media
        seeked?: Media
      }
      violations: string[]
      origin: string
      offOrigin: string[]
      workerStatuses: string[]
    }>
  }
}
