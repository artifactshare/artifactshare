#!/usr/bin/env node
// Journey: a user creates an API token in Settings, shares an HTML file with
// the CLI, and opens the returned URL; the file's content renders inside the
// sandboxed viewer frame and the file appears on Home.
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
    '03-share',
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
  await capture(run, FEATURE, '04-viewer', page)
  step('viewer renders the shared heading inside the sandbox frame')

  await page.goto(run.appOrigin)
  await page.getByRole('link', { name: new RegExp(marker) }).first().waitFor()
  await capture(run, FEATURE, '05-home', page)
  step('Home lists the shared file')

  const list = runCli(run, FEATURE, '06-artifacts-list', [
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
  const update = runCli(run, FEATURE, '07-update', ['update', url, file2, '--json'], {
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
  await capture(run, FEATURE, '08-viewer-v2', page)
  step('CLI update adds v2 at the same URL')
} finally {
  await browser.close()
  writeFileSync(
    join(evidenceDir(run, FEATURE), 'steps.json'),
    `${JSON.stringify({ run: run.id, marker, steps }, null, 2)}\n`,
  )
}
console.log(`PASS ${FEATURE}: evidence in ${evidenceDir(run, FEATURE)}`)
