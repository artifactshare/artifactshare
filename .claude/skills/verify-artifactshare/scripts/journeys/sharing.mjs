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
  uiText,
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
const startsWith = (text) =>
  new RegExp(`^${text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u')
const closeLabel = uiText('en', 'visibilityDialog.close')
const cancelLabel = uiText('en', 'visibilityDialog.cancel')
const onlyCloses = (labels) =>
  labels.length === 1 && labels[0].includes(closeLabel)

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
  // A save that leaves the file private closes the dialog, so the saved state
  // is read by reopening it.
  await dialog.waitFor({ state: 'hidden' })
  await capture(run, FEATURE, '04-person-saved', owner.page)
  await owner.page
    .getByRole('button', { name: /Change who can view$/ })
    .click()
  await dialog.getByText('People including you: 2').waitFor()
  if ((await dialog.getByText('Unsaved').count()) > 0)
    throw new Error('the reopened dialog still marks the grant as unsaved')
  await capture(run, FEATURE, '04b-person-saved-reopened', owner.page, dialog)
  await owner.page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
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

  // The same dialog, driven for its own flow on a second private file: the
  // footer's state, the link expiry field, what Save posts, and the copy
  // actions that appear once the file is link-shared.
  const dialogTitle = `Verify sharing dialog ${Date.now()}`
  const dialogFile = join(workDir, 'sharing-dialog.html')
  writeFileSync(
    dialogFile,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${dialogTitle}</title></head><body><main><h1>${dialogTitle}</h1></main></body></html>`,
  )
  const second = runCli(
    run,
    FEATURE,
    '10-share-for-dialog',
    ['share', dialogFile, '--visibility', 'private', '--json'],
    { token, cwd: workDir },
  )
  const dialogUrl = second.json?.data?.artifact?.url
  if (second.exitCode !== 0 || !dialogUrl)
    throw new Error(`share failed: ${second.stdout}${second.stderr}`)

  const saves = []
  owner.page.on('request', (request) => {
    if (/\/api\/shareables\/[^/]+\/save$/u.test(request.url()))
      saves.push(request.postData())
  })
  await owner.context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: run.appOrigin,
  })
  await owner.page.goto(dialogUrl)
  await owner.page
    .frameLocator('iframe')
    .first()
    .getByRole('heading', { name: dialogTitle })
    .waitFor({ timeout: 30_000 })
  await owner.page
    .getByRole('button', { name: 'Private · Change who can view' })
    .click()
  const shareDialog = owner.page.getByRole('dialog', {
    name: 'Change who can view this file',
  })
  const footer = shareDialog.locator('[data-slot="dialog-footer"]')
  const footerLabels = () => footer.getByRole('button').allInnerTexts()
  const save = footer.getByRole('button', { name: 'Save', exact: true })
  const expiry = shareDialog.getByRole('textbox', { name: 'Link expiry date' })
  // The audience button is named after the current audience, so it is located
  // as the dialog's collapsed menu button.
  const audienceButton = shareDialog.getByRole('button', { expanded: false })
  const audience = (visibility) =>
    startsWith(uiText('en', `upload.visibility.${visibility}`))
  const chooseAudience = async (visibility) => {
    await audienceButton.click()
    await owner.page
      .getByRole('menuitemradio', { name: audience(visibility) })
      .click()
  }
  await shareDialog.waitFor()
  const unchanged = await footerLabels()
  if (!onlyCloses(unchanged))
    throw new Error(`unchanged dialog footer shows ${JSON.stringify(unchanged)}`)
  await capture(run, FEATURE, '11-dialog-unchanged', owner.page, shareDialog)
  step('the dialog opens with no pending change and only a close action')

  await chooseAudience('link')
  await expiry.waitFor()
  const defaultExpiry = await expiry.inputValue()
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(defaultExpiry))
    throw new Error(`no default link expiry date: ${defaultExpiry}`)
  const pending = await footerLabels()
  if (!pending.some((text) => text.includes(cancelLabel)))
    throw new Error(`pending dialog footer shows ${JSON.stringify(pending)}`)
  await save.waitFor()
  await capture(run, FEATURE, '12-dialog-link-pending', owner.page, shareDialog)
  step('choosing link sharing offers Cancel and Save with a default expiry', {
    defaultExpiry,
  })

  const nextDay = new Date(`${defaultExpiry}T00:00:00Z`)
  nextDay.setUTCDate(nextDay.getUTCDate() + 1)
  const laterExpiry = nextDay.toISOString().slice(0, 10)
  await expiry.fill(laterExpiry)
  await chooseAudience('private')
  const abandoned = await footerLabels()
  if (!onlyCloses(abandoned))
    throw new Error(`footer after the abandoned edit: ${JSON.stringify(abandoned)}`)
  await footer.getByRole('button').click()
  await shareDialog.waitFor({ state: 'hidden' })
  if (saves.length > 0) throw new Error(`closing posted ${saves.at(-1)}`)
  await owner.page.getByRole('button', { name: /Change who can view$/ }).click()
  await shareDialog.waitFor()
  if ((await expiry.count()) > 0)
    throw new Error('the reopened dialog kept the abandoned link selection')
  await capture(run, FEATURE, '13-dialog-reopened-clean', owner.page, shareDialog)
  step('an abandoned expiry edit posts nothing and is gone on reopen')

  await chooseAudience('link')
  await expiry.waitFor()
  if ((await expiry.inputValue()) !== defaultExpiry)
    throw new Error('the reopened dialog did not restore the default expiry')
  await expiry.fill('')
  if (!(await save.isDisabled()))
    throw new Error('Save stayed enabled with an empty expiry date')
  if ((await expiry.getAttribute('aria-invalid')) !== 'true')
    throw new Error('the empty expiry date is not marked invalid')
  const describedBy = await expiry.getAttribute('aria-describedby')
  const requiredMessage = await owner.page.locator(`#${describedBy}`).innerText()
  if (!requiredMessage.trim())
    throw new Error('the invalid expiry date has no message')
  await capture(run, FEATURE, '14-dialog-expiry-required', owner.page, shareDialog)
  await expiry.fill(defaultExpiry)
  if (await save.isDisabled()) throw new Error('Save stayed disabled with a valid date')
  if (await expiry.getAttribute('aria-invalid'))
    throw new Error('the expiry date stayed invalid after a valid date')
  step('an empty expiry date blocks Save until a date is set again', {
    requiredMessage,
  })

  // Hold the save response so the in-flight dialog can be observed; the
  // request itself still reaches the app.
  await owner.page.route(
    /\/api\/shareables\/[^/]+\/save$/u,
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      await route.continue()
    },
    { times: 1 },
  )
  await save.click()
  const savingStatus = await footer.getByRole('status').innerText()
  if (!savingStatus.trim()) throw new Error('no saving status while saving')
  for (const locked of [audienceButton, expiry, save])
    if (!(await locked.isDisabled()))
      throw new Error('a control stayed editable while saving')
  await capture(run, FEATURE, '15-dialog-saving', owner.page, shareDialog)
  step('the dialog locks its controls and announces the save in progress', {
    savingStatus,
  })

  const recipientLink = shareDialog.getByRole('link', {
    name: uiText('en', 'visibilityDialog.link.openAsRecipient'),
  })
  await recipientLink.waitFor()
  const saved = await footerLabels()
  if (!onlyCloses(saved))
    throw new Error(`footer after save shows ${JSON.stringify(saved)}`)
  if (saves.at(-1) !== JSON.stringify({ visibility: 'link' }))
    throw new Error(`unexpected save payload: ${saves.at(-1)}`)
  const linkField = shareDialog.getByRole('textbox', {
    name: uiText('en', 'visibilityDialog.link.urlLabel'),
  })
  const linkUrl = await linkField.inputValue()
  if (!(await linkField.evaluate((field) => field.readOnly)))
    throw new Error('the share link field is editable')
  if ((await recipientLink.getAttribute('href')) !== linkUrl)
    throw new Error('the recipient link and the copy field disagree')
  if ((await recipientLink.getAttribute('rel')) !== 'noopener noreferrer')
    throw new Error('the recipient link is missing rel="noopener noreferrer"')
  if ((await recipientLink.getAttribute('target')) !== '_blank')
    throw new Error('the recipient link does not open in a new tab')
  await capture(run, FEATURE, '16-dialog-saved-link', owner.page, shareDialog)
  step('saving link sharing keeps the dialog open and reveals the share link', {
    payload: saves.at(-1),
    linkUrl,
  })

  const copyStatus = shareDialog.locator('[data-copy-status]')
  if ((await copyStatus.innerText()).trim())
    throw new Error('the copy status announced before any copy')
  // A screen reader only announces a live region that was already mounted.
  const liveRegion = await copyStatus.elementHandle()
  await shareDialog
    .getByRole('button', { name: uiText('en', 'visibilityDialog.link.copyButton') })
    .click()
  await copyStatus.filter({ hasText: /\S/u }).waitFor()
  if (!(await liveRegion.evaluate((node) => node.isConnected)))
    throw new Error('the copy live region was remounted for the announcement')
  const clipboard = await owner.page.evaluate(() => navigator.clipboard.readText())
  if (clipboard !== linkUrl)
    throw new Error(`the clipboard holds ${clipboard}, not the share link`)
  await capture(run, FEATURE, '17-dialog-copied', owner.page, shareDialog)
  step('Copy link puts the share link on the clipboard and announces it', {
    announced: (await copyStatus.innerText()).trim(),
  })

  await visitor.page.goto(linkUrl)
  await visitor.page
    .frameLocator('iframe')
    .first()
    .getByRole('heading', { name: dialogTitle })
    .waitFor({ timeout: 30_000 })
  await capture(run, FEATURE, '18-visitor-copied-link', visitor.page)
  step('a signed-out visitor opens the copied share link')

  // The people list belongs to the audiences that have one, so the grant is
  // added under Specific people and the audience is set back to link first.
  await chooseAudience('private')
  // Typing the address and pressing Enter is the other way to add a person;
  // the audience menu restores focus to its button, which would commit the
  // address on blur before a click on Add lands.
  const grantInput = shareDialog.getByRole('combobox', {
    name: 'Enter a name or email address',
  })
  await grantInput.fill(viewerEmail)
  await grantInput.press('Enter')
  await shareDialog
    .getByText(uiText('en', 'visibilityDialog.grants.status.pendingAdd'))
    .waitFor()
  await chooseAudience('link')
  await expiry.fill(laterExpiry)
  await expiry.fill(defaultExpiry)
  await save.click()
  await shareDialog
    .getByText(uiText('en', 'visibilityDialog.grants.status.pendingAdd'))
    .waitFor({ state: 'hidden' })
  if (saves.at(-1) !== JSON.stringify({ addEmails: [viewerEmail] }))
    throw new Error(`grant-only save posted ${saves.at(-1)}`)
  await capture(run, FEATURE, '19-dialog-grant-saved', owner.page, shareDialog)
  step('a restored expiry date stays out of a grant-only save', {
    payload: saves.at(-1),
  })

  const unlimited = shareDialog.getByRole('checkbox', {
    name: uiText('en', 'visibilityDialog.link.unlimited'),
  })
  await unlimited.check()
  await save.click()
  await save.waitFor({ state: 'hidden' })
  if (saves.at(-1) !== JSON.stringify({ link_expires_at: null }))
    throw new Error(`the unlimited save posted ${saves.at(-1)}`)
  await capture(run, FEATURE, '20-dialog-unlimited', owner.page, shareDialog)
  await unlimited.uncheck()
  if ((await expiry.inputValue()) !== defaultExpiry)
    throw new Error('the finite default did not return after an unlimited save')
  await save.click()
  await save.waitFor({ state: 'hidden' })
  const finitePayload = JSON.parse(saves.at(-1))
  if (
    Object.keys(finitePayload).join() !== 'link_expires_at' ||
    !String(finitePayload.link_expires_at).startsWith(defaultExpiry)
  )
    throw new Error(`the finite save posted ${saves.at(-1)}`)
  await capture(run, FEATURE, '21-dialog-finite-again', owner.page, shareDialog)
  step('No expiration saves an unlimited link and the finite default returns', {
    payloads: saves.slice(-2),
  })
} finally {
  for (const browser of browsers) await browser.close().catch(() => {})
  writeFileSync(
    join(evidenceDir(run, FEATURE), 'steps.json'),
    `${JSON.stringify({ run: run.id, title, steps }, null, 2)}\n`,
  )
}
console.log(`PASS ${FEATURE}: evidence in ${evidenceDir(run, FEATURE)}`)
