#!/usr/bin/env node
// Journey: a user creates a project from the Projects page, shares a file into
// it with the CLI, and finds the file in the project's file list. The CLI also
// creates a project, and `projects list` shows both.
//
//   node .claude/skills/verify-artifactshare/scripts/journeys/projects.mjs [--run <id>]
//
// Evidence: .verify-artifactshare/runs/<id>/evidence/projects/
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

const FEATURE = 'projects'
const runIndex = process.argv.indexOf('--run')
const run = openRun(runIndex > 0 ? process.argv[runIndex + 1] : undefined)
const stamp = Date.now()
const uiProject = `Verify project UI ${stamp}`
const cliProject = `Verify project CLI ${stamp}`
const title = `Verify project file ${stamp}`
const steps = []
const step = (name, detail) => {
  steps.push({ name, ...detail })
  console.log(`ok ${name}`)
}

const workDir = join(run.runDir, 'projects-work')
mkdirSync(workDir, { recursive: true })
const file = join(workDir, 'project-file.html')
writeFileSync(
  file,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1></main></body></html>`,
)

const { browser, page } = await signIn(run, {
  persona: 'Free owner',
  next: '/settings/tokens',
})
page.setDefaultTimeout(20_000)
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

  const share = runCli(
    run,
    FEATURE,
    '03-share-into-project',
    ['share', file, '--project', uiProject, '--json'],
    { token, cwd: workDir },
  )
  if (share.exitCode !== 0 || share.json?.data?.destination?.type !== 'project')
    throw new Error(`share into project failed: ${share.stdout}${share.stderr}`)
  step('CLI shares a file into the project', {
    destination: share.json.data.destination,
    visibility: share.json.data.share?.visibility,
  })

  await page.goto(`${run.appOrigin}${projectPath}/files`)
  await page.getByRole('link', { name: title }).first().waitFor()
  await capture(run, FEATURE, '04-project-files', page)
  step('the project file list shows the shared file')

  const create = runCli(run, FEATURE, '05-cli-create', [
    'projects',
    'create',
    cliProject,
    '--json',
  ], { token })
  if (create.exitCode !== 0)
    throw new Error(`projects create failed: ${create.stdout}${create.stderr}`)
  const list = runCli(run, FEATURE, '06-cli-list', ['projects', 'list', '--json'], {
    token,
  })
  for (const name of [uiProject, cliProject])
    if (!list.stdout.includes(name))
      throw new Error(`projects list is missing ${name}`)
  step('CLI creates a project and projects list shows both')

  await page.goto(`${run.appOrigin}/projects`)
  await page.getByRole('link', { name: cliProject }).first().waitFor()
  await capture(run, FEATURE, '07-projects-page', page)
  step('the Projects page lists the CLI project')
} finally {
  await browser.close()
  writeFileSync(
    join(evidenceDir(run, FEATURE), 'steps.json'),
    `${JSON.stringify({ run: run.id, uiProject, cliProject, title, steps }, null, 2)}\n`,
  )
}
console.log(`PASS ${FEATURE}: evidence in ${evidenceDir(run, FEATURE)}`)
