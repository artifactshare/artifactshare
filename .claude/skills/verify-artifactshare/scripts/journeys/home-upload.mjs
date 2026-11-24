#!/usr/bin/env node
// Journey: a signed-in user chooses `Add a file` on Home, picks an HTML file in
// the file chooser, lands on the new file's viewer with its content rendered in
// the sandbox frame, and finds the file on Home.
//
//   node .claude/skills/verify-artifactshare/scripts/journeys/home-upload.mjs [--run <id>]
//
// Evidence: .verify-artifactshare/runs/<id>/evidence/home-upload/
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture, evidenceDir, openRun, signIn } from '../harness.mjs'

const FEATURE = 'home-upload'
const runIndex = process.argv.indexOf('--run')
const run = openRun(runIndex > 0 ? process.argv[runIndex + 1] : undefined)
const marker = `Verify upload ${Date.now()}`
const steps = []
const step = (name, detail) => {
  steps.push({ name, ...detail })
  console.log(`ok ${name}`)
}

const workDir = join(run.runDir, 'upload-work')
mkdirSync(workDir, { recursive: true })
const file = join(workDir, 'upload.html')
writeFileSync(
  file,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><main><h1>${marker}</h1><p>Uploaded by the verify-artifactshare journey.</p></main></body></html>`,
)

const { browser, page } = await signIn(run, { persona: 'Free owner', next: '/' })
try {
  await page.getByRole('heading', { name: 'Home', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Add a file' }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Turn AI-generated files into shareable links',
  })
  await dialog.waitFor()
  await capture(run, FEATURE, '01-dialog', page, dialog)
  step('Add a file opens the upload dialog')

  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: /^Drop an HTML/ }).click()
  await (await chooser).setFiles(file)
  await page.waitForURL(/\/a\/[^/]+$/u, { timeout: 30_000 })
  const url = page.url()
  await page
    .frameLocator('iframe')
    .first()
    .getByRole('heading', { name: marker })
    .waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: `Edit title: ${marker}` }).waitFor()
  await capture(run, FEATURE, '02-viewer', page)
  step('upload opens the viewer with the content in the sandbox frame', {
    url,
  })

  await page.goto(run.appOrigin)
  await page.getByRole('link', { name: marker }).first().waitFor()
  await capture(run, FEATURE, '03-home', page)
  step('Home lists the uploaded file')
} finally {
  await browser.close()
  writeFileSync(
    join(evidenceDir(run, FEATURE), 'steps.json'),
    `${JSON.stringify({ run: run.id, marker, steps }, null, 2)}\n`,
  )
}
console.log(`PASS ${FEATURE}: evidence in ${evidenceDir(run, FEATURE)}`)
