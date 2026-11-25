#!/usr/bin/env node
// Journey: the viewer's two bottom notices on a phone. An artifact whose
// external resources the sandbox blocks shows the security banner; with the
// comment sheet open and the clipboard denied, the recovery toast still reads
// above both, and it drops back to the bottom once the sheet closes. A Japanese
// browser sees the Japanese close button.
//
//   node .claude/skills/verify-artifactshare/scripts/journeys/viewer-notices.mjs [--run <id>]
//
// Evidence: .verify-artifactshare/runs/<id>/evidence/viewer-notices/
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  actUntil,
  capture,
  countedLabel,
  createApiToken,
  evidenceDir,
  openRun,
  runCli,
  signIn,
  stableBox,
  uiText,
} from '../harness.mjs'

const FEATURE = 'viewer-notices'
const runIndex = process.argv.indexOf('--run')
const run = openRun(runIndex > 0 ? process.argv[runIndex + 1] : undefined)
const stamp = Date.now()
const title = `Verify notices ${stamp}`
const body = `Notices comment ${stamp}`
const steps = []
const step = (name, detail) => {
  steps.push({ name, ...detail })
  console.log(`ok ${name}`)
}

// Enough blocked resources for the banner to reach its full height, so the
// toast and the banner really do share the band above the comment sheet.
const blockedScript = (n) => `https://blocked.example/blocked-${n}.js`
const workDir = join(run.runDir, 'viewer-notices-work')
mkdirSync(workDir, { recursive: true })
const file = join(workDir, 'notices.html')
writeFileSync(
  file,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="https://blocked.example/blocked.css">
${Array.from({ length: 14 }, (_, i) => `<script src="${blockedScript(i + 1)}"></script>`).join('\n')}
</head><body><main><h1>${title}</h1>
<p>The quick brown fox jumps over the lazy dog.</p>
<p>Pack my box with five dozen liquor jugs.</p>
</main></body></html>`,
)

const escapeRegExp = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const bannerSummary = new RegExp(
  `^${escapeRegExp(uiText('en', 'csp.banner.summaryOther', { n: '\u0001' }))}`.replace(
    '\u0001',
    '(\\d+)',
  ),
  'u',
)

// A phone, with a browser that refuses the clipboard: the recovery toast is
// what the user reads the link from, so it has to be legible.
const openPhone = async (browser, session, locale) => {
  const context = await browser.newContext({
    storageState: session,
    ignoreHTTPSErrors: true,
    locale,
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    })
    document.execCommand = () => false
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  return { context, page }
}

const toastOf = (page) => page.locator('[data-sonner-toast]').first()

// Where the toast sits, and whether anything paints over it.
const measure = async (page, { toast, sheet, banner }) =>
  page.evaluate(
    ([toastEl, sheetEl, bannerEl]) => {
      const box = (element) => {
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      }
      const rect = toastEl.getBoundingClientRect()
      const covered = []
      for (const fx of [0.08, 0.5, 0.92])
        for (const fy of [0.15, 0.5, 0.85]) {
          const x = rect.left + rect.width * fx
          const y = rect.top + rect.height * fy
          const top = document.elementFromPoint(x, y)
          if (toastEl.contains(top)) continue
          covered.push({
            at: [Math.round(x), Math.round(y)],
            by: top
              ? `${top.tagName.toLowerCase()}.${String(top.className || '').slice(0, 40)}`
              : 'nothing',
          })
        }
      return {
        toast: box(toastEl),
        sheet: box(sheetEl),
        banner: box(bannerEl),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        covered,
      }
    },
    [
      await toast.elementHandle(),
      sheet ? await sheet.elementHandle() : null,
      banner ? await banner.elementHandle() : null,
    ],
  )

const overlaps = (a, b) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))

const { browser, context, page } = await signIn(run, {
  persona: 'Free owner',
  next: '/settings/tokens',
})
page.setDefaultTimeout(20_000)
try {
  const token = await createApiToken(page, run, `verify-notices-${stamp}`)
  const share = runCli(
    run,
    FEATURE,
    '01-share',
    ['share', file, '--visibility', 'private', '--json'],
    { token, cwd: workDir },
  )
  const url = share.json?.data?.artifact?.url
  if (share.exitCode !== 0 || !url?.startsWith(run.appOrigin))
    throw new Error(`share failed: ${share.stdout}${share.stderr}`)
  const post = runCli(run, FEATURE, '02-cli-post', [
    'comments',
    'post',
    url,
    '--body',
    body,
    '--quote',
    'brown fox',
    '--json',
  ], { token })
  if (post.exitCode !== 0)
    throw new Error(`comments post failed: ${post.stdout}${post.stderr}`)
  step('CLI shares a file whose external resources the sandbox blocks', { url })

  const session = await context.storageState()
  const { context: phone, page: phonePage } = await openPhone(
    browser,
    session,
    'en',
  )
  await phonePage.goto(url)
  await phonePage
    .frameLocator('iframe')
    .first()
    .getByRole('heading', { name: title })
    .waitFor({ timeout: 30_000 })
  const banner = phonePage.getByRole('status').filter({ hasText: bannerSummary })
  await banner.waitFor()
  const bannerText = await banner.innerText()
  const blockedCount = Number(bannerSummary.exec(bannerText)?.[1])
  if (!(blockedCount >= 3))
    throw new Error(`the banner reports ${blockedCount} blocked resources`)
  if (!bannerText.startsWith(countedLabel('en', 'csp.banner.summary', blockedCount)))
    throw new Error(`unexpected banner summary: ${bannerText}`)
  await capture(run, FEATURE, '03-security-banner', phonePage)
  step('the viewer shows the sandbox security banner with its blocked count', {
    blockedCount,
  })

  await banner.getByText(uiText('en', 'csp.banner.detailsSummary')).click()
  await banner.getByText(blockedScript(1), { exact: false }).waitFor()
  const bannerBox = await stableBox(banner)
  await capture(run, FEATURE, '04-banner-expanded', phonePage, banner)
  step('expanding the banner lists the blocked resources', {
    banner: bannerBox,
  })

  await phonePage.getByRole('button', { name: 'Comments', exact: true }).click()
  const sheet = phonePage.getByRole('dialog', { name: uiText('en', 'comments.title') })
  await sheet.waitFor()
  const sheetBox = await stableBox(sheet)
  if (sheetBox.bottom !== 844)
    throw new Error(`the comment sheet is not at the bottom: ${JSON.stringify(sheetBox)}`)
  step('the comment sheet opens along the bottom of the phone viewport', {
    sheet: sheetBox,
  })

  const thread = sheet.getByRole('article').filter({ hasText: body }).first()
  await thread.waitFor()
  await thread
    .getByRole('button', { name: uiText('en', 'comments.moreActions') })
    .click()
  await phonePage
    .getByRole('menuitem', { name: uiText('en', 'comments.copyLink') })
    .click()
  const toast = toastOf(phonePage)
  await toast.waitFor()
  await toast
    .getByText(uiText('en', 'toast.copyFailedManual', { url: '' }).trim())
    .waitFor()
  await toast.getByText(new URL(url).pathname, { exact: false }).waitFor()
  await toast
    .getByRole('button', { name: uiText('en', 'toast.close') })
    .waitFor()
  await stableBox(toast)
  const open = await measure(phonePage, { toast, sheet, banner })
  if (open.toast.bottom > open.sheet.top)
    throw new Error(
      `the toast runs into the comment sheet: ${JSON.stringify(open)}`,
    )
  if (overlaps(open.toast, open.banner) === 0)
    throw new Error(
      `the fixture no longer puts the security banner behind the toast: ${JSON.stringify(open)}`,
    )
  if (open.covered.length > 0)
    throw new Error(
      `something paints over the toast: ${JSON.stringify(open.covered)}`,
    )
  await capture(run, FEATURE, '05-toast-above-sheet', phonePage)
  step('the recovery toast reads above the comment sheet and the banner', {
    toast: open.toast,
    sheet: open.sheet,
    banner: open.banner,
  })

  await sheet.getByRole('button', { name: 'Close' }).first().click()
  await sheet.waitFor({ state: 'hidden' })
  await stableBox(toast)
  const closed = await measure(phonePage, { toast, banner })
  if (closed.toast.bottom <= open.sheet.top)
    throw new Error(
      `the toast stayed lifted after the sheet closed: ${JSON.stringify(closed)}`,
    )
  if (closed.viewport.height - closed.toast.bottom > 40)
    throw new Error(
      `the toast is not back at the bottom: ${JSON.stringify(closed)}`,
    )
  if (closed.covered.length > 0)
    throw new Error(
      `something paints over the toast: ${JSON.stringify(closed.covered)}`,
    )
  await capture(run, FEATURE, '06-toast-sheet-closed', phonePage)
  step('closing the sheet drops the same toast back to the bottom', {
    toast: closed.toast,
  })

  // The analytics banner takes the same bottom edge. It is the one notice a
  // toast really lands on top of, so the toast has to stay readable over it.
  await phonePage
    .getByRole('button', { name: /@artifactshare\.local$/u })
    .first()
    .click()
  const consentItem = phonePage.getByRole('menuitem', {
    name: uiText('en', 'analyticsConsent.change'),
  })
  await consentItem.click()
  await consentItem.waitFor({ state: 'hidden' })
  const consent = phonePage.getByRole('region', {
    name: uiText('en', 'analyticsConsent.banner.aria'),
  })
  await consent.waitFor()
  await stableBox(consent)
  const shared = await measure(phonePage, { toast, banner: consent })
  if (overlaps(shared.toast, shared.banner) === 0)
    throw new Error(
      `the consent banner no longer shares the toast's band: ${JSON.stringify(shared)}`,
    )
  if (shared.covered.length > 0)
    throw new Error(
      `the consent banner covers the toast: ${JSON.stringify(shared.covered)}`,
    )
  await capture(run, FEATURE, '07-toast-over-consent-banner', phonePage)
  step('the toast reads above the analytics banner on the same edge', {
    toast: shared.toast,
    consent: shared.banner,
  })
  await phone.close()

  const { context: ja, page: jaPage } = await openPhone(browser, session, 'ja')
  await jaPage.goto(url)
  await jaPage
    .frameLocator('iframe')
    .first()
    .getByRole('heading', { name: title })
    .waitFor({ timeout: 30_000 })
  const jaSheet = jaPage.getByRole('dialog', { name: uiText('ja', 'comments.title') })
  // This is the first interaction after the page loads, so the click can land
  // before hydration and never open the sheet.
  await actUntil(
    jaPage,
    () =>
      jaPage
        .getByRole('button', { name: uiText('ja', 'comments.title'), exact: true })
        .click(),
    jaSheet,
  )
  const jaSheetBox = await stableBox(jaSheet)
  const jaThread = jaSheet.getByRole('article').filter({ hasText: body }).first()
  await jaThread
    .getByRole('button', { name: uiText('ja', 'comments.moreActions') })
    .click()
  await jaPage
    .getByRole('menuitem', { name: uiText('ja', 'comments.copyLink') })
    .click()
  const jaToast = toastOf(jaPage)
  await jaToast.waitFor()
  await jaToast
    .getByRole('button', { name: uiText('ja', 'toast.close') })
    .waitFor()
  await stableBox(jaToast)
  const jaPlacement = await measure(jaPage, { toast: jaToast, sheet: jaSheet })
  if (jaPlacement.toast.bottom > jaPlacement.sheet.top)
    throw new Error(
      `the Japanese toast runs into the comment sheet: ${JSON.stringify(jaPlacement)}`,
    )
  if (jaPlacement.covered.length > 0)
    throw new Error(
      `something paints over the Japanese toast: ${JSON.stringify(jaPlacement.covered)}`,
    )
  await capture(run, FEATURE, '08-toast-ja', jaPage)
  await ja.close()
  step('a Japanese browser labels the close button and keeps the toast clear', {
    toast: jaPlacement.toast,
    sheet: jaSheetBox,
  })
} finally {
  await browser.close()
  writeFileSync(
    join(evidenceDir(run, FEATURE), 'steps.json'),
    `${JSON.stringify({ run: run.id, title, steps }, null, 2)}\n`,
  )
}
console.log(`PASS ${FEATURE}: evidence in ${evidenceDir(run, FEATURE)}`)
