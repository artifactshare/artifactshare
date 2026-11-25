#!/usr/bin/env node
// Journey: comments on a shared file. A CLI comment anchored to a quote shows in
// the viewer's Comments panel; a user selects text in the file and adds an
// inline comment, replies, and resolves it; `comments list` confirms the stored
// state. Go to text brings the quoted text into view from inside a code block
// that scrolls sideways within a box that scrolls, and keeps working for a
// resolved thread whose text another thread also quotes.
//
//   node .claude/skills/verify-artifactshare/scripts/journeys/comments.mjs [--run <id>]
//
// Evidence: .verify-artifactshare/runs/<id>/evidence/comments/
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  capture,
  createApiToken,
  evidenceDir,
  openRun,
  runCli,
  signIn,
  uiText,
} from '../harness.mjs'

const FEATURE = 'comments'
const runIndex = process.argv.indexOf('--run')
const run = openRun(runIndex > 0 ? process.argv[runIndex + 1] : undefined)
const stamp = Date.now()
const title = `Verify comments ${stamp}`
const cliBody = `CLI comment ${stamp}`
const inlineBody = `Inline comment ${stamp}`
const replyBody = `Reply ${stamp}`
const deepBody = `Deep comment ${stamp}`
const coveredBody = `Covered comment ${stamp}`
const alphaBody = `Early comment ${stamp}`
const marker = 'ZEBRA_MARKER_TOKEN'
const earlyMarker = 'ALPHA_MARKER_TOKEN'
const steps = []
const step = (name, detail) => {
  steps.push({ name, ...detail })
  console.log(`ok ${name}`)
}

const workDir = join(run.runDir, 'comments-work')
mkdirSync(workDir, { recursive: true })
const file = join(workDir, 'comments.html')
// Far down the page, a box that scrolls holds a code block taller and wider
// than the box, quoted twice: near the end of a line close to the bottom, and
// near the start of a line close to the top. Reaching either needs the page,
// the box, and the code block to move, in both directions.
const paragraphs = (count, text) =>
  Array.from({ length: count }, (_, i) => `<p>${text} ${i + 1}.</p>`).join('')
