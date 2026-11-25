#!/usr/bin/env node
// Journey: a user creates an API token in Settings, shares an HTML file with
// the CLI, and opens the returned URL; the file's content renders inside the
// sandboxed viewer frame and the file appears on Home. The run speaks HTTPS
// with a development certificate, so the journey also shows what `
// --insecure-localhost` is for: without it the CLI refuses the connection, and
// with it the token and every uploaded file reach the app, including a
// directory's nested asset and a Markdown version.
//
//   node .claude/skills/verify-artifactshare/scripts/journeys/cli-share-view.mjs [--run <id>]
//
// Evidence: .verify-artifactshare/runs/<id>/evidence/cli-share/
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

const FEATURE = 'cli-share'
const runIndex = process.argv.indexOf('--run')
const run = openRun(runIndex > 0 ? process.argv[runIndex + 1] : undefined)
const marker = `Verify share ${Date.now()}`
const steps = []
const step = (name, detail) => {
  steps.push({ name, ...detail })
  console.log(`ok ${name}`)
}

const { browser, page } = await signIn(run, {
  persona: 'Free owner',
  next: '/settings/tokens',
})
try {
  const token = await createApiToken(page, run, `verify-${run.id}`)
  await capture(run, FEATURE, '01-token-created', page)
  step('create API token in Settings')

  const whoami = runCli(run, FEATURE, '02-whoami', ['whoami', '--json'], {
    token,
  })
  const email = whoami.json?.data?.user?.email ?? whoami.json?.user?.email
  if (whoami.exitCode !== 0 || !email?.endsWith('@artifactshare.local'))
    throw new Error(
      `whoami did not report a local dev persona: ${whoami.stdout}${whoami.stderr}`,
    )
  step('CLI whoami is the dev persona', { email })

  // Same command, same token, without the flag. The run serves HTTPS with the
  // development certificate, which the CLI does not trust, so the request never
  // reaches the app and it reports a network failure rather than an answer.
  const refused = runCli(run, FEATURE, '03-whoami-no-flag', ['whoami', '--json'], {
    token,
    insecureLocalhost: false,
  })
  const failure = refused.json?.error
  if (refused.exitCode === 0)
    throw new Error(`whoami succeeded without --insecure-localhost: ${refused.stdout}`)
  if (failure?.code !== 'network_failed')
    throw new Error(
      `unexpected failure without the flag: ${refused.stdout}${refused.stderr}`,
    )
  step('without --insecure-localhost the CLI never reaches the app', {
    code: failure.code,
  })

  const workDir = join(run.runDir, 'cli-work')
  mkdirSync(workDir, { recursive: true })
  const file = join(workDir, 'report.html')
  writeFileSync(
    file,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><main><h1>${marker}</h1><p>Shared by the verify-artifactshare journey.</p></main></body></html>`,
  )
  const share = runCli(
    run,
    FEATURE,
    '04-share',
    ['share', file, '--visibility', 'private', '--json'],
    { token, cwd: workDir },
  )
  const url = share.json?.data?.artifact?.url
  if (share.exitCode !== 0 || typeof url !== 'string')
    throw new Error(`share failed: ${share.stdout}${share.stderr}`)
  if (!url.startsWith(run.appOrigin))
    throw new Error(`share returned a URL outside this run: ${url}`)
  step('CLI share returns a URL on this run', { url })

  await page.goto(url)
  const frame = page.frameLocator('iframe').first()
  await frame
    .getByRole('heading', { name: marker })
    .waitFor({ timeout: 30_000 })
  // The share went up as one multipart request; its visibility travelled in the
  // same request, so the viewer shows the file as private.
  await page
    .getByRole('button', {
      name: `${uiText('en', 'table.visibilityOnlyMe')} · ${uiText('en', 'vw.changeVisibility')}`,
    })
    .waitFor()
  await capture(run, FEATURE, '05-viewer', page)
  step('viewer renders the shared heading inside the sandbox frame, kept private')

  await page.goto(run.appOrigin)
  await page.getByRole('link', { name: new RegExp(marker) }).first().waitFor()
  await capture(run, FEATURE, '06-home', page)
  step('Home lists the shared file')

  const list = runCli(run, FEATURE, '07-artifacts-list', [
    'artifacts',
    'list',
    '--json',
  ], { token })
  if (list.exitCode !== 0 || !list.stdout.includes(marker))
    throw new Error(`artifacts list does not show the file: ${list.stdout}`)
  step('CLI artifacts list shows the file (second view of the stored row)')

  const updated = `${marker} v2`
  const file2 = join(workDir, 'report-v2.html')
  writeFileSync(
    file2,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><main><h1>${updated}</h1></main></body></html>`,
  )
  const update = runCli(run, FEATURE, '08-update', ['update', url, file2, '--json'], {
    token,
  })
  if (update.exitCode !== 0) throw new Error(`update failed: ${update.stdout}${update.stderr}`)
  await page.goto(url)
  await page
    .frameLocator('iframe')
    .first()
    .getByRole('heading', { name: updated })
    .waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Version status: v2' }).waitFor()
  await capture(run, FEATURE, '09-viewer-v2', page)
  step('CLI update adds v2 at the same URL')

  // A directory goes up as one multipart request, each file under its path in
  // the directory. The stylesheet only colours the heading if it arrived as
  // assets/style.css.
  const siteMarker = `${marker} site`
  const siteColor = 'rgb(16, 94, 203)'
  const siteDir = join(workDir, 'site')
  mkdirSync(join(siteDir, 'assets'), { recursive: true })
  writeFileSync(
    join(siteDir, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${siteMarker}</title><link rel="stylesheet" href="assets/style.css"></head><body><main><h1>${siteMarker}</h1></main></body></html>`,
  )
  writeFileSync(join(siteDir, 'assets', 'style.css'), `h1 { color: ${siteColor}; }`)
  const siteShare = runCli(
    run,
    FEATURE,
    '10-share-directory',
    ['share', siteDir, '--visibility', 'private', '--json'],
    { token, cwd: workDir },
  )
  const siteUrl = siteShare.json?.data?.artifact?.url
  if (siteShare.exitCode !== 0 || typeof siteUrl !== 'string')
    throw new Error(`directory share failed: ${siteShare.stdout}${siteShare.stderr}`)
  await page.goto(siteUrl)
  await page
    .frameLocator('iframe')
    .first()
    .getByRole('heading', { name: siteMarker })
    .waitFor({ timeout: 30_000 })
  const sandbox = page
    .frames()
    .find((candidate) => candidate.url().includes('usercontent'))
  const headingColor = await sandbox.evaluate(
    () => getComputedStyle(document.querySelector('h1')).color,
  )
  if (headingColor !== siteColor)
    throw new Error(
      `the directory's stylesheet did not reach the viewer: heading is ${headingColor}`,
    )
  await capture(run, FEATURE, '11-viewer-directory', page)
  step("a directory's nested stylesheet arrives and styles the page", {
    url: siteUrl,
    headingColor,
  })

  const notes = join(workDir, 'notes.md')
  const notesHeading = `${marker} notes`
  writeFileSync(notes, `# ${notesHeading}\n\nWritten as Markdown by the journey.\n`)
  const shareNotes = runCli(
    run,
    FEATURE,
    '12-share-markdown',
    ['share', notes, '--visibility', 'private', '--json'],
    { token, cwd: workDir },
  )
  const notesUrl = shareNotes.json?.data?.artifact?.url
  if (shareNotes.exitCode !== 0 || typeof notesUrl !== 'string')
    throw new Error(`markdown share failed: ${shareNotes.stdout}${shareNotes.stderr}`)
  await page.goto(notesUrl)
  await page
    .frameLocator('iframe')
    .first()
    .getByRole('heading', { name: notesHeading })
    .waitFor({ timeout: 30_000 })
  await capture(run, FEATURE, '13-viewer-markdown', page)
  step('a Markdown file arrives as Markdown and renders as a heading', {
    url: notesUrl,
  })
} finally {
  await browser.close()
  writeFileSync(
    join(evidenceDir(run, FEATURE), 'steps.json'),
    `${JSON.stringify({ run: run.id, marker, steps }, null, 2)}\n`,
  )
}
console.log(`PASS ${FEATURE}: evidence in ${evidenceDir(run, FEATURE)}`)
