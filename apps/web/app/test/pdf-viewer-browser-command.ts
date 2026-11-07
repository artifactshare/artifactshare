import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { defineBrowserCommand } from '@vitest/browser-playwright'
import type { Frame, Page } from 'playwright'
import { signSandboxUrl } from '../lib/sandbox-token'
import {
  PDF_ORIGINAL_PATH,
  PDFJS_ASSET_PREFIX,
} from '../../workers/lib/pdf-viewer'

const webRoot = new URL('../..', import.meta.url).pathname
const secret = 'pdf-viewer-browser-fixture-only-'.repeat(3)

export type PdfScenario =
  | 'landscape'
  | 'portrait'
  | 'corrupt'
  | 'password'
  | 'transport'
  | 'unsupported'
  | 'mixed-slides'
  | 'mixed-report'
  | 'embedded-font'

type Size = readonly [number, number]
const PAGE_SIZES = {
  landscape: [720, 405],
  portrait: [612, 792],
} as const
// Page 2 differs from page 1: a taller slide, and a wide page in a report.
const MIXED_SIZES: Partial<Record<PdfScenario, Size[]>> = {
  'mixed-slides': [
    [720, 405],
    [720, 540],
    [720, 405],
  ],
  'mixed-report': [
    [612, 792],
    [1224, 792],
    [612, 792],
  ],
}

const STANDARD_FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

// An author font embedded in the PDF itself (Type3): every letter of the
// text is drawn as a solid box, which no fallback font would produce. Its
// glyph names keep the text extractable for the selectable text layer.
// Advances are proportional like most author fonts; equal advances would
// make pdf.js lay the text layer out in a monospace fallback.
const EMBEDDED_TEXT = 'Embedded'
const EMBEDDED_ADVANCES: Record<string, number> = {
  E: 600,
  m: 820,
  b: 560,
  e: 540,
  d: 560,
}
function embeddedBoxFont(firstGlyphObject: number) {
  const chars = Object.keys(EMBEDDED_ADVANCES)
  const codes = chars.map((c) => c.charCodeAt(0))
  const first = Math.min(...codes)
  const last = Math.max(...codes)
  const widths = Array.from(
    { length: last - first + 1 },
    (_, i) => EMBEDDED_ADVANCES[String.fromCharCode(first + i)] ?? 0,
  )
  // Each glyph is a box inset 50 units on both sides of its advance.
  const glyphs = chars.map((c) => {
    const advance = EMBEDDED_ADVANCES[c]!
    return `${advance} 0 d0 50 0 ${advance - 100} 700 re f`
  })
  return {
    font: `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 820 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << ${chars.map((c, i) => `/${c} ${firstGlyphObject + i} 0 R`).join(' ')} >> /Encoding << /Type /Encoding /Differences [${chars.map((c, i) => `${codes[i]} /${c}`).join(' ')}] >> /FirstChar ${first} /LastChar ${last} /Widths [${widths.join(' ')}] /Resources << >> >>`,
    glyphProcedures: glyphs.map(
      (glyph) => `<< /Length ${glyph.length} >>\nstream\n${glyph}\nendstream`,
    ),
  }
}