const padding = Array.from(
  { length: 30 },
  (_, i) => `const step${i} = compute(${i}, "padding-padding-padding");`,
).join(' ')
const codeLines = Array.from(
  { length: 25 },
  (_, i) => `const line${i} = ${i}; ${padding}`,
)
codeLines[1] = `const first = "${earlyMarker}"; ${padding}`
codeLines[21] = `${padding} const token = "${marker}"; const tail = "end";`
const codeBlock = codeLines.join('\n')
writeFileSync(
  file,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>
  .scroller { height: 200px; overflow: auto; border: 2px solid #333; margin: 24px 0; }
  .scroller pre { overflow-x: auto; white-space: pre; margin: 0; font-family: monospace; }
</style></head><body><main><h1>${title}</h1><p>The quick brown fox jumps over the lazy dog.</p><p>Pack my box with five dozen liquor jugs.</p>${paragraphs(
    30,
    'Filler paragraph',
  )}<div class="scroller">${paragraphs(
    8,
    'Line inside the box',
  )}<pre>${codeBlock}</pre>${paragraphs(
    8,
    'Line below the code',
  )}</div>${paragraphs(10, 'Trailing paragraph')}</main></body></html>`,
)

const { browser, page } = await signIn(run, {
  persona: 'Free owner',
  next: '/settings/tokens',
})
page.setDefaultTimeout(20_000)
try {
  const token = await createApiToken(page, run, `verify-comments-${stamp}`)
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
    cliBody,
    '--quote',
    'brown fox',
    '--json',
  ], { token })
  if (post.exitCode !== 0 || post.json?.data?.thread?.status !== 'open')
    throw new Error(`comments post failed: ${post.stdout}${post.stderr}`)
  step('CLI posts a comment anchored to a quote')

  await page.goto(url)
  const frame = page.frameLocator('iframe').first()
  await frame.getByRole('heading', { name: title }).waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Comments', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Comments' })
  const cliThread = panel.getByRole('article').filter({ hasText: cliBody })
  await cliThread.waitFor()
  await cliThread.getByText('“brown fox”').waitFor()
  await capture(run, FEATURE, '03-panel-cli-comment', page, panel)
  step('Comments panel shows the CLI comment with its quote')
  await panel.getByRole('button', { name: 'Close' }).first().click()
  await panel.waitFor({ state: 'hidden' })

  await frame.getByText('Pack my box').click({ clickCount: 3 })
  await page.getByRole('button', { name: 'Add comment' }).click()
  const composer = page.getByRole('region', { name: 'Add comment' })
  await composer.getByText('Pack my box with five dozen liquor jugs.').waitFor()
  await composer.getByRole('textbox', { name: 'New comment' }).fill(inlineBody)
  await capture(run, FEATURE, '04-inline-composer', page, composer)
  await composer.getByRole('button', { name: 'Comment', exact: true }).click()
  await composer.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Comments', exact: true }).click()
  const inlineThread = panel.getByRole('article').filter({ hasText: inlineBody })
  await inlineThread.waitFor()
  step('selecting text and choosing Add comment creates an inline thread')

  await inlineThread.getByRole('button', { name: 'Reply', exact: true }).click()
  const replyBox = inlineThread.getByRole('textbox', { name: 'Reply' })
  await replyBox.fill(replyBody)
  await capture(run, FEATURE, '05-reply-draft', page, panel)
  // The thread's own Reply button opened the box; the last one submits it.
  await inlineThread
    .getByRole('button', { name: 'Reply', exact: true })
    .last()
    .click()
  await replyBox.waitFor({ state: 'hidden' })
  await inlineThread.getByRole('paragraph').filter({ hasText: replyBody }).waitFor()
  step('reply appears in the thread')

  await inlineThread.getByRole('button', { name: 'Resolve' }).click()
  await panel.getByRole('article').filter({ hasText: inlineBody }).waitFor({
    state: 'hidden',
  })
  await panel.getByRole('tab', { name: 'Resolved' }).click()
  await panel
    .getByRole('article')
    .filter({ hasText: inlineBody })
    .waitFor()
  await capture(run, FEATURE, '06-resolved-tab', page, panel)
  step('Resolve moves the thread to the Resolved tab')

  const list = runCli(run, FEATURE, '07-cli-list', [
    'comments',
    'list',
    url,
    '--json',
  ], { token })
  if (list.exitCode !== 0) throw new Error(`comments list failed: ${list.stderr}`)
  for (const text of [cliBody, inlineBody, replyBody])
    if (!list.stdout.includes(text))
      throw new Error(`comments list is missing "${text}"`)
  step('CLI comments list shows both threads and the reply')

  for (const [name, body, quote] of [
    ['08-cli-post-deep', deepBody, marker],
    ['09-cli-post-covered', coveredBody, marker],
    ['10-cli-post-early', alphaBody, earlyMarker],
  ]) {
    const posted = runCli(run, FEATURE, name, [
      'comments',
      'post',
      url,
      '--body',
      body,
      '--quote',
      quote,
      '--json',
    ], { token })
    if (posted.exitCode !== 0 || posted.json?.data?.thread?.status !== 'open')
      throw new Error(`comments post failed: ${posted.stdout}${posted.stderr}`)
  }
  step('CLI posts three comments inside the code block, two on the same text')

  // The sandboxed frame holds the file, so the places the text has to travel
  // through are measured inside it.
  const sandbox = () =>
    page.frames().find((candidate) => candidate.url().includes('usercontent'))
  const place = (quoted = marker) =>
    sandbox().evaluate((needle) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node
      let range = null
      while ((node = walker.nextNode())) {
        const index = node.textContent.indexOf(needle)
        if (index < 0) continue
        range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + needle.length)
        break
      }
      const rect = range?.getClientRects()[0]
      if (!rect) return null
      const round = (box) => ({
        left: Math.round(box.left),
        top: Math.round(box.top),
        right: Math.round(box.right),
        bottom: Math.round(box.bottom),
      })
      // What the element shows of its content, the way the viewer measures it.
      const shown = (element) => {
        const box = element.getBoundingClientRect()
        return round({
          left: box.left + element.clientLeft,
          top: box.top + element.clientTop,
          right: box.left + element.clientLeft + element.clientWidth,
          bottom: box.top + element.clientTop + element.clientHeight,
        })
      }
      const marks = [
        ...document.querySelectorAll('.ash-comment-highlight-badge'),
      ]
      const code = document.querySelector('.scroller pre')
      const box = document.querySelector('.scroller')
      return {
        quote: round(rect),
        code: shown(code),
        box: shown(box),
        codeScrollLeft: Math.round(code.scrollLeft),
        boxScrollTop: Math.round(box.scrollTop),
        viewport: {
          left: 0,
          top: 0,
          right: document.documentElement.clientWidth,
          bottom: document.documentElement.clientHeight,
        },
        badges: marks.length,
        // How far the nearest mark sits from the end of the quoted text: the
        // marks are repositioned after a jump, so this stays small.
        markDistance: marks.length
          ? Math.round(
              Math.min(
                ...marks.map((mark) => {
                  const at = mark.getBoundingClientRect()
                  return Math.hypot(at.left - rect.right, at.top - rect.top)
                }),
              ),
            )
          : null,
        paints: typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights.size : 0,
      }
    }, quoted)
  const inside = (inner, outer) =>
    inner.left >= outer.left &&
    inner.right <= outer.right &&
    inner.top >= outer.top &&
    inner.bottom <= outer.bottom

  const openPanel = async () => {
    await page.getByRole('button', { name: 'Comments', exact: true }).click()
    await panel.waitFor()
  }
  const goToText = async (thread, quoted = marker) => {
    await thread
      .getByRole('button', { name: uiText('en', 'comments.moreActions') })
      .click()
    await page
      .getByRole('menuitem', { name: uiText('en', 'comments.goToText') })
      .click()
    // The jump scrolls each place in turn; wait until the text stops moving.
    let previous
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = JSON.stringify(await place(quoted))
      if (current === previous) return JSON.parse(current)
      previous = current
      await page.waitForTimeout(100)
    }
    throw new Error('the quoted text never stopped moving')
  }

  await page.goto(url)
  await frame.getByRole('heading', { name: title }).waitFor({ timeout: 30_000 })
  const before = await place()
  if (!before) throw new Error('the quoted text is not in the file')
  if (before.quote.left <= before.code.right)
    throw new Error(
      `the quote starts within the code block's shown width: ${JSON.stringify(before)}`,
    )
  if (before.quote.top <= before.viewport.bottom)
    throw new Error(`the quote starts on the first screen: ${JSON.stringify(before)}`)
  await openPanel()
  const deepThread = panel.getByRole('article').filter({ hasText: deepBody })
  await deepThread.waitFor()
  await capture(run, FEATURE, '11-before-go-to-text', page)
  const after = await goToText(deepThread)
  for (const [where, box] of [
    ['the code block', after.code],
    ['the box that scrolls', after.box],
    ['the frame', after.viewport],
  ])
    if (!inside(after.quote, box))
      throw new Error(
        `Go to text left the quote outside ${where}: ${JSON.stringify(after)}`,
      )
  if (!(after.codeScrollLeft > 0))
    throw new Error(`the code block never scrolled sideways: ${JSON.stringify(after)}`)
  if (!(after.boxScrollTop > 0))
    throw new Error(`the box never scrolled down: ${JSON.stringify(after)}`)
  // The mark the reader clicks follows the text it marks.
  if (!(after.markDistance < 120))
    throw new Error(
      `the nearest mark is ${after.markDistance}px from the quote: ${JSON.stringify(after)}`,
    )
  await capture(run, FEATURE, '12-after-go-to-text', page)
  step('Go to text brings the quote through both scrolling places into view', {
    before: before.quote,
    after: after.quote,
    codeScrollLeft: after.codeScrollLeft,
    boxScrollTop: after.boxScrollTop,
    markDistance: after.markDistance,
  })

  // The same jump the other way: the quote at the start of the line is now off
  // to the left, so the code block has to scroll back.
  const earlyThread = panel.getByRole('article').filter({ hasText: alphaBody })
  await earlyThread.waitFor()
  const early = await goToText(earlyThread, earlyMarker)
  for (const [where, box] of [
    ['the code block', early.code],
    ['the frame', early.viewport],
  ])
    if (!inside(early.quote, box))
      throw new Error(
        `Go to text left the earlier quote outside ${where}: ${JSON.stringify(early)}`,
      )
  if (!(early.codeScrollLeft < after.codeScrollLeft))
    throw new Error(
      `the code block never scrolled back: ${JSON.stringify(early)}`,
    )
  await capture(run, FEATURE, '13-early-go-to-text', page)
  step('Go to text scrolls the code block back for a quote to the left', {
    after: early.quote,
    codeScrollLeft: early.codeScrollLeft,
  })

  // Five threads, five marks: each open thread marks its own text.
  if (early.badges !== 5 || early.paints !== 5)
    throw new Error(
      `expected five marked texts, saw ${early.badges} badges and ${early.paints} paints`,
    )

  const coveredThread = panel.getByRole('article').filter({ hasText: coveredBody })
  await coveredThread.getByRole('button', { name: 'Resolve' }).click()
  await coveredThread.waitFor({ state: 'hidden' })
  await page.goto(url)
  await frame.getByRole('heading', { name: title }).waitFor({ timeout: 30_000 })
  await openPanel()
  await panel.getByRole('tab', { name: 'Resolved' }).click()
  const resolvedThread = panel
    .getByRole('article')
    .filter({ hasText: coveredBody })
  await resolvedThread.waitFor()
  await resolvedThread.getByText(`“${marker}”`).waitFor()
  if (
    (await resolvedThread
      .getByText(uiText('en', 'comments.subjectOrphaned'))
      .count()) > 0
  )
    throw new Error('the resolved thread lost its quoted text')
  const resolvedPlace = await goToText(resolvedThread)
  for (const [where, box] of [
    ['the code block', resolvedPlace.code],
    ['the frame', resolvedPlace.viewport],
  ])
    if (!inside(resolvedPlace.quote, box))
      throw new Error(
        `Go to text on the resolved thread left the quote outside ${where}: ${JSON.stringify(resolvedPlace)}`,
      )
  // The resolved thread's text is the open thread's text, so it is marked once
  // now, not twice: one mark fewer than before it was resolved.
  if (resolvedPlace.badges !== early.badges - 1)
    throw new Error(
      `expected ${early.badges - 1} marked texts, saw ${resolvedPlace.badges} badges and ${resolvedPlace.paints} paints`,
    )
  await capture(run, FEATURE, '14-resolved-go-to-text', page)
  step('a resolved thread sharing the same text still jumps to it, marked once', {
    after: resolvedPlace.quote,
    badges: resolvedPlace.badges,
    paints: resolvedPlace.paints,
  })
} finally {
  await browser.close()
  writeFileSync(
    join(evidenceDir(run, FEATURE), 'steps.json'),
    `${JSON.stringify({ run: run.id, title, steps }, null, 2)}\n`,
  )
}
console.log(`PASS ${FEATURE}: evidence in ${evidenceDir(run, FEATURE)}`)
