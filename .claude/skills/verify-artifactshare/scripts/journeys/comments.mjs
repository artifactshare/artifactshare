#!/usr/bin/env node
// Journey: comments on a shared file. A CLI comment anchored to a quote shows in
// the viewer's Comments panel; a user selects text in the file and adds an
// inline comment, replies, and resolves it; `comments list` confirms the stored
// state.
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
} from '../harness.mjs'

const FEATURE = 'comments'
const runIndex = process.argv.indexOf('--run')
const run = openRun(runIndex > 0 ? process.argv[runIndex + 1] : undefined)
const stamp = Date.now()
const title = `Verify comments ${stamp}`
const cliBody = `CLI comment ${stamp}`
const inlineBody = `Inline comment ${stamp}`
const replyBody = `Reply ${stamp}`
const steps = []
const step = (name, detail) => {
  steps.push({ name, ...detail })
  console.log(`ok ${name}`)
}

const workDir = join(run.runDir, 'comments-work')
mkdirSync(workDir, { recursive: true })
const file = join(workDir, 'comments.html')
writeFileSync(
  file,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>The quick brown fox jumps over the lazy dog.</p><p>Pack my box with five dozen liquor jugs.</p></main></body></html>`,
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
} finally {
  await browser.close()
  writeFileSync(
    join(evidenceDir(run, FEATURE), 'steps.json'),
    `${JSON.stringify({ run: run.id, title, steps }, null, 2)}\n`,
  )
}
console.log(`PASS ${FEATURE}: evidence in ${evidenceDir(run, FEATURE)}`)