// Synthetic multi-page PDF; every page carries one text line in standard
// Helvetica, or in the embedded box font when `embedFont` is set.
function syntheticPdf(
  sizes: readonly Size[],
  pages: string[],
  trailerExtra = '',
  embedFont = false,
): Uint8Array<ArrayBuffer> {
  const embedded = embedFont ? embeddedBoxFont(4 + pages.length * 2) : null
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    embedded?.font ?? STANDARD_FONT,
  ]
  pages.forEach((text, i) => {
    const size = sizes[i] ?? sizes[0]
    const stream = `BT /F1 28 Tf 48 ${size[1] - 96} Td (${text}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size[0]} ${size[1]}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    )
  })
  if (embedded) objects.push(...embedded.glyphProcedures)
  let body = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = body.length
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets)
    body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

// The standard security handler with a user password: the empty password
// does not match /U, so pdf.js asks for a password.
const ENCRYPTION = ` /Encrypt << /Filter /Standard /V 1 /R 2 /O <${'4f'.repeat(32)}> /U <${'55'.repeat(32)}> /P -4 >> /ID [<${'01'.repeat(16)}> <${'01'.repeat(16)}>]`

function scenarioPdf(scenario: PdfScenario): Uint8Array<ArrayBuffer> {
  if (scenario === 'corrupt')
    return new TextEncoder().encode('%PDF-1.7\nsynthetic damaged bytes\n')
  if (scenario === 'embedded-font')
    return syntheticPdf([PAGE_SIZES.landscape], [EMBEDDED_TEXT], '', true)
  const mixed = MIXED_SIZES[scenario]
  if (mixed)
    return syntheticPdf(
      mixed,
      mixed.map((_, i) => `Mixed page ${i + 1}`),
    )
  const size = PAGE_SIZES[scenario === 'portrait' ? 'portrait' : 'landscape']
  const label = scenario === 'portrait' ? 'Report page' : 'Slide page'
  return syntheticPdf(
    [size],
    [1, 2, 3, 4].map((n) => `${label} ${n}`),
    scenario === 'password' ? ENCRYPTION : '',
  )
}

// Seeds one link-shared PDF version in the real sandbox Worker's D1 and R2 and
// returns the signed anonymous entry URL the app would hand to the viewer.
async function seedPdfArtifact(
  env: { DB: D1Database; BUCKET: R2Bucket },
  pdf: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8)
  const ids = {
    workspace: `ws-pdf-${suffix}`,
    user: `user-pdf-${suffix}`,
    container: `inbox-pdf-${suffix}`,
    artifact: `pdf${suffix}a`.slice(0, 10),
    version: `ver-pdf-${suffix}`,
  }
  const r2Key = `${ids.workspace}/${ids.artifact}/${ids.version}/Synthetic.pdf`
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
      "INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, current_version_id, created_at, updated_at, container_id) VALUES (?, ?, ?, 'Synthetic.pdf', 'pdf', 'link', ?, ?, ?, ?)",
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
      "INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at) VALUES (?, ?, 'pdf', 'published', '/Synthetic.pdf', ?, ?, 'synthetic', ?, ?, ?)",
    ).bind(
      ids.version,
      ids.artifact,
      r2Key,
      pdf.byteLength,
      ids.user,
      now,
      now,
    ),
  ])
  await env.BUCKET.put(r2Key, pdf, {
    httpMetadata: { contentType: 'application/pdf' },
  })
  return signSandboxUrl(
    {
      uid: null,
      wid: ids.workspace,
      aid: ids.artifact,
      vid: ids.version,
      fid: r2Key,
      mt: null,
      t: 'pdf',
      jti: `jti-${suffix}`,
    },
    secret,
    { APP_ENV: 'development' },
    '/Synthetic.pdf',
  )
}

function pageNumber(frame: Frame): Promise<number> {
  return frame.evaluate(() =>
    Number((document.getElementById('page-number') as HTMLInputElement).value),
  )
}

async function waitForPage(frame: Frame, page: number): Promise<number> {
  await frame
    .waitForFunction(
      (expected) =>
        (document.getElementById('page-number') as HTMLInputElement).value ===
        String(expected),
      page,
      { timeout: 5000 },
    )
    .catch(() => undefined)
  return pageNumber(frame)
}

function layout(frame: Frame) {
  return frame.evaluate(() => {
    const box = (id: string) => {
      const rect = document.getElementById(id)!.getBoundingClientRect()
      return {
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
    }
    const container = document.getElementById('viewer-container')!
    const current = document.querySelector<HTMLElement>(
      `.page[data-page-number="${(document.getElementById('page-number') as HTMLInputElement).value}"]`,
    )!
    const download = document
      .getElementById('download')!
      .getBoundingClientRect()
    return {
      frameWidth: innerWidth,
      download: {
        left: download.left,
        right: download.right,
        top: download.top,
        bottom: download.bottom,
      },
      verticalOverflow: container.scrollHeight - container.clientHeight,
      scrollTop: container.scrollTop,
      pagerCenter:
        (document.getElementById('previous')!.getBoundingClientRect().left +
          document.getElementById('next')!.getBoundingClientRect().right) /
        2,
      toolbarHeight: Math.round(
        document.querySelector('.pdf-toolbar')!.getBoundingClientRect().height,
      ),
      controls: ['previous', 'page-number', 'next', 'download'].map(box),
      previousDisabled: (
        document.getElementById('previous') as HTMLButtonElement
      ).disabled,
      nextDisabled: (document.getElementById('next') as HTMLButtonElement)
        .disabled,
      container: {
        width: container.clientWidth,
        height: container.clientHeight,
      },
      page: { width: current.offsetWidth, height: current.offsetHeight },
    }
  })
}

async function selectFirstLine(page: Page, frame: Frame): Promise<string> {
  const span = await frame.waitForSelector(
    '.page[data-page-number="1"] .textLayer span',
    { timeout: 10000 },
  )
  const box = (await span.boundingBox())!
  await page.mouse.move(box.x + 1, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
    steps: 8,
  })
  await page.mouse.up()
  return frame.evaluate(() => String(getSelection()))
}

// Runs the real sandbox Worker (wrangler.sandbox.jsonc, including its
// PDFJS_ASSETS binding) with a seeded link-shared PDF version. A loopback
// proxy forwards every browser request unchanged to the Worker under the
// version's sandbox hostname; it only injects the transport failure and the
// missing-library case. The viewer is then driven the way a reader does.
export const pdfViewerScenario = defineBrowserCommand(
  async ({ page }, scenario: PdfScenario, width: number) => {
    const height = width < 700 ? 844 : 900
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
        if (
          (scenario === 'unsupported' &&
            url.pathname.startsWith(PDFJS_ASSET_PREFIX)) ||
          (scenario === 'transport' && url.pathname === PDF_ORIGINAL_PATH)
        ) {
          if (scenario === 'transport')
            await new Promise((resolve) => setTimeout(resolve, 1500))
          response.writeHead(scenario === 'transport' ? 500 : 404).end()
          return
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
            response.setHeader(name, value)
        const cookies = result.headers.getSetCookie()
        if (cookies.length) response.setHeader('Set-Cookie', cookies)
        response.statusCode = result.status
        response.end(Buffer.from(await result.arrayBuffer()))
      } catch (error) {
        workerStatuses.push(`${request.url}: ${String(error)}`)
        response.writeHead(500).end()
      }
    })
    let context: Awaited<ReturnType<typeof createContext>> | undefined
    const createContext = () =>
      page.context().browser()!.newContext({
        viewport: { width, height },
        locale: 'en-US',
        reducedMotion: 'reduce',
      })
    try {
      await harness.listen()
      await sandbox.applyD1Migrations('DB')
      const entry = new URL(
        await seedPdfArtifact(await sandbox.getEnv(), scenarioPdf(scenario)),
      )
      workerOrigin = entry.origin
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture port')
      origin = `http://127.0.0.1:${address.port}`
      context = await createContext()
      await context.addInitScript(() => {
        const violations: string[] = []
        ;(window as unknown as { violations: string[] }).violations = violations
        addEventListener('securitypolicyviolation', (event) =>
          violations.push(`${event.violatedDirective} ${event.blockedURI}`),
        )
      })
      context.on('request', (request) => requests.push(request.url()))
      const artifact = await context.newPage()
      const entryResponse = await artifact.goto(
        `${origin}${entry.pathname}${entry.search}`,
        { timeout: 15000 },
      )
      if (entryResponse?.status() !== 200)
        throw new Error(`Sandbox entry failed: ${workerStatuses.join(', ')}`)
      const frame = artifact.mainFrame()
      const initialState = await frame.evaluate(
        () => document.documentElement.dataset.pdfState,
      )
      await frame.waitForFunction(
        () => document.documentElement.dataset.pdfState !== 'loading',
        undefined,
        { timeout: 20000 },
      )
      const status = await frame.evaluate(() => ({
        state: document.documentElement.dataset.pdfState,
        message: document.getElementById('status-message')!.textContent,
        downloadOffered: !document.getElementById('status-download')!.hidden,
        downloadHref: document
          .getElementById('status-download')!
          .getAttribute('href'),
      }))
      const common = {
        ...status,
        initialState,
        origin,
        offOrigin: requests.filter(
          (url) => !url.startsWith(origin) && !url.startsWith('blob:'),
        ),
        pdfjsRequests: requests.filter((url) =>
          url.startsWith(`${origin}/__as_pdf/pdfjs/`),
        ),
        violations: await frame.evaluate(
          () => (window as unknown as { violations: string[] }).violations,
        ),
        workerStatuses,
      }
      if (status.state !== 'ready') return common

      if (scenario === 'embedded-font') {
        const selection = await selectFirstLine(artifact, frame)
        await frame.waitForFunction(
          () => {
            const canvas = document.querySelector<HTMLCanvasElement>(
              '.page[data-page-number="1"] canvas',
            )
            if (!canvas?.width) return false
            const { data } = canvas
              .getContext('2d')!
              .getImageData(0, 0, canvas.width, canvas.height)
            for (let i = 0; i < data.length; i += 4)
              if (data[i]! < 96 && data[i + 3]! > 200) return true
            return false
          },
          undefined,
          { timeout: 10000 },
        )
        // Ink box of the drawn glyphs in CSS pixels, its ink density, and the
        // selectable text span over it.
        const embeddedFont = await frame.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            '.page[data-page-number="1"] canvas',
          )!
          const rect = canvas.getBoundingClientRect()
          const { data } = canvas
            .getContext('2d')!
            .getImageData(0, 0, canvas.width, canvas.height)
          const dark = (x: number, y: number) => {
            const i = (y * canvas.width + x) * 4
            return data[i]! < 96 && data[i + 3]! > 200
          }
          let [left, top, right, bottom] = [canvas.width, canvas.height, 0, 0]
          for (let y = 0; y < canvas.height; y++)
            for (let x = 0; x < canvas.width; x++)
              if (dark(x, y)) {
                left = Math.min(left, x)
                top = Math.min(top, y)
                right = Math.max(right, x + 1)
                bottom = Math.max(bottom, y + 1)
              }
          let inked = 0
          for (let y = top; y < bottom; y++)
            for (let x = left; x < right; x++) if (dark(x, y)) inked++
          const sx = rect.width / canvas.width
          const sy = rect.height / canvas.height
          const span = document
            .querySelector('.page[data-page-number="1"] .textLayer span')!
            .getBoundingClientRect()
          return {
            inkDensity: inked / ((right - left) * (bottom - top)),
            ink: {
              left: rect.left + left * sx,
              right: rect.left + right * sx,
              top: rect.top + top * sy,
              bottom: rect.top + bottom * sy,
            },
            span: {
              left: span.left,
              right: span.right,
              top: span.top,
              bottom: span.bottom,
            },
          }
        })
        return { ...common, selection, embeddedFont }
      }

      if (MIXED_SIZES[scenario]) {
        await frame.click('#next')
        const mixedPage = await waitForPage(frame, 2)
        await frame.waitForTimeout(500)
        return {
          ...common,
          mode: await frame.evaluate(() => document.body.dataset.mode),
          mixedPage,
          mixed: await layout(frame),
          widestPage: await frame.evaluate(() =>
            Math.max(
              ...[...document.querySelectorAll<HTMLElement>('.page')].map(
                (element) => element.offsetWidth,
              ),
            ),
          ),
        }
      }

      const pageWidthPt =
        PAGE_SIZES[scenario === 'portrait' ? 'portrait' : 'landscape'][0]
      const mode = await frame.evaluate(() => document.body.dataset.mode)
      const pageCount = await frame.evaluate(
        () => document.getElementById('page-count')!.textContent,
      )
      const initial = await layout(frame)
      const scale = initial.page.width / ((pageWidthPt * 4) / 3)
      const selection = await selectFirstLine(artifact, frame)

      await frame.focus('#viewer-container')
      const navigation: Record<string, number> = {}
      await frame.click('#next')
      navigation.afterNextButton = await waitForPage(frame, 2)
      await frame.focus('#viewer-container')
      await artifact.keyboard.press('ArrowRight')
      navigation.afterArrowRight = await waitForPage(frame, 3)
      await artifact.keyboard.press('End')
      navigation.afterEnd = await waitForPage(frame, 4)
      const atEnd = await layout(frame)
      await artifact.keyboard.press('ArrowRight')
      navigation.pastEnd = await waitForPage(frame, 4)
      await artifact.keyboard.press('ArrowLeft')
      navigation.afterArrowLeft = await waitForPage(frame, 3)
      await frame.click('#previous')
      navigation.afterPreviousButton = await waitForPage(frame, 2)
      await frame.focus('#viewer-container')
      await artifact.keyboard.press('Home')
      navigation.afterHome = await waitForPage(frame, 1)
      const atStart = await layout(frame)

      let scrolledPage: number | null = null
      if (mode === 'scroll') {
        await frame.evaluate(() => {
          const target = document.querySelector<HTMLElement>(
            '.page[data-page-number="3"]',
          )!
          document.getElementById('viewer-container')!.scrollTop =
            target.offsetTop
        })
        scrolledPage = await waitForPage(frame, 3)
      } else {
        await frame.click('#next')
        await waitForPage(frame, 2)
      }
      // Download serves the bytes pdf.js already holds, so it keeps working
      // after the sandbox cookie is gone.
      await context.clearCookies()
      const originalFetches = () =>
        requests.filter((url) => new URL(url).pathname === PDF_ORIGINAL_PATH)
          .length
      const fetchesBeforeDownload = originalFetches()
      const [saved] = await Promise.all([
        artifact.waitForEvent('download'),
        frame.click('#download'),
      ])
      const download = {
        name: saved.suggestedFilename(),
        sameBytes:
          Buffer.compare(
            await readFile((await saved.path())!),
            Buffer.from(scenarioPdf(scenario)),
          ) === 0,
        fetchedOriginal: originalFetches() > fetchesBeforeDownload,
      }
      const beforeResize = await pageNumber(frame)
      await artifact.setViewportSize({
        width: Math.round(width * 0.8),
        height: Math.round(height * 0.8),
      })
      await frame.waitForTimeout(500)
      const afterResize = {
        pageNumber: await pageNumber(frame),
        ...(await layout(frame)),
      }
      return {
        ...common,
        mode,
        pageCount,
        scale,
        selection,
        initial,
        atStart,
        atEnd,
        navigation,
        scrolledPage,
        beforeResize,
        afterResize,
        download,
      }
    } finally {
      await context?.close()
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

type Box = { top: number; width: number; height: number }
type Edges = { left: number; right: number; top: number; bottom: number }
type Layout = {
  frameWidth: number
  download: Edges
  verticalOverflow: number
  scrollTop: number
  pagerCenter: number
  toolbarHeight: number
  controls: Box[]
  previousDisabled: boolean
  nextDisabled: boolean
  container: { width: number; height: number }
  page: { width: number; height: number }
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    pdfViewerScenario: (
      scenario: PdfScenario,
      width: number,
    ) => Promise<{
      state?: string
      initialState?: string
      message: string | null
      downloadOffered: boolean
      downloadHref: string | null
      origin: string
      offOrigin: string[]
      pdfjsRequests: string[]
      violations: string[]
      workerStatuses: string[]
      embeddedFont?: {
        inkDensity: number
        ink: Edges
        span: Edges
      }
      mixedPage?: number
      mixed?: Layout
      widestPage?: number
      mode?: string
      pageCount?: string | null
      scale?: number
      selection?: string
      initial?: Layout
      atStart?: Layout
      atEnd?: Layout
      navigation?: Record<string, number>
      scrolledPage?: number | null
      beforeResize?: number
      afterResize?: Layout & { pageNumber: number }
      download?: { name: string; sameBytes: boolean; fetchedOriginal: boolean }
    }>
  }
}
