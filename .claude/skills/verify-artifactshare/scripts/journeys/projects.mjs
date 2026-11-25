#!/usr/bin/env node
// Journey: a user creates a project from the Projects page, shares files into
// it with the CLI, and reads the project's file list: its date headings, its
// file count, and the mobile navigation. The CLI also creates a project, and
// `projects list` shows both. Archiving the project moves it to the archived
// list with its file count.
//
//   node .claude/skills/verify-artifactshare/scripts/journeys/projects.mjs [--run <id>]
//
// Evidence: .verify-artifactshare/runs/<id>/evidence/projects/
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  capture,
  countedLabel,
  createApiToken,
  evidenceDir,
  openRun,
  runCli,
  signIn,
  uiText,
} from '../harness.mjs'

const FEATURE = 'projects'
const runIndex = process.argv.indexOf('--run')
const run = openRun(runIndex > 0 ? process.argv[runIndex + 1] : undefined)
const stamp = Date.now()
const uiProject = `Verify project UI ${stamp}`
const cliProject = `Verify project CLI ${stamp}`
const title = `Verify project file ${stamp}`
const secondTitle = `Verify project file B ${stamp}`
const steps = []
const step = (name, detail) => {
  steps.push({ name, ...detail })
  console.log(`ok ${name}`)
}

