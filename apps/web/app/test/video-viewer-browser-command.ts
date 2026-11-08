import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { defineBrowserCommand } from '@vitest/browser-playwright'
import type { Frame, Page } from 'playwright'
import { signSandboxUrl } from '../lib/sandbox-token'
import {
  viewerPreferencesMessage,
  type ViewerPreferences,
} from '../viewers/shared/preferences'
import { VIDEO_ORIGINAL_PATH } from '../../workers/lib/video-viewer'
import {
  PARENT_PATH,
  parentDocument,
  type ParentWindow,
} from './pdf-viewer-browser-command'

const webRoot = new URL('../..', import.meta.url).pathname
const secret = 'video-viewer-browser-fixture-only-'.repeat(3)

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
      'INSERT INTO users (id, email, email_verified, name, created_at, updated_at, workspace_id, google_sub) VALUES (?, ?, 1, ?, ?, ?, ?, ?)',
    ).bind(
      ids.user,
      `${ids.user}@example.test`,
      'Synthetic author',
      now,
      now,
      ids.workspace,
      `sub-${suffix}`,
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
function simulateLoadedClip(frame: Frame) {
  return frame.evaluate(() => {
    const video = document.getElementById('video') as HTMLVideoElement
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
  })
}

function snapshot(frame: Frame) {
  return frame.evaluate(() => {
    const video = document.getElementById('video') as HTMLVideoElement
    const byId = (id: string) => document.getElementById(id)!
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
    const controls = [
      ...byId('controls').querySelectorAll('button, a, input, select'),
    ].filter(visible)
    return {
      state: document.documentElement.dataset.videoState,
      paused: video.paused,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      muted: video.muted,
      volume: video.volume,
      nativeControls: video.controls,
      elapsed: byId('elapsed').textContent,
      duration: byId('duration').textContent,
      seekValue: Number((byId('seek') as HTMLInputElement).value),
      seekText: byId('seek').getAttribute('aria-valuetext'),
      playLabel: byId('play').getAttribute('aria-label'),
      startHidden: byId('start-play').hidden,
      statusHidden: byId('status').hidden,
      muteLabel: byId('mute').getAttribute('aria-label'),
      mutePressed: byId('mute').getAttribute('aria-pressed'),
      volumeSlider: Number((byId('volume') as HTMLInputElement).value),
      volumeVisible: visible(byId('mute')) || visible(byId('volume')),
      touchDevice: matchMedia('(hover: none) and (pointer: coarse)').matches,
      picture: rect(document.querySelector('.video-picture')!),
      controlsBox: rect(byId('controls')),
      controls: controls.map((element) => ({
        id: element.id,
        ...rect(element),
      })),
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      fullscreenEnabled: document.fullscreenEnabled,
      fullscreen: document.fullscreenElement?.id ?? null,
      fullscreenLabel: byId('fullscreen').getAttribute('aria-label'),
    }
  })
}

// Sets a range the way a reader's drag does. React ignores a value set
// through the element's own property, so this uses the native setter.
function setRangeValue(frame: Frame, id: string, value: number) {
  return frame.evaluate(
    ([target, next]) => {
      const input = document.getElementById(target) as HTMLInputElement
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, String(next))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    [id, value] as const,
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
    () => document.getElementById('controls')?.hidden === false,
    undefined,
    { timeout: 15000 },
  )
  return frame
}

function preferencesState(frame: Frame) {
  return frame.evaluate(() => {
    const video = document.getElementById('video') as HTMLVideoElement & {
      probe?: true
    }
    const label = (id: string) =>
      document.getElementById(id)!.getAttribute('aria-label')
    return {
      lang: document.documentElement.lang,
      theme: document.documentElement.dataset.theme ?? null,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      background: getComputedStyle(document.getElementById('controls')!)
        .backgroundColor,
      player: label('player'),
      play: label('play'),
      settings: label('settings'),
      message: document.getElementById('status')!.hidden
        ? null
        : document.getElementById('status-message')!.textContent,
      startHidden: document.getElementById('start-play')!.hidden,
      paused: video.paused,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      // Set on the element below: still there means the same element kept
      // playing through every change.
      sameVideo: video.probe === true,
    }
  })
}

// The player starts in the browser's language, takes the app's preferences
// late and as they change without touching playback, ignores malformed ones
// and any not sent by its parent, and a replacement frame gets the current
// ones.
async function preferencesFlow(
  page: Page,
  frame: Frame,
  browser: 'en' | 'ja',
  signEntry: () => Promise<string>,
) {
  const app = browser === 'en' ? 'ja' : 'en'
  const send = async (preferences: ViewerPreferences) => {
    await page.evaluate(
      (message) => (window as unknown as ParentWindow).sendPreferences(message),
      viewerPreferencesMessage(preferences),
    )
    await frame.waitForFunction(
      (wanted) =>
        `${document.documentElement.lang} ${document.documentElement.dataset.theme}` ===
        wanted,
      `${preferences.locale} ${preferences.theme}`,
      { timeout: 5000 },
    )
    return preferencesState(frame)
  }
  const initial = await preferencesState(frame)
  // Late: the loading notice on screen follows the app's language.
  const late = await send({ locale: app, theme: 'light' })
  await simulateLoadedClip(frame)
  const loaded = await preferencesState(frame)
  // A seek before the first play also retires the large play button.
  await setRangeValue(frame, 'seek', 50)
  const seekedFirst = await preferencesState(frame)
  await frame.click('#settings')
  await frame.selectOption('#speed', '1.5')
  await frame.press('#speed', 'Escape')
  await frame.click('#play')
  await frame.evaluate(() => {
    ;(
      document.getElementById('video') as HTMLVideoElement & { probe?: true }
    ).probe = true
  })
  // Where only the video can go full screen (iPhone Safari), the video does,
  // with the system's controls, and no failure notice shows.
  const videoOnlyFullscreen = await frame.evaluate(async () => {
    const player = document.getElementById('player') as HTMLElement & {
      webkitRequestFullscreen?: unknown
    }
    const video = document.getElementById('video') as HTMLVideoElement & {
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
    document.getElementById('fullscreen')!.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    delete (player as { requestFullscreen?: unknown }).requestFullscreen
    delete player.webkitRequestFullscreen
    delete video.webkitEnterFullscreen
    return { entered, notice: !document.getElementById('status')!.hidden }
  })
  // A visible failure notice: the player refuses to go full screen.
  await frame.evaluate(() => {
    document.getElementById('player')!.requestFullscreen = () =>
      Promise.reject(new Error('refused'))
  })
  await frame.click('#fullscreen')
  await frame.waitForFunction(
    () => !document.getElementById('status')!.hidden,
    undefined,
    { timeout: 5000 },
  )
  const refused = await preferencesState(frame)
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
  const ignored = await preferencesState(frame)
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
  const replaced = await preferencesState(replacement)
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
    const { createTestHarness } = await import('wrangler')
    const harness = createTestHarness({
      root: webRoot,
      workers: [
        {
          configPath: 'wrangler.sandbox.jsonc',
          secrets: { BETTER_AUTH_SECRET: secret },
        },
      ],
    })
    const sandbox = harness.getWorker<{ DB: D1Database; BUCKET: R2Bucket }>()
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
    try {
      await harness.listen()
      await sandbox.applyD1Migrations('DB')
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
          locale === 'ja-JP' ? 'ja' : 'en',
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
      // The player has mounted its controls.
      await frame.waitForFunction(
        () => document.getElementById('controls')?.hidden === false,
      )
      const status = () =>
        frame.evaluate(() => ({
          state: document.documentElement.dataset.videoState,
          message: document.getElementById('status-message')!.textContent,
          statusHidden: document.getElementById('status')!.hidden,
          downloadOffered: !document.getElementById('status-download')!.hidden,
          downloadHref: document
            .getElementById('status-download')!
            .getAttribute('href'),
          autoplay: (document.getElementById('video') as HTMLVideoElement)
            .autoplay,
          paused: (document.getElementById('video') as HTMLVideoElement).paused,
        }))
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
      const saveFromLink = async (selector: string) => {
        const [saved] = await Promise.all([
          player.waitForEvent('download'),
          frame.click(selector),
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
          frame.evaluate(() => {
            const video = document.getElementById('video') as HTMLVideoElement
            return {
              readyState: video.readyState,
              error: video.error?.code ?? null,
              duration: video.duration,
              currentTime: video.currentTime,
              paused: video.paused,
              seeking: video.seeking,
              elapsed: document.getElementById('elapsed')!.textContent,
              total: document.getElementById('duration')!.textContent,
            }
          })
        const before = await media()
        // Decodable means playback really advances; an engine that cannot
        // decode the clip reports a media error once it tries.
        if (!(await frame.evaluate(failedState))) {
          await frame.click('#start-play')
          await frame
            .waitForFunction(
              () =>
                (document.getElementById('video') as HTMLVideoElement)
                  .currentTime > 0.3 ||
                ['corrupt', 'unsupported', 'transport'].includes(
                  document.documentElement.dataset.videoState ?? '',
                ),
              undefined,
              { timeout: 10000 },
            )
            .catch(() => undefined)
        }
        const playing = await media()
        const decodable =
          playing.currentTime > 0.3 && !(await frame.evaluate(failedState))
        if (!decodable) {
          await frame
            .waitForFunction(failedState, undefined, { timeout: 10000 })
            .catch(() => undefined)
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
        await frame.click('#play')
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
        await setRangeValue(frame, 'seek', 50)
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
          .catch(() => false)
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
        await simulateLoadedClip(frame)
        await frame.waitForFunction(
          () => document.getElementById('download')!.dataset.ready === 'failed',
          undefined,
          { timeout: 10000 },
        )
        const afterFailure = await status()
        const playerUrl = player.url()
        const saved = await saveFromLink('#status-download')
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
          snapshot: await snapshot(frame),
          ...(await common()),
          origin,
          // WebKit reports its own media pipeline's blob: URLs.
          offOrigin: requests.filter(
            (url) => !url.startsWith(origin) && !url.startsWith('blob:'),
          ),
          workerStatuses,
        }
      }

      await simulateLoadedClip(frame)
      const loaded = await snapshot(frame)
      const steps: Record<string, Awaited<ReturnType<typeof snapshot>>> = {}
      const setRange = (id: string, value: number) =>
        setRangeValue(frame, id, value)

      // Play and pause with the buttons; nothing played before.
      await frame.click('#start-play')
      steps.playing = await snapshot(frame)
      await frame.click('#play')
      steps.pausedByButton = await snapshot(frame)

      // Seek bar bounds and times.
      await setRange('seek', 100)
      steps.seekEnd = await snapshot(frame)
      await setRange('seek', 50)
      steps.seekMiddle = await snapshot(frame)

      // Shortcuts while the player has focus.
      await frame.focus('#player')
      await player.keyboard.press('ArrowRight')
      steps.arrowRight = await snapshot(frame)
      await player.keyboard.press('ArrowLeft')
      await player.keyboard.press('ArrowLeft')
      steps.arrowLeftTwice = await snapshot(frame)
      await player.keyboard.press('Space')
      steps.space = await snapshot(frame)
      await player.keyboard.press('k')
      steps.k = await snapshot(frame)
      await setRange('seek', 0)
      await frame.focus('#player')
      await player.keyboard.press('ArrowLeft')
      steps.arrowLeftAtStart = await snapshot(frame)
      // The seek bar keeps its own arrow keys (one native step, not 5 s) and
      // Space on a button activates only that button, once.
      await frame.focus('#seek')
      await player.keyboard.press('ArrowRight')
      steps.seekArrow = await snapshot(frame)
      await frame.focus('#play')
      await player.keyboard.press('Space')
      steps.spaceOnPlayButton = await snapshot(frame)
      await frame.click('#play')

      // Speed endpoints through the settings popover.
      await frame.click('#settings')
      const settingsOpen = await frame.evaluate(
        () => !document.getElementById('playback-options')!.hidden,
      )
      const speedOptions = await frame.evaluate(() =>
        [...document.querySelectorAll<HTMLOptionElement>('#speed option')].map(
          (option) => Number(option.value),
        ),
      )
      await frame.selectOption('#speed', '0.5')
      steps.slowest = await snapshot(frame)
      await frame.selectOption('#speed', '2')
      steps.fastest = await snapshot(frame)
      await player.keyboard.press('Escape')
      // Escape in the panel closes it and returns to its button.
      const settingsClosed = await frame.evaluate(
        () =>
          document.getElementById('playback-options')!.hidden &&
          document.activeElement?.id === 'settings',
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
      steps.ended = await snapshot(frame)
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
        frame.evaluate(() =>
          document.getElementById('status')!.hidden
            ? null
            : document.getElementById('status-message')!.textContent,
        )
      const clearNotice = () =>
        frame.evaluate(() =>
          document.getElementById('video')!.dispatchEvent(new Event('seeked')),
        )
      const noticeShown = () =>
        frame.waitForFunction(
          () => !document.getElementById('status')!.hidden,
          undefined,
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
      await frame.click('#play')
      await noticeShown()
      notices.playRefused = await notice()
      await frame.evaluate(() => {
        const video = document.getElementById('video') as HTMLVideoElement & {
          allowedPlay?: () => Promise<void>
        }
        video.play = video.allowedPlay!
      })
      await clearNotice()
      await frame.evaluate(() => {
        const element = document.getElementById('player')!
        for (const name of ['requestFullscreen', 'webkitRequestFullscreen'])
          Object.defineProperty(element, name, {
            configurable: true,
            value: undefined,
          })
      })
      await frame.click('#fullscreen')
      await noticeShown()
      notices.fullscreenUnavailable = await notice()
      notices.fullscreenElement = await frame.evaluate(
        () => document.fullscreenElement?.id ?? null,
      )
      await frame.evaluate(() => {
        const element = document.getElementById('player')!
        for (const name of ['requestFullscreen', 'webkitRequestFullscreen'])
          Reflect.deleteProperty(element, name)
      })
      await clearNotice()

      // Volume and mute (desktop only).
      if (width >= 700 && !touch) {
        // volumechange is dispatched asynchronously.
        const pressed = (value: string) =>
          frame.waitForSelector(`#mute[aria-pressed="${value}"]`, {
            state: 'attached',
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
          .catch(() => undefined)
        steps.volume = await snapshot(frame)
        await frame.click('#mute')
        await pressed('true')
        steps.muted = await snapshot(frame)
        await frame.click('#mute')
        await pressed('false')
        steps.unmuted = await snapshot(frame)
      }

      // Full screen keeps the controls with the picture.
      // The label follows fullscreenchange, which engines dispatch later.
      const fullscreenLabel = (label: string) =>
        frame
          .waitForSelector(`#fullscreen[aria-label="${label}"]`, {
            state: 'attached',
            timeout: 3000,
          })
          .catch(() => undefined)
      await frame.click('#fullscreen')
      await fullscreenLabel('Exit full screen')
      steps.fullscreen = await snapshot(frame)
      let fullscreenSettings = null
      if (steps.fullscreen.fullscreen) {
        // The settings open inside the full-screen player and still work.
        await frame.click('#settings')
        await frame.selectOption('#speed', '1.25')
        fullscreenSettings = await frame.evaluate(() => {
          const panel = document.getElementById('playback-options')!
          const box = panel.getBoundingClientRect()
          return {
            open: !panel.hidden,
            insidePlayer: document
              .getElementById('player')!
              .contains(document.getElementById('speed')),
            onScreen:
              box.width > 0 &&
              box.top >= 0 &&
              box.bottom <= innerHeight &&
              box.right <= innerWidth,
            playbackRate: (document.getElementById('video') as HTMLVideoElement)
              .playbackRate,
            fullscreen: document.fullscreenElement?.id ?? null,
          }
        })
        await frame.click('#settings')
        await frame.click('#fullscreen')
        await frame.waitForFunction(() => document.fullscreenElement === null)
        await fullscreenLabel('Full screen')
      }
      steps.afterFullscreen = await snapshot(frame)

      // Download keeps working after the sandbox cookie expires: the player
      // fetched the whole original while it was valid.
      await frame.waitForFunction(
        () => document.getElementById('download')!.dataset.ready === 'true',
        undefined,
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
          frame.click('#download'),
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
      await harness.close()
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
  controls: Array<Rect & { id: string }>
  viewport: { width: number; height: number }
  scrollWidth: number
  fullscreenEnabled: boolean
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
  player: string | null
  play: string | null
  settings: string | null
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
      >
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
