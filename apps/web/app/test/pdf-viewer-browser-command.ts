import { waitForBrowserLayout } from './browser-layout'
import { requiredWait } from './browser-waits'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { defineBrowserCommand } from '@vitest/browser-playwright'
import type { Download, Frame, Page } from 'playwright'
import { signSandboxUrl } from '../lib/sandbox-token'
import {
  viewerPreferencesMessage,
  type ViewerPreferences,
} from '../viewers/shared/preferences'
import { PDF_ORIGINAL_PATH, PDFJS_ASSET_PREFIX } from '../viewers/pdf/paths'
import { applyBrowserFixtureSchema } from './browser-fixture-schema'

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
  | 'pages'
  | 'search'
  | 'image-only'
  | 'late-text'
  | 'settings'
  | 'preferences'
  | 'page-failure'
  | 'slow-original'
  | 'page-bridge'
  | 'page-bridge-report'

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
// Helvetica, or in the embedded box font when `embedFont` is set. A null
// page has no text at all, only a drawn box, like a scanned page. A page
// with `boxes` also draws that many tiny boxes, so it takes long to draw.
type SyntheticPage = string | null | { text: string; boxes: number }
function syntheticPdf(
  sizes: readonly Size[],
  pages: SyntheticPage[],
  trailerExtra = '',
  embedFont = false,
): Uint8Array<ArrayBuffer> {
  const embedded = embedFont ? embeddedBoxFont(4 + pages.length * 2) : null
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    embedded?.font ?? STANDARD_FONT,
  ]
  pages.forEach((page, i) => {
    const size = sizes[i] ?? sizes[0]
    const text = typeof page === 'object' && page ? page.text : page
    let boxes = ''
    if (typeof page === 'object' && page)
      for (let b = 0; b < page.boxes; b++)
        boxes += `0.${b % 10} g ${b % 600} ${Math.floor(b / 600) % 300} 1 1 re f\n`
    const stream =
      text === null
        ? `0.4 g 48 48 ${size[0] - 96} ${size[1] - 96} re f`
        : `${boxes}BT /F1 28 Tf 48 ${size[1] - 96} Td (${text}) Tj ET`
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

// The search fixture has the term on pages 2, 4 and 6.
const SEARCH_TERM = 'lantern'
// In the page list fixture, the neighbours of page 40 take long to draw.
const SLOW_PAGES = [39, 41]
const FEATURE_PAGES: Partial<Record<PdfScenario, SyntheticPage[]>> = {
  pages: Array.from({ length: 100 }, (_, i) =>
    SLOW_PAGES.includes(i + 1)
      ? { text: `Deck page ${i + 1}`, boxes: 120000 }
      : `Deck page ${i + 1}`,
  ),
  search: [
    'Harbor overview',
    'Quarterly lantern figures',
    'Nothing to see',
    'Lantern route map',
    'Summary notes',
    'Closing lantern',
  ],
  'image-only': [null, null, null],
  // The first page has no text; a later page does.
  'late-text': [null, 'Later lantern page', 'Another page'],
}

// The page bridge fixtures: 14 pages, with the search term only on page 9.
const BRIDGE_PAGES = Array.from({ length: 14 }, (_, i) =>
  i === 8 ? `Bridge ${SEARCH_TERM} page 9` : `Bridge page ${i + 1}`,
)

function scenarioPdf(scenario: PdfScenario): Uint8Array<ArrayBuffer> {
  if (scenario === 'page-bridge' || scenario === 'page-bridge-report')
    return syntheticPdf(
      [PAGE_SIZES[scenario === 'page-bridge' ? 'landscape' : 'portrait']],
      BRIDGE_PAGES,
    )
  const featurePages = FEATURE_PAGES[scenario]
  if (featurePages) return syntheticPdf([PAGE_SIZES.landscape], featurePages)
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
// returns a signer for the anonymous entry URLs the app would hand to the
// viewer, each with its own one-time delivery id.
async function seedPdfArtifact(
  env: { DB: D1Database; BUCKET: R2Bucket },
  pdf: Uint8Array<ArrayBuffer>,
): Promise<() => Promise<string>> {
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
  let deliveries = 0
  return () =>
    signSandboxUrl(
      {
        uid: null,
        wid: ids.workspace,
        aid: ids.artifact,
        vid: ids.version,
        fid: r2Key,
        mt: null,
        t: 'pdf',
        jti: `jti-${suffix}-${++deliveries}`,
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
  await requiredWait(
    'PDF page number',
    frame.waitForFunction(
      (expected) =>
        (document.getElementById('page-number') as HTMLInputElement).value ===
        String(expected),
      page,
      { timeout: 5000 },
    ),
  )
  return pageNumber(frame)
}

function layout(frame: Frame) {
  return frame.evaluate(() => {
    const box = (id: string) => {
      const rect = document.getElementById(id)!.getBoundingClientRect()
      return {
        id,
        left: rect.left,
        right: rect.right,
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
        document.getElementById('pdf-toolbar')!.getBoundingClientRect().height,
      ),
      // Every control of the row, in owner order.
      controls: [
        'pages',
        'previous',
        'page-number',
        'next',
        'fit',
        'search-toggle',
        'download',
      ]
        .filter(
          (id) => document.getElementById(id)!.getClientRects().length > 0,
        )
        .map(box),
      pageCountRight: document
        .getElementById('page-count')!
        .getBoundingClientRect().right,
      documentScrollWidth: document.documentElement.scrollWidth,
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

// Observe the same commit/layout boundary used by in-browser tests, then
// observe completion of finite menu/sheet transitions.
async function settle(frame: Frame) {
  await frame.evaluate(waitForBrowserLayout)
  await frame.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.playState !== 'running' ||
            animation.effect?.getComputedTiming().iterations === Infinity,
        ),
    undefined,
    { timeout: 5000 },
  )
}

async function goToPage(frame: Frame, page: number) {
  await frame.fill('#page-number', String(page))
  await frame.press('#page-number', 'Enter')
  return waitForPage(frame, page)
}

function focusedId(frame: Frame) {
  return frame.evaluate(() => document.activeElement?.id ?? null)
}

// The page list and the settings menu leave the document once closed and
// then return focus in a later task. Failure to close must reject.
async function waitForClosed(frame: Frame, selector: string) {
  await frame.waitForFunction(
    (closed) => !document.querySelector(closed),
    selector,
    {
      timeout: 5000,
    },
  )
  await settle(frame)
}

function waitForPagesClosed(frame: Frame) {
  return waitForClosed(frame, '[data-pdf-pages]')
}

// Arrow keys move focus between menu items in a later task.
async function pressInMenu(page: Page, frame: Frame, key: string) {
  await page.keyboard.press(key)
  await settle(frame)
}

async function savedBytes(
  page: Page,
  frame: Frame,
  selector: string,
  original: Uint8Array<ArrayBuffer>,
) {
  const [saved] = await Promise.all([
    page.waitForEvent('download'),
    frame.click(selector),
  ])
  return Buffer.compare(await downloadBytes(saved), Buffer.from(original)) === 0
}

// Read through a stream, which also works with a remote browser.
async function downloadBytes(saved: Download): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of await saved.createReadStream())
    chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

// The page list of a 100-page PDF: what is drawn before and after opening,
// while the viewer page is hidden, and every way of leaving the list.
async function pageListFlow(
  page: Page,
  frame: Frame,
  width: number,
  clearCookies: () => Promise<void>,
  originalFetches: () => number,
  original: Uint8Array<ArrayBuffer>,
) {
  const thumbnails = () =>
    frame.evaluate(() => ({
      items: document.querySelectorAll('#page-list button').length,
      drawn: [
        ...document.querySelectorAll<HTMLElement>(
          '#page-list button[data-rendered]',
        ),
      ].map((item) => Number(item.dataset.page)),
    }))
  const waitDrawn = (n: number) =>
    frame
      .waitForFunction(
        (expected) =>
          !!document.querySelector(
            `#page-list button[data-page="${expected}"][data-rendered]`,
          ),
        n,
        { timeout: 10000 },
      )
      .then(() => true)
  // A closed list has left the document and returned focus.
  const dialogState = async () => {
    await waitForPagesClosed(frame)
    return frame.evaluate(() => ({
      open: !!document.querySelector('[data-pdf-pages][data-state="open"]'),
      focusedId: document.activeElement?.id ?? null,
    }))
  }
  const beforeOpen = await thumbnails()
  await goToPage(frame, 40)
  await frame.click('#pages')
  const currentDrawn = await waitDrawn(40)
  const opened = await frame.evaluate(() => {
    const dialog = document.querySelector('[data-pdf-pages]')!
    const list = document.getElementById('page-list')!
    const current = [...list.querySelectorAll<HTMLElement>('[aria-current]')]
    const box = current[0]?.getBoundingClientRect()
    const visible = list.getBoundingClientRect()
    return {
      open: dialog.getAttribute('data-state') === 'open',
      // The controls outside the open list are hidden from assistive
      // technology (live status regions stay announced).
      modal:
        dialog.getAttribute('role') === 'dialog' &&
        !!document
          .getElementById('pdf-toolbar')!
          .closest('[aria-hidden="true"]'),
      heading: dialog.querySelector('[data-slot="sheet-title"]')!.textContent,
      current: current.map((item) => ({
        page: Number(item.dataset.page),
        marker: item.getAttribute('aria-current'),
        label: item.getAttribute('aria-label'),
      })),
      focusedPage: (document.activeElement as HTMLElement).dataset.page ?? null,
      currentVisible:
        !!box && box.top >= visible.top && box.bottom <= visible.bottom,
      thumbnailWidth: list.querySelector<HTMLCanvasElement>(
        'button[data-page="40"] canvas',
      )!.width,
    }
  })
  // Keys that turn pages leave the page alone behind the open list.
  await page.keyboard.press('ArrowRight')
  const pageAfterArrowRight = await pageNumber(frame)
  await page.keyboard.press('ArrowLeft')
  const pageAfterArrowLeft = await pageNumber(frame)
  const setHidden = (hidden: boolean) =>
    frame.evaluate((hide) => {
      if (hide)
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        })
      else delete (document as { visibilityState?: string }).visibilityState
      document.dispatchEvent(new Event('visibilitychange'))
    }, hidden)
  // A slow neighbour of page 40 is being drawn: its canvas has its
  // thumbnail size but is not drawn yet.
  const slowHandle = await frame.waitForFunction(
    (pages) =>
      pages.find((n) => {
        const item = document.querySelector<HTMLElement>(
          `#page-list button[data-page="${n}"]`,
        )!
        return (
          item.querySelector('canvas')!.width === 240 && !item.dataset.rendered
        )
      }) ?? false,
    SLOW_PAGES,
    { timeout: 10000 },
  )
  const slowPage = (await slowHandle.jsonValue()) as number
  // Hidden, the drawing is cancelled: it stays undrawn for longer than
  // drawing it takes once visible again.
  await setHidden(true)
  const hiddenWaitMs = 3000
  // test-wait: elapsed-time — hidden rendering must stay cancelled longer than visible rendering.
  await frame.waitForTimeout(hiddenWaitMs)
  const slowWhileHidden = (await thumbnails()).drawn.includes(slowPage)
  const resumeStart = Date.now()
  await setHidden(false)
  const slowResumed = await waitDrawn(slowPage)
  const resumeMs = Date.now() - resumeStart
  await waitDrawn(SLOW_PAGES.find((n) => n !== slowPage)!)
  const afterOpen = await thumbnails()
  // While the viewer page is hidden, newly visible items stay undrawn.
  await setHidden(true)
  await frame.evaluate(() => {
    document.getElementById('page-list')!.scrollTop = 0
  })
  // test-wait: elapsed-time — observe absence of delayed background work.
  await frame.waitForTimeout(1000)
  const whileHidden = await thumbnails()
  await setHidden(false)
  const resumed = await waitDrawn(1)
  await frame.evaluate(() => {
    const list = document.getElementById('page-list')!
    list.scrollTop = list.scrollHeight
  })
  const lastDrawn = await waitDrawn(100)
  await page.keyboard.press('Escape')
  const afterEscape = await dialogState()
  // On phones the list covers the whole frame, so there is no outside.
  let afterBackdrop = null
  if (width >= 780) {
    await frame.click('#pages')
    // The list listens for outside clicks once it has opened.
    await frame.waitForFunction(
      () =>
        !!document.activeElement?.closest(
          '[data-pdf-pages][data-state="open"]',
        ),
      undefined,
      { timeout: 5000 },
    )
    await settle(frame)
    await page.mouse.click(40, 400)
    afterBackdrop = await dialogState()
  }
  await frame.click('#pages')
  await frame.click('#pages-close')
  const afterCloseButton = await dialogState()
  await frame.click('#pages')
  await frame.click('#page-list button[data-page="5"]')
  const chosenPage = await waitForPage(frame, 5)
  const chosenState = await dialogState()
  // The list marks the chosen page when it opens again.
  await frame.click('#pages')
  const chosen = {
    page: chosenPage,
    ...chosenState,
    marked: await frame.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#page-list [aria-current]')]
        .map((item) => Number(item.dataset.page))
        .join(),
    ),
  }
  await clearCookies()
  const fetchesBefore = originalFetches()
  const download = {
    sameBytes: await savedBytes(page, frame, '#pages-download', original),
    fetchedOriginal: originalFetches() > fetchesBefore,
  }
  return {
    beforeOpen,
    opened,
    currentDrawn,
    afterOpen,
    pageAfterArrowRight,
    pageAfterArrowLeft,
    slowPage,
    slowWhileHidden,
    slowResumed,
    resumeMs,
    hiddenWaitMs,
    whileHidden,
    resumed,
    lastDrawn,
    afterEscape,
    afterBackdrop,
    afterCloseButton,
    chosen,
    download,
  }
}

function searchState(frame: Frame) {
  return frame.evaluate(() => ({
    open: !document.getElementById('search-bar')!.hidden,
    expanded: document
      .getElementById('search-toggle')!
      .getAttribute('aria-expanded'),
    focusedId: document.activeElement?.id ?? null,
    results: document.getElementById('search-results')!.textContent,
    query: (document.getElementById('search-query') as HTMLInputElement).value,
    inputWidth: document.getElementById('search-query')!.getBoundingClientRect()
      .width,
    barOverflow:
      document.getElementById('search-bar')!.scrollWidth -
      document.getElementById('search-bar')!.clientWidth,
    highlights: document.querySelectorAll('.textLayer .highlight').length,
    page: Number(
      (document.getElementById('page-number') as HTMLInputElement).value,
    ),
    containerHeight: document.getElementById('viewer-container')!.clientHeight,
  }))
}

async function waitForResults(frame: Frame, pattern: string) {
  await frame.waitForFunction(
    (source) =>
      new RegExp(source).test(
        document.getElementById('search-results')!.textContent ?? '',
      ),
    pattern,
    { timeout: 10000 },
  )
  return searchState(frame)
}

// Search across pages: both ways in, stepping both ways, no results, an
// emptied query, and both ways out.
async function searchFlow(page: Page, frame: Frame) {
  const closed = await searchState(frame)
  await frame.focus('#viewer-container')
  await page.keyboard.press('ControlOrMeta+f')
  const openedByShortcut = await searchState(frame)
  await page.keyboard.type(SEARCH_TERM)
  const first = await waitForResults(frame, '^1 ')
  await frame.waitForSelector('.textLayer .highlight.selected', {
    timeout: 10000,
  })
  const highlighted = await searchState(frame)
  await page.keyboard.press('Enter')
  const second = await waitForResults(frame, '^2 ')
  await page.keyboard.press('Enter')
  const third = await waitForResults(frame, '^3 ')
  await page.keyboard.press('Shift+Enter')
  const back = await waitForResults(frame, '^2 ')
  await frame.click('#search-next')
  const nextButton = await waitForResults(frame, '^3 ')
  await frame.click('#search-previous')
  const previousButton = await waitForResults(frame, '^2 ')
  await frame.fill('#search-query', 'zebra')
  const absent = await waitForResults(frame, '^[^0-9]+$')
  await frame.fill('#search-query', '')
  const emptied = await waitForResults(frame, '^$')
  // Emptied while the search it started is still running: no late counts.
  await frame.fill('#search-query', SEARCH_TERM)
  // test-wait: elapsed-time — cross the search debounce before clearing the pending query.
  await frame.waitForTimeout(300)
  await frame.fill('#search-query', '')
  // test-wait: elapsed-time — observe absence of delayed background work.
  await frame.waitForTimeout(1000)
  const emptiedWhileSearching = await searchState(frame)
  await frame.fill('#search-query', SEARCH_TERM)
  // A fresh search starts from the current page, which is still page 4.
  const resumed = await waitForResults(frame, '^2 ')
  await page.keyboard.press('Escape')
  await frame.waitForFunction(
    () => document.querySelectorAll('.textLayer .highlight').length === 0,
    undefined,
    { timeout: 5000 },
  )
  const closedByEscape = await searchState(frame)
  await frame.click('#search-toggle')
  const reopened = await searchState(frame)
  await frame.click('#search-close')
  const closedByButton = await searchState(frame)
  return {
    closed,
    openedByShortcut,
    first,
    highlighted,
    second,
    third,
    back,
    nextButton,
    previousButton,
    absent,
    emptied,
    emptiedWhileSearching,
    resumed,
    closedByEscape,
    reopened,
    closedByButton,
  }
}

async function searchOnce(frame: Frame) {
  await frame.click('#search-toggle')
  await frame.fill('#search-query', SEARCH_TERM)
  return waitForResults(frame, '.')
}

// The display settings menu: its options carry data-layout and data-size,
// and the viewer keeps the current choice on the body.
const SETTINGS = '[data-pdf-settings]'

function chooseSetting(frame: Frame, option: string) {
  return frame.click(`${SETTINGS} ${option}`)
}

function settingsState(frame: Frame) {
  return frame.evaluate((settings) => {
    const options = document.querySelector(settings)
    const container = document.getElementById('viewer-container')!
    const current = document.querySelector<HTMLElement>(
      `.page[data-page-number="${(document.getElementById('page-number') as HTMLInputElement).value}"]`,
    )!
    const box = options?.getBoundingClientRect() ?? { left: 0, right: 0 }
    return {
      open: options?.getAttribute('data-state') === 'open',
      expanded: document.getElementById('fit')!.getAttribute('aria-expanded'),
      layout: document.body.dataset.mode ?? null,
      size: document.body.dataset.size ?? null,
      mode: document.body.dataset.mode,
      page: Number(
        (document.getElementById('page-number') as HTMLInputElement).value,
      ),
      focusedId: document.activeElement?.id ?? null,
      focusInSettings: !!options?.contains(document.activeElement),
      focusedCheckedLayout:
        document.activeElement?.matches(
          `${settings} [data-layout][aria-checked="true"]`,
        ) ?? false,
      focusedSize:
        (document.activeElement as HTMLElement | null)?.dataset.size ?? null,
      popover: { left: box.left, right: box.right },
      frameWidth: innerWidth,
      pageWidth: current.offsetWidth,
      pageHeight: current.offsetHeight,
      container: {
        width: container.clientWidth,
        height: container.clientHeight,
      },
      horizontalOverflow: container.scrollWidth - container.clientWidth,
      dialogOpen: !!document.querySelector(
        '[data-pdf-pages][data-state="open"]',
      ),
      searchOpen: !document.getElementById('search-bar')!.hidden,
    }
  }, SETTINGS)
}

// A swipe made of touch events carrying only the coordinates the viewer reads,
// which every engine can dispatch.
async function swipeLeft(frame: Frame, turns: boolean) {
  const before = await pageNumber(frame)
  await frame.evaluate(() => {
    const container = document.getElementById('viewer-container')!
    const fire = (type: string, key: string, x: number) => {
      const event = new Event(type)
      Object.defineProperty(event, key, {
        value: [{ clientX: x, clientY: 300 }],
      })
      container.dispatchEvent(event)
    }
    fire('touchstart', 'touches', 300)
    fire('touchend', 'changedTouches', 100)
  })
  if (turns) await waitForPage(frame, before + 1)
  else {
    // test-wait: elapsed-time — a swipe in scroll mode must not turn a page later.
    await frame.waitForTimeout(500)
  }
  return pageNumber(frame)
}

// Display settings on a 4-page slide deck, starting from page 3.
async function settingsFlow(
  page: Page,
  frame: Frame,
  width: number,
  height: number,
) {
  await goToPage(frame, 3)
  const initial = await settingsState(frame)
  await frame.click('#fit')
  const opened = await settingsState(frame)
  await chooseSetting(frame, '[data-layout="scroll"]')
  await settle(frame)
  const scrollLayout = await settingsState(frame)
  const sizes: Record<string, Awaited<ReturnType<typeof settingsState>>> = {}
  for (const size of ['auto', 'page-fit', 'page-width', '1', '1.5', '2']) {
    await chooseSetting(frame, `[data-size="${size}"]`)
    await settle(frame)
    sizes[size] = await settingsState(frame)
  }
  await chooseSetting(frame, '[data-layout="page"]')
  await settle(frame)
  const pageLayout = await settingsState(frame)
  const expectedPageWidth = await frame
    .locator('.page[data-page-number="3"]')
    .evaluate((element) => (element as HTMLElement).offsetWidth)
  await page.setViewportSize({
    width: Math.round(width * 0.8),
    height: Math.round(height * 0.8),
  })
  // ResizeObserver-driven refit and popover positioning can follow layout.
  await frame.waitForFunction(
    ({ expectedWidth, expectedPageWidth: pageWidth }) => {
      const current = document.querySelector<HTMLElement>(
        '.page[data-page-number="3"]',
      )
      const popover = document
        .querySelector('[data-pdf-settings][data-state="open"]')
        ?.getBoundingClientRect()
      return (
        innerWidth === expectedWidth &&
        !!current &&
        Math.abs(current.offsetWidth - pageWidth) <= 1 &&
        !!popover &&
        popover.left >= 0 &&
        popover.right <= innerWidth
      )
    },
    { expectedWidth: Math.round(width * 0.8), expectedPageWidth },
    { timeout: 5000 },
  )
  const afterResize = await settingsState(frame)
  await page.setViewportSize({ width, height })
  await frame.click('#next')
  await waitForPage(frame, 4)
  await settle(frame)
  const afterNext = await settingsState(frame)

  await frame.click('#fit')
  await page.keyboard.press('Escape')
  await waitForClosed(frame, SETTINGS)
  const afterEscape = await settingsState(frame)
  // Keyboard only: open, move to the other layout and choose it, move on to
  // the sizes.
  await frame.focus('#fit')
  await pressInMenu(page, frame, 'Enter')
  const keyboardOpened = await settingsState(frame)
  await pressInMenu(page, frame, 'ArrowDown')
  await pressInMenu(page, frame, 'Enter')
  const keyboardLayout = await settingsState(frame)
  await pressInMenu(page, frame, 'ArrowDown')
  const keyboardToSize = (await settingsState(frame)).focusedSize
  await page.keyboard.press('Escape')
  await waitForClosed(frame, SETTINGS)
  const keyboardEscape = await settingsState(frame)
  await frame.click('#fit')
  await frame.click('#viewer-container', { position: { x: 10, y: 10 } })
  const afterOutsideClick = await settingsState(frame)

  // Opening one surface closes the one it would overlap.
  await frame.click('#fit')
  await frame.click('#search-toggle')
  const settingsToSearch = await settingsState(frame)
  // Ctrl/Cmd+F from the open settings moves focus to the search field and
  // keeps it there after the menu closes.
  await page.keyboard.press('Escape')
  await frame.click('#fit')
  await page.keyboard.press('ControlOrMeta+f')
  await waitForClosed(frame, SETTINGS)
  const shortcutToSearch = await settingsState(frame)
  await frame.click('#fit')
  const searchToSettings = await settingsState(frame)
  await frame.click('#pages')
  const settingsToPages = await settingsState(frame)
  await page.keyboard.press('Escape')
  await frame.click('#search-toggle')
  await frame.click('#pages')
  const searchToPages = await settingsState(frame)
  await page.keyboard.press('Escape')
  await waitForPagesClosed(frame)
  const pagesClosed = await settingsState(frame)

  // Swipes turn pages only one page at a time while the page fits the width.
  await frame.click('#fit')
  await chooseSetting(frame, '[data-layout="page"]')
  await chooseSetting(frame, '[data-size="page-fit"]')
  await page.keyboard.press('Escape')
  await goToPage(frame, 2)
  await settle(frame)
  const fittedSwipe = await swipeLeft(frame, true)
  await frame.click('#fit')
  await chooseSetting(frame, '[data-size="2"]')
  await page.keyboard.press('Escape')
  const zoomed = await settingsState(frame)
  const zoomedSwipe = await swipeLeft(frame, false)
  await frame.click('#fit')
  await chooseSetting(frame, '[data-size="page-fit"]')
  await chooseSetting(frame, '[data-layout="scroll"]')
  await page.keyboard.press('Escape')
  await settle(frame)
  const continuousSwipe = await swipeLeft(frame, false)
  return {
    initial,
    opened,
    scrollLayout,
    sizes,
    pageLayout,
    afterResize,
    afterNext,
    afterEscape,
    keyboardOpened,
    keyboardLayout,
    keyboardToSize,
    keyboardEscape,
    afterOutsideClick,
    settingsToSearch,
    shortcutToSearch,
    searchToSettings,
    settingsToPages,
    searchToPages,
    pagesClosed,
    fittedSwipe,
    zoomed,
    zoomedSwipe,
    continuousSwipe,
  }
}

// While the page's flag is set, drawing a page fails: pdf.js starts every
// page by filling its background.
function breakPageDrawing() {
  const fillRect = CanvasRenderingContext2D.prototype.fillRect
  CanvasRenderingContext2D.prototype.fillRect = function (...args) {
    if ((window as unknown as { breakPageDrawing?: boolean }).breakPageDrawing)
      throw new Error('Synthetic page drawing failure')
    return fillRect.apply(this, args)
  }
}

function statusState(frame: Frame) {
  return frame.evaluate(() => ({
    state: document.documentElement.dataset.pdfState,
    message: document.getElementById('status-message')!.textContent,
    downloadOffered: !document.getElementById('status-download')!.hidden,
    page: Number(
      (document.getElementById('page-number') as HTMLInputElement).value,
    ),
  }))
}

// A page that cannot be drawn says so while it is the current page, with
// the original download; moving to a page that drew clears it.
async function pageFailureFlow(frame: Frame) {
  await frame.evaluate(() => {
    ;(window as unknown as { breakPageDrawing: boolean }).breakPageDrawing =
      true
  })
  await goToPage(frame, 4)
  await frame.waitForFunction(
    () => document.documentElement.dataset.pdfState === 'page-error',
    undefined,
    { timeout: 10000 },
  )
  const failed = await statusState(frame)
  await frame.evaluate(() => {
    ;(window as unknown as { breakPageDrawing: boolean }).breakPageDrawing =
      false
  })
  await goToPage(frame, 1)
  await frame.waitForFunction(
    () => document.documentElement.dataset.pdfState === 'ready',
    undefined,
    { timeout: 10000 },
  )
  const recovered = {
    ...(await statusState(frame)),
    statusHidden: await frame.evaluate(
      () => document.getElementById('status')!.hidden,
    ),
  }
  return { failed, recovered }
}

// A stand-in for the app page: it frames the viewer with the app's sandbox
// permissions and sends the app's display preferences in the app's message
// whenever a viewer document loads, and when they change.
// The video viewer's browser fixture frames its player the same way.
export const PARENT_PATH = '/__pdf_test_parent'
export function parentDocument(entry: string, message: object | null) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style></head>
<body><script>
let message = ${JSON.stringify(message)}
let frame = null
const send = () => { if (message && frame) frame.contentWindow.postMessage(message, '*') }
function mount(src, name) {
  const next = document.createElement('iframe')
  next.name = name
  next.sandbox = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads'
  next.src = src
  next.addEventListener('load', () => { if (next === frame) send() })
  frame?.remove()
  frame = next
  document.body.append(next)
}
window.reports = []
addEventListener('message', (event) => {
  if (frame && event.source === frame.contentWindow && event.data && event.data.kind === 'pdf-page-changed') reports.push(event.data)
})
window.sendPreferences = (next) => { message = next; send() }
window.postToViewer = (data) => frame.contentWindow.postMessage(data, '*')
window.syncPage = (token) => frame.contentWindow.postMessage({ source: 'artifactshare-parent', kind: 'pdf-page-sync', token }, '*')
window.replaceViewer = mount
mount(${JSON.stringify(entry)}, 'viewer-1')
</script></body></html>`
}

export type ParentWindow = Window & {
  sendPreferences(message: object): void
  postToViewer(data: unknown): void
  syncPage(token: string): void
  replaceViewer(src: string, name: string): void
}

async function viewerFrame(page: Page, name: string) {
  const element = await page.waitForSelector(`iframe[name="${name}"]`)
  const frame = (await element.contentFrame())!
  await frame.waitForURL(/\/Synthetic\.pdf/, { timeout: 15000 })
  await frame.waitForFunction(
    () => !!document.getElementById('pdf-viewer-root'),
    undefined,
    { timeout: 15000 },
  )
  return frame
}

function viewerLabels() {
  const label = (id: string) =>
    document.getElementById(id)?.getAttribute('aria-label') ?? null
  return {
    lang: document.documentElement.lang,
    toolbar: label('pdf-toolbar'),
    pages: label('pages'),
    content: label('viewer-container'),
    contentLang:
      document.getElementById('viewer-container')?.getAttribute('lang') ?? null,
  }
}

function preferencesState(frame: Frame) {
  return frame.evaluate(() => {
    const toolbar = document.getElementById('pdf-toolbar')!
    return {
      lang: document.documentElement.lang,
      theme: document.documentElement.dataset.theme ?? null,
      toolbar: toolbar.getAttribute('aria-label'),
      background: getComputedStyle(toolbar).backgroundColor,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      contentLang: document
        .getElementById('viewer-container')!
        .getAttribute('lang'),
      page: Number(
        (document.getElementById('page-number') as HTMLInputElement).value,
      ),
      layout: document.body.dataset.mode ?? null,
      size: document.body.dataset.size ?? null,
      // Set on the PDF page area below: still there means the same pdf.js
      // instance kept rendering the same document.
      sameDocument:
        (document.getElementById('viewer') as HTMLElement & { probe?: true })
          .probe === true,
      renderedPages: document.querySelectorAll('.page canvas').length,
    }
  })
}

// The viewer starts on the app defaults, takes the app's preferences late
// and as they change without reloading its PDF, ignores malformed ones and
// any not sent by its parent, and a replacement frame gets the current ones.
async function preferencesFlow(
  page: Page,
  frame: Frame,
  signEntry: () => Promise<string>,
) {
  const send = async (preferences: ViewerPreferences, expected: string) => {
    await page.evaluate(
      (message) => (window as unknown as ParentWindow).sendPreferences(message),
      viewerPreferencesMessage(preferences),
    )
    await frame.waitForFunction(
      (wanted) =>
        `${document.documentElement.lang} ${document.documentElement.dataset.theme}` ===
        wanted,
      expected,
      { timeout: 5000 },
    )
    await settle(frame)
    return preferencesState(frame)
  }
  await goToPage(frame, 3)
  await settle(frame)
  await frame.evaluate(() => {
    ;(
      document.getElementById('viewer') as HTMLElement & { probe?: true }
    ).probe = true
  })
  const initial = await preferencesState(frame)
  // The browser prefers dark; the app chose light.
  const late = await send({ locale: 'ja', theme: 'light' }, 'ja light')
  await page.emulateMedia({ colorScheme: 'light' })
  const dark = await send({ locale: 'en', theme: 'dark' }, 'en dark')
  const system = await send({ locale: 'en', theme: 'system' }, 'en system')
  await page.emulateMedia({ colorScheme: 'dark' })
  await settle(frame)
  const systemChanged = await preferencesState(frame)
  await page.evaluate(() => {
    const parent = window as unknown as ParentWindow
    for (const invalid of [
      { locale: 'fr', theme: 'dark' },
      { locale: 'ja', theme: 'sepia' },
      { locale: 'ja' },
    ])
      parent.postToViewer({
        source: 'artifactshare-parent',
        kind: 'viewer-preferences',
        ...invalid,
      })
  })
  // Well formed, but from the viewer's own window instead of its parent.
  await frame.evaluate(
    (message) => window.postMessage(message, '*'),
    viewerPreferencesMessage({ locale: 'ja', theme: 'light' }),
  )
  // test-wait: elapsed-time — malformed and non-parent messages must remain ignored.
  await frame.waitForTimeout(500)
  const ignored = await preferencesState(frame)
  const beforeReplacement = await send(
    { locale: 'ja', theme: 'dark' },
    'ja dark',
  )
  const next = new URL(await signEntry())
  await page.evaluate(
    (src) => (window as unknown as ParentWindow).replaceViewer(src, 'viewer-2'),
    `${next.pathname}${next.search}`,
  )
  const replacement = await viewerFrame(page, 'viewer-2')
  await replacement.waitForFunction(
    () => document.documentElement.dataset.pdfState === 'ready',
    undefined,
    { timeout: 20000 },
  )
  await replacement.waitForFunction(
    () => document.documentElement.lang === 'ja',
    undefined,
    {
      timeout: 5000,
    },
  )
  const replaced = await preferencesState(replacement)
  return {
    frame: replacement,
    result: {
      initial,
      late,
      dark,
      system,
      systemChanged,
      ignored,
      beforeReplacement,
      replaced,
    },
  }
}

type PageReport = {
  token?: string
  state: string
  pageNumber?: number
  pageCount?: number
}

// The page the viewer reports to its parent through every way of moving, the
// pages its parent opens, the commands it ignores, a page that cannot be
// drawn and a reload. The parent page records every report of its frame.
async function pageBridgeFlow(page: Page, frame: Frame, width: number) {
  const reports = () =>
    page.evaluate(() =>
      (window as unknown as { reports: PageReport[] }).reports.map(
        (report) => ({
          token: report.token,
          state: report.state,
          pageNumber: report.pageNumber,
          pageCount: report.pageCount,
        }),
      ),
    )
  const waitReport = async (state: string, expectedPage?: number) => {
    await page.waitForFunction(
      ([wantedState, wantedPage]) => {
        const last = (
          window as unknown as { reports: PageReport[] }
        ).reports.at(-1)
        return last?.state === wantedState && last.pageNumber === wantedPage
      },
      [state, expectedPage] as const,
      { timeout: 10000 },
    )
    return (await reports()).at(-1)
  }
  const command = (data: unknown) =>
    page.evaluate(
      (message) => (window as unknown as ParentWindow).postToViewer(message),
      data,
    )
  // Messages reach the frame in order: once one the frame posts to itself
  // has arrived, every earlier command has been handled.
  const flush = () =>
    frame.evaluate(
      () =>
        new Promise<void>((resolve) => {
          addEventListener('message', function done(event) {
            if (event.data !== 'flush') return
            removeEventListener('message', done)
            resolve()
          })
          postMessage('flush', '*')
        }),
    )
  const open = (target: unknown) => ({
    source: 'artifactshare-parent',
    kind: 'pdf-open-page',
    pageNumber: target,
  })

  const sync = (token: string) =>
    page.evaluate(
      (value) => (window as unknown as ParentWindow).syncPage(value),
      token,
    )
  // Nothing is reported until the parent gives the document its token.
  await flush()
  const beforeSync = (await reports()).length
  await sync('a'.repeat(64))
  const initial = await waitReport('ready', 1)
  const mode = await frame.evaluate(() => document.body.dataset.mode)
  await frame.click('#next')
  const afterButton = await waitReport('ready', 2)
  await frame.focus('#viewer-container')
  await page.keyboard.press('End')
  const afterKey = await waitReport('ready', 14)
  await searchOnce(frame)
  const afterSearch = await waitReport('ready', 9)
  await frame.click('#search-close')
  let afterScroll: PageReport | undefined
  if (mode === 'scroll') {
    await frame.evaluate(() => {
      const target = document.querySelector<HTMLElement>(
        '.page[data-page-number="3"]',
      )!
      document.getElementById('viewer-container')!.scrollTop = target.offsetTop
    })
    afterScroll = await waitReport('ready', 3)
  }

  await command(open(12))
  const opened = {
    page: await waitForPage(frame, 12),
    report: await waitReport('ready', 12),
  }
  const beforeIgnored = (await reports()).length
  for (const ignored of [open(15), open(2.5), open('3'), open(0)])
    await command(ignored)
  // Well formed, but from the viewer's own window instead of its parent.
  await frame.evaluate((message) => window.postMessage(message, '*'), open(3))
  await flush()
  const ignored = {
    page: await pageNumber(frame),
    reports: (await reports()).slice(beforeIgnored),
  }

  // A page that cannot be drawn makes the page unavailable; a command then
  // does nothing, and drawing it again reports the same page.
  await frame.evaluate(() => {
    ;(window as unknown as { breakPageDrawing: boolean }).breakPageDrawing =
      true
  })
  await command(open(6))
  const failed = await waitReport('unavailable')
  await command(open(1))
  await flush()
  const whileFailed = await pageNumber(frame)
  await frame.evaluate(() => {
    ;(window as unknown as { breakPageDrawing: boolean }).breakPageDrawing =
      false
  })
  // A narrower frame draws the current page again at its new size.
  await page.setViewportSize({ width: width - 40, height: 800 })
  const recovered = await waitReport('ready', 6)

  const beforeReload = (await reports()).length
  // The mark lives on the reloaded document's window only, so the wait below
  // ends in the new document, never in the one still unloading.
  await frame.evaluate(() => {
    ;(window as unknown as { beforeReload: boolean }).beforeReload = true
    location.reload()
  })
  await frame.waitForFunction(
    () =>
      !(window as unknown as { beforeReload?: boolean }).beforeReload &&
      document.documentElement.dataset.pdfState === 'ready',
    undefined,
    { timeout: 20000 },
  )
  // The reloaded document reports only under the token it is given.
  await flush()
  const reloadedBeforeSync = (await reports()).slice(beforeReload)
  await sync('b'.repeat(64))
  await waitReport('ready', 1)
  const reloaded = (await reports()).slice(beforeReload)
  return {
    layout: mode,
    beforeSync,
    reloadedBeforeSync,
    initial,
    afterButton,
    afterKey,
    afterSearch,
    afterScroll,
    opened,
    ignored,
    failed,
    whileFailed,
    recovered,
    reloaded,
  }
}

// Runs the real sandbox Worker (wrangler.sandbox.jsonc, including its
// PDFJS_ASSETS binding) with a seeded link-shared PDF version. A loopback
// proxy forwards every browser request unchanged to the Worker under the
// version's sandbox hostname; it only injects the transport failure and the
// missing-library case. The viewer is then driven the way a reader does.
export const pdfViewerScenario = defineBrowserCommand(
  async (
    { page },
    scenario: PdfScenario,
    width: number,
    options: PdfScenarioOptions = {},
  ) => {
    const height = width < 780 ? 844 : 900
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
    // Framed scenarios load the viewer in a parent page the way the app
    // does; the fixture lets that page be a frame ancestor of the viewer.
    const framed = scenario === 'preferences' || options.app !== undefined
    let parentPage = ''
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', origin)
        if (framed && url.pathname === PARENT_PATH) {
          response
            .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(parentPage)
          return
        }
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
        // The viewer's own fetch of the original is slow; the download
        // link's request is not.
        if (
          scenario === 'slow-original' &&
          url.pathname === PDF_ORIGINAL_PATH &&
          !url.searchParams.has('download')
        )
          await new Promise((resolve) => setTimeout(resolve, 4000))
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
    let context: Awaited<ReturnType<typeof createContext>> | undefined
    const createContext = () =>
      page
        .context()
        .browser()!
        .newContext({
          viewport: { width, height },
          locale: options.locale ?? 'en-US',
          colorScheme: options.colorScheme ?? 'light',
          reducedMotion: 'reduce',
        })
    try {
      await harness.listen()
      await applyBrowserFixtureSchema((await sandbox.getEnv()).DB)
      const signEntry = await seedPdfArtifact(
        await sandbox.getEnv(),
        scenarioPdf(scenario),
      )
      const entry = new URL(await signEntry())
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
      if (
        scenario === 'page-failure' ||
        scenario === 'page-bridge' ||
        scenario === 'page-bridge-report'
      )
        await context.addInitScript(breakPageDrawing)
      context.on('request', (request) => requests.push(request.url()))
      const artifact = await context.newPage()
      let frame: Frame
      if (framed) {
        parentPage = parentDocument(
          `${entry.pathname}${entry.search}`,
          options.app ? viewerPreferencesMessage(options.app) : null,
        )
        await artifact.goto(`${origin}${PARENT_PATH}`, { timeout: 15000 })
        frame = await viewerFrame(artifact, 'viewer-1')
        if (!workerStatuses.includes('/Synthetic.pdf: 200'))
          throw new Error(`Sandbox entry failed: ${workerStatuses.join(', ')}`)
      } else {
        const entryResponse = await artifact.goto(
          `${origin}${entry.pathname}${entry.search}`,
          { timeout: 15000 },
        )
        if (entryResponse?.status() !== 200)
          throw new Error(`Sandbox entry failed: ${workerStatuses.join(', ')}`)
        frame = artifact.mainFrame()
      }
      const initialState = await frame.evaluate(
        () => document.documentElement.dataset.pdfState,
      )
      // The original downloads while the PDF is still loading, and the
      // viewer stays on its document.
      let earlyDownload = null
      if (scenario === 'slow-original') {
        await frame.waitForSelector('#download', { timeout: 10000 })
        await frame.evaluate(() => {
          ;(window as unknown as { stayed: boolean }).stayed = true
        })
        const clickedWhile = await frame.evaluate(
          () => document.documentElement.dataset.pdfState,
        )
        const [saved] = await Promise.all([
          artifact.waitForEvent('download'),
          frame.click('#download'),
        ])
        earlyDownload = {
          clickedWhile,
          name: saved.suggestedFilename(),
          sameBytes:
            Buffer.compare(
              await downloadBytes(saved),
              Buffer.from(scenarioPdf(scenario)),
            ) === 0,
          stayed: await frame.evaluate(
            () => (window as unknown as { stayed?: boolean }).stayed === true,
          ),
        }
      }
      await frame.waitForFunction(
        () => document.documentElement.dataset.pdfState !== 'loading',
        undefined,
        { timeout: 20000 },
      )
      // The app's language has reached the viewer before its text is read.
      if (options.app)
        await frame.waitForFunction(
          (locale) => document.documentElement.lang === locale,
          options.app.locale,
          { timeout: 5000 },
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
        settings: await frame.evaluate(() => ({
          layout: document.body.dataset.mode ?? null,
          size: document.body.dataset.size ?? null,
        })),
        labels: await frame.evaluate(viewerLabels),
        earlyDownload,
      }
      if (status.state !== 'ready') return common
      const original = scenarioPdf(scenario)
      const originalFetches = () =>
        requests.filter((url) => new URL(url).pathname === PDF_ORIGINAL_PATH)
          .length
      const finish = async <T>(result: T) => ({
        ...common,
        ...result,
        offOrigin: requests.filter(
          (url) => !url.startsWith(origin) && !url.startsWith('blob:'),
        ),
        violations: await frame.evaluate(
          () => (window as unknown as { violations: string[] }).violations,
        ),
      })

      if (scenario === 'pages') {
        const initial = await layout(frame)
        // A download that left a narrow row comes back once the row widens.
        let widened: Awaited<ReturnType<typeof layout>> | undefined
        const narrowViewport = artifact.viewportSize()
        if (width <= 360 && narrowViewport) {
          await artifact.setViewportSize({
            width: 1440,
            height: narrowViewport.height,
          })
          await frame.waitForFunction(
            () =>
              document.getElementById('download')!.getClientRects().length > 0,
            undefined,
            { timeout: 5000 },
          )
          widened = await layout(frame)
          await artifact.setViewportSize(narrowViewport)
        }
        // Toolbar checks still use the 100-page fixture and exercise resizing,
        // but do not need the separate page-list interaction walk.
        if (options.pageListInteractions === false)
          return await finish({ initial, widened })
        const pageList = await pageListFlow(
          artifact,
          frame,
          width,
          () => context!.clearCookies(),
          originalFetches,
          original,
        )
        return await finish({ initial, widened, pageList })
      }
      if (scenario === 'page-failure')
        return await finish({ pageFailure: await pageFailureFlow(frame) })
      if (scenario === 'page-bridge' || scenario === 'page-bridge-report')
        return await finish({
          pageBridge: await pageBridgeFlow(artifact, frame, width),
        })
      if (scenario === 'preferences') {
        const flow = await preferencesFlow(artifact, frame, signEntry)
        return {
          ...common,
          preferences: flow.result,
          offOrigin: requests.filter(
            (url) => !url.startsWith(origin) && !url.startsWith('blob:'),
          ),
          violations: await flow.frame.evaluate(
            () => (window as unknown as { violations: string[] }).violations,
          ),
        }
      }
      if (scenario === 'search')
        return await finish({ search: await searchFlow(artifact, frame) })
      if (scenario === 'image-only' || scenario === 'late-text')
        return await finish({ searchOnce: await searchOnce(frame) })
      if (scenario === 'settings')
        return await finish({
          settingsFlow: await settingsFlow(artifact, frame, width, height),
        })

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
        await frame.waitForFunction(
          (slide) => {
            const container = document.getElementById('viewer-container')!
            const current = document.querySelector<HTMLElement>(
              '.page[data-page-number="2"]',
            )!
            if (slide)
              return (
                current.offsetHeight <= container.clientHeight &&
                current.offsetWidth <= container.clientWidth &&
                container.scrollHeight === container.clientHeight
              )
            return [...document.querySelectorAll<HTMLElement>('.page')].every(
              (pageElement) => pageElement.offsetWidth <= container.clientWidth,
            )
          },
          scenario === 'mixed-slides',
          { timeout: 5000 },
        )
        await settle(frame)
        const mixed = await layout(frame)
        const mixedMode = await frame.evaluate(() => document.body.dataset.mode)
        // Fit page in continuous layout refits each page reached.
        let continuousFit = null
        if (scenario === 'mixed-slides') {
          await frame.click('#fit')
          await chooseSetting(frame, '[data-layout="scroll"]')
          await artifact.keyboard.press('Escape')
          await goToPage(frame, 1)
          await settle(frame)
          await goToPage(frame, 2)
          await settle(frame)
          continuousFit = await layout(frame)
        }
        return {
          continuousFit,
          ...common,
          mode: mixedMode,
          mixedPage,
          mixed,
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
      const fetchesBeforeDownload = originalFetches()
      const [saved] = await Promise.all([
        artifact.waitForEvent('download'),
        frame.click('#download'),
      ])
      const download = {
        name: saved.suggestedFilename(),
        sameBytes:
          Buffer.compare(
            await downloadBytes(saved),
            Buffer.from(scenarioPdf(scenario)),
          ) === 0,
        fetchedOriginal: originalFetches() > fetchesBeforeDownload,
      }
      // A page kept for back/forward navigation keeps its document.
      await frame.evaluate(() =>
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
      )
      const [savedAfterHide] = await Promise.all([
        artifact.waitForEvent('download'),
        frame.click('#download'),
      ])
      const afterBackForward = {
        renderedPages: await frame.evaluate(
          () => document.querySelectorAll('.page canvas').length,
        ),
        sameBytes:
          Buffer.compare(
            await downloadBytes(savedAfterHide),
            Buffer.from(scenarioPdf(scenario)),
          ) === 0,
      }
      const beforeResize = await pageNumber(frame)
      await artifact.setViewportSize({
        width: Math.round(width * 0.8),
        height: Math.round(height * 0.8),
      })
      await frame.waitForFunction(
        ({ expectedWidth, expectedHeight, expectedPage, fitPage }) => {
          const container = document.getElementById('viewer-container')!
          const current = document.querySelector<HTMLElement>(
            `.page[data-page-number="${expectedPage}"]`,
          )
          return (
            innerWidth === expectedWidth &&
            innerHeight === expectedHeight &&
            !!current &&
            current.offsetWidth <= container.clientWidth &&
            (!fitPage ||
              (current.offsetHeight <= container.clientHeight &&
                container.scrollHeight === container.clientHeight))
          )
        },
        {
          expectedWidth: Math.round(width * 0.8),
          expectedHeight: Math.round(height * 0.8),
          expectedPage: beforeResize,
          fitPage: mode === 'page',
        },
        { timeout: 5000 },
      )
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
        afterBackForward,
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

type Box = {
  id: string
  left: number
  right: number
  top: number
  width: number
  height: number
}
type Edges = { left: number; right: number; top: number; bottom: number }
type Layout = {
  frameWidth: number
  download: Edges
  verticalOverflow: number
  scrollTop: number
  pagerCenter: number
  toolbarHeight: number
  controls: Box[]
  pageCountRight: number
  documentScrollWidth: number
  previousDisabled: boolean
  nextDisabled: boolean
  container: { width: number; height: number }
  page: { width: number; height: number }
}

export type PdfScenarioOptions = {
  // Only the pages scenario: omit the interaction walk for toolbar checks.
  pageListInteractions?: boolean
  // The browser's own language and color scheme.
  locale?: 'en-US' | 'ja-JP'
  colorScheme?: 'light' | 'dark'
  // The app's display preferences, sent by a parent page that frames the
  // viewer the way the app does. Without them the viewer opens unframed.
  app?: ViewerPreferences
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    pdfViewerScenario: (
      scenario: PdfScenario,
      width: number,
      options?: PdfScenarioOptions,
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
      settings: { layout: string | null; size: string | null }
      labels: ReturnType<typeof viewerLabels>
      preferences?: Awaited<ReturnType<typeof preferencesFlow>>['result']
      pageList?: Awaited<ReturnType<typeof pageListFlow>>
      search?: Awaited<ReturnType<typeof searchFlow>>
      searchOnce?: Awaited<ReturnType<typeof searchState>>
      settingsFlow?: Awaited<ReturnType<typeof settingsFlow>>
      embeddedFont?: {
        inkDensity: number
        ink: Edges
        span: Edges
      }
      mixedPage?: number
      mixed?: Layout
      continuousFit?: Layout | null
      widestPage?: number
      mode?: string
      pageCount?: string | null
      scale?: number
      selection?: string
      initial?: Layout
      widened?: Layout
      atStart?: Layout
      atEnd?: Layout
      navigation?: Record<string, number>
      scrolledPage?: number | null
      beforeResize?: number
      afterResize?: Layout & { pageNumber: number }
      download?: { name: string; sameBytes: boolean; fetchedOriginal: boolean }
      earlyDownload: {
        clickedWhile: string | undefined
        name: string
        sameBytes: boolean
        stayed: boolean
      } | null
      pageFailure?: Awaited<ReturnType<typeof pageFailureFlow>>
      pageBridge?: Awaited<ReturnType<typeof pageBridgeFlow>>
      afterBackForward?: { renderedPages: number; sameBytes: boolean }
    }>
  }
}