const workDir = join(run.runDir, 'projects-work')
mkdirSync(workDir, { recursive: true })
const htmlFile = (name, heading) => {
  const path = join(workDir, name)
  writeFileSync(
    path,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${heading}</title></head><body><main><h1>${heading}</h1></main></body></html>`,
  )
  return path
}
const file = htmlFile('project-file.html', title)
const secondFile = htmlFile('project-file-b.html', secondTitle)

// The file count is a counted label, so read the expected copy from the app's
// own catalog instead of pinning English wording in the journey.
const fileCount = (n, locale = 'en') =>
  countedLabel(locale, 'project.fileCount', n)
const metaStartingWith = (page, label) =>
  page.locator('main').getByText(
    new RegExp(`^${label.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')} · `, 'u'),
  )
const fileLink = (page, name) => page.getByRole('link', { name }).first()
const dateHeadings = (page) =>
  page.locator('main').getByRole('heading', { level: 2 })

const { browser, context, page } = await signIn(run, {
  persona: 'Free owner',
  next: '/settings/tokens',
})
page.setDefaultTimeout(20_000)
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
try {
  const token = await createApiToken(page, run, `verify-projects-${stamp}`)

  await page.goto(`${run.appOrigin}/projects`)
  await page.getByRole('heading', { name: 'Projects', level: 1 }).waitFor()
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create project' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill(uiProject)
  await capture(run, FEATURE, '01-create-dialog', page, dialog)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForURL(/\/projects\/(?!archived)[^/]+/u)
  const projectPath = new URL(page.url()).pathname.match(/^\/projects\/[^/]+/u)[0]
  await page.getByRole('heading', { name: uiProject }).first().waitFor()
  await capture(run, FEATURE, '02-project-page', page)
  step('Create on the Projects page opens the new project', { projectPath })

  const filesPath = `${run.appOrigin}${projectPath}/files`
  await page.goto(filesPath)
  await page
    .getByRole('heading', { name: uiText('en', 'project.noFilesTitle') })
    .waitFor()
  await metaStartingWith(page, fileCount(0)).first().waitFor()
  await capture(run, FEATURE, '03-empty-files', page)
  step('an empty project shows the empty state and a zero file count')

  const share = runCli(
    run,
    FEATURE,
    '04-share-into-project',
    ['share', file, '--project', uiProject, '--json'],
    { token, cwd: workDir },
  )
  if (share.exitCode !== 0 || share.json?.data?.destination?.type !== 'project')
    throw new Error(`share into project failed: ${share.stdout}${share.stderr}`)
  step('CLI shares a file into the project', {
    destination: share.json.data.destination,
    visibility: share.json.data.share?.visibility,
  })

  await page.goto(filesPath)
  await fileLink(page, title).waitFor()
  await dateHeadings(page).first().waitFor()
  const [enHeading] = await dateHeadings(page).allInnerTexts()
  const headingCount = await dateHeadings(page).count()
  if (headingCount !== 1)
    throw new Error(`expected one date heading, saw ${headingCount}`)
  if (!enHeading?.trim()) throw new Error('the date heading is empty')
  await metaStartingWith(page, fileCount(1)).first().waitFor()
  const hydrationErrors = consoleErrors.filter((text) =>
    /hydrat|Minified React error #(?:418|422|423|425)/iu.test(text),
  )
  if (hydrationErrors.length > 0)
    throw new Error(`hydration error on the file list: ${hydrationErrors[0]}`)
  await capture(run, FEATURE, '05-project-files', page)
  step('the project file list shows the shared file under a date heading', {
    heading: enHeading,
  })

  const session = await context.storageState()
  const newContext = (options) =>
    browser.newContext({
      storageState: session,
      ignoreHTTPSErrors: true,
      locale: 'en',
      reducedMotion: 'reduce',
      viewport: { width: 1280, height: 860 },
      ...options,
    })

  const ssr = await newContext({ javaScriptEnabled: false })
  const ssrPage = await ssr.newPage()
  await ssrPage.goto(filesPath)
  await fileLink(ssrPage, title).waitFor()
  const ssrHeadings = await dateHeadings(ssrPage).count()
  if (ssrHeadings !== 0)
    throw new Error(`the server-rendered list has ${ssrHeadings} date headings`)
  await capture(run, FEATURE, '06-project-files-ssr', ssrPage)
  await ssr.close()
  step('the server-rendered list shows every row and no date heading')

  const phone = await newContext({ viewport: { width: 390, height: 844 } })
  const phonePage = await phone.newPage()
  await phonePage.goto(filesPath)
  await fileLink(phonePage, title).waitFor()
  const bottomNav = (target) => target.locator('nav[data-bottom-tab-bar]')
  await bottomNav(phonePage).waitFor({ state: 'visible' })
  await capture(run, FEATURE, '07-project-files-phone', phonePage)
  await phone.close()
  if (await bottomNav(page).isVisible())
    throw new Error('the bottom tab bar is visible at desktop width')
  step('the files subpage keeps the mobile primary navigation')

  const secondShare = runCli(
    run,
    FEATURE,
    '08-share-second-file',
    ['share', secondFile, '--project', uiProject, '--json'],
    { token, cwd: workDir },
  )
  if (secondShare.exitCode !== 0)
    throw new Error(`second share failed: ${secondShare.stdout}${secondShare.stderr}`)
  await page.goto(filesPath)
  await fileLink(page, secondTitle).waitFor()
  await fileLink(page, title).waitFor()
  await dateHeadings(page).first().waitFor()
  await metaStartingWith(page, fileCount(2)).first().waitFor()
  const groupedHeadings = await dateHeadings(page).count()
  if (groupedHeadings !== 1)
    throw new Error(`same-day rows split into ${groupedHeadings} date groups`)
  await capture(run, FEATURE, '09-two-files', page)
  step('a second file updates the count and stays in one date group')

  const ja = await newContext({ locale: 'ja' })
  const jaPage = await ja.newPage()
  await jaPage.goto(filesPath)
  await fileLink(jaPage, secondTitle).waitFor()
  await dateHeadings(jaPage).first().waitFor()
  await metaStartingWith(jaPage, fileCount(2, 'ja')).first().waitFor()
  const [jaHeading] = await dateHeadings(jaPage).allInnerTexts()
  if (!jaHeading?.trim()) throw new Error('the Japanese date heading is empty')
  if (jaHeading === enHeading)
    throw new Error(`the date heading is not localized: ${jaHeading}`)
  await capture(run, FEATURE, '10-two-files-ja', jaPage)
  await ja.close()
  step('a Japanese browser sees the Japanese count and date heading', {
    heading: jaHeading,
  })

  await page.goto(`${run.appOrigin}${projectPath}`)
  await page.getByRole('heading', { name: uiProject }).first().waitFor()
  await page.getByText(fileCount(2), { exact: false }).first().waitFor()
  await capture(run, FEATURE, '11-project-summary', page)
  step('the project page summary shows the file count')

  const create = runCli(run, FEATURE, '12-cli-create', [
    'projects',
    'create',
    cliProject,
    '--json',
  ], { token })
  if (create.exitCode !== 0)
    throw new Error(`projects create failed: ${create.stdout}${create.stderr}`)
  const list = runCli(run, FEATURE, '13-cli-list', ['projects', 'list', '--json'], {
    token,
  })
  for (const name of [uiProject, cliProject])
    if (!list.stdout.includes(name))
      throw new Error(`projects list is missing ${name}`)
  step('CLI creates a project and projects list shows both')

  await page.goto(`${run.appOrigin}/projects`)
  await page.getByRole('link', { name: cliProject }).first().waitFor()
  await capture(run, FEATURE, '14-projects-page', page)
  step('the Projects page lists the CLI project')

  await page.goto(`${run.appOrigin}${projectPath}`)
  await page.getByRole('button', { name: 'Project menu' }).first().click()
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  const archiveDialog = page.getByRole('alertdialog')
  await capture(run, FEATURE, '15-archive-dialog', page, archiveDialog)
  await archiveDialog.getByRole('button', { name: 'Archive' }).click()
  await page.waitForURL(/\/projects$/u)
  await page.goto(`${run.appOrigin}/projects/archived`)
  const archivedRow = page
    .getByRole('listitem')
    .filter({ hasText: uiProject })
    .first()
  await archivedRow.waitFor()
  const archivedText = await archivedRow.innerText()
  if (!archivedText.includes(fileCount(2)))
    throw new Error(`the archived row is missing the file count: ${archivedText}`)
  await bottomNav(page).waitFor({ state: 'attached' })
  await page
    .getByRole('navigation', { name: uiText('en', 'tb.homeView') })
    .first()
    .waitFor()
  await capture(run, FEATURE, '16-archived-projects', page)
  step('archiving moves the project to the archived list with its file count', {
    row: archivedText.replaceAll('\n', ' '),
  })

  // Archive the CLI project too: the plan's project limit counts the ones that
  // are not archived, so the journey leaves the workspace as it found it.
  const archive = runCli(run, FEATURE, '17-cli-archive', [
    'projects',
    'edit',
    create.json.data.project.id,
    '--archive',
    '--json',
  ], { token })
  if (archive.exitCode !== 0)
    throw new Error(`projects edit --archive failed: ${archive.stdout}${archive.stderr}`)
  await page.goto(`${run.appOrigin}/projects/archived`)
  const archivedRows = page.getByRole('listitem')
  for (const name of [uiProject, cliProject])
    await archivedRows.filter({ hasText: name }).first().waitFor()
  const cliArchivedText = await archivedRows
    .filter({ hasText: cliProject })
    .first()
    .innerText()
  if (!cliArchivedText.includes(fileCount(0)))
    throw new Error(`the archived CLI project row reads ${cliArchivedText}`)
  await capture(run, FEATURE, '18-archived-both', page)
  step('CLI archive lists the empty project with a zero count', {
    row: cliArchivedText.replaceAll('\n', ' '),
  })
} finally {
  await browser.close()
  writeFileSync(
    join(evidenceDir(run, FEATURE), 'steps.json'),
    `${JSON.stringify(
      { run: run.id, uiProject, cliProject, title, secondTitle, steps },
      null,
      2,
    )}\n`,
  )
}
console.log(`PASS ${FEATURE}: evidence in ${evidenceDir(run, FEATURE)}`)
