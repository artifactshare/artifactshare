#!/usr/bin/env node
// Journey: who can view a file. Another workspace member cannot open a private
// file until the owner adds them in `Change who can view this file` and saves;
// a signed-out visitor cannot open it until `artifactshare edit --visibility
// link` turns on link sharing.
//
//   node .claude/skills/verify-artifactshare/scripts/journeys/sharing.mjs [--run <id>]
//
// Evidence: .verify-artifactshare/runs/<id>/evidence/sharing/
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  capture,
  createApiToken,
  evidenceDir,
  launchBrowser,
  openRun,
  runCli,
  signIn,
} from '../harness.mjs'

const FEATURE = 'sharing'
const runIndex = process.argv.indexOf('--run')
const run = openRun(runIndex > 0 ? process.argv[runIndex + 1] : undefined)
const title = `Verify sharing ${Date.now()}`
const viewerEmail = ['dev-plus-owner', 'artifactshare.local'].join('@')
const steps = []
const step = (name, detail) => {
  steps.push({ name, ...detail })
  console.log(`ok ${name}`)
}

const workDir = join(run.runDir, 'sharing-work')
mkdirSync(workDir, { recursive: true })
const file = join(workDir, 'sharing.html')
writeFileSync(
  file,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1></main></body></html>`,
)

const browsers = []
const open = async (promise) => {
  const session = await promise
  browsers.push(session.browser)
  session.page.setDefaultTimeout(20_000)
  return session
}
const contentHeading = (page) =>
  page.frameLocator('iframe').first().getByRole('heading', { name: title })

try {
  const owner = await open(
    signIn(run, { persona: 'Free owner', next: '/settings/tokens' }),
  )
  const token = await createApiToken(owner.page, run, `verify-sharing-${Date.now()}`)
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
  const path = new URL(url).pathname

  const member = await open(signIn(run, { persona: 'Plus owner', next: path }))
  await member.page
    .getByRole('heading', { name: "You can't view this file" })
    .waitFor()
  await capture(run, FEATURE, '02-member-denied', member.page)
  step('another member is refused before being added')

  await owner.page.goto(url)
  await contentHeading(owner.page).waitFor({ timeout: 30_000 })
  await owner.page
    .getByRole('button', { name: 'Private · Change who can view' })
    .click()
  const dialog = owner.page.getByRole('dialog', {
    name: 'Change who can view this file',
  })
  await dialog
    .getByRole('combobox', { name: 'Enter a name or email address' })
    .fill(viewerEmail)
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await dialog.getByText('People including you: 2').waitFor()
  await capture(run, FEATURE, '03-person-added-unsaved', owner.page, dialog)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.getByText('Unsaved').waitFor({ state: 'hidden' })
  await capture(run, FEATURE, '04-person-saved', owner.page, dialog)
  step('owner adds the member by email and saves')

  await member.page.reload()
  await contentHeading(member.page).waitFor({ timeout: 30_000 })
  await capture(run, FEATURE, '05-member-allowed', member.page)
  step('the added member can now open the file')

  const visitor = await open(launchBrowser())
  await visitor.page.goto(url)
  await visitor.page
    .getByRole('heading', { name: 'Sign in to view this file' })
    .waitFor()
  if ((await visitor.page.locator('iframe').count()) > 0)
    throw new Error('a signed-out visitor got a viewer frame for a private file')
  await capture(run, FEATURE, '06-visitor-before-link', visitor.page)
  step('a signed-out visitor cannot see the private file')

  const edit = runCli(run, FEATURE, '07-edit-link', [
    'edit',
    url,
    '--visibility',
    'link',
    '--no-link-expiry',
    '--json',
  ], { token })
  if (edit.exitCode !== 0) throw new Error(`edit failed: ${edit.stdout}${edit.stderr}`)
  step('CLI edit turns on link sharing')

  await visitor.page.goto(url)
  await contentHeading(visitor.page).waitFor({ timeout: 30_000 })
  await capture(run, FEATURE, '08-visitor-with-link', visitor.page)
  step('a signed-out visitor can open the file by its URL')

  await owner.page.reload()
  await owner.page
    .getByRole('button', { name: /Change who can view$/ })
    .waitFor()
  const label = await owner.page
    .getByRole('button', { name: /Change who can view$/ })
    .getAttribute('aria-label')
  await capture(run, FEATURE, '09-owner-label', owner.page)
  if (label !== 'Link sharing · Change who can view')
    throw new Error(`unexpected audience label: ${label}`)
  step('the owner sees the new audience in the top bar', { label })
} finally {
  for (const browser of browsers) await browser.close().catch(() => {})
  writeFileSync(
    join(evidenceDir(run, FEATURE), 'steps.json'),
    `${JSON.stringify({ run: run.id, title, steps }, null, 2)}\n`,
  )
}
console.log(`PASS ${FEATURE}: evidence in ${evidenceDir(run, FEATURE)}`)
