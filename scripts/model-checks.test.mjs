import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'
import {
  MODELS,
  modelPaths,
  selectModels,
  touches,
} from './ci/model-checks.mjs'

const none = { access: false, billing: false, 'cli-refresh': false }

test('a pull request runs the models whose covered code, model, or runner it changes', async () => {
  assert.deepEqual(await selectModels(['README.md']), none)
  assert.deepEqual(
    await selectModels(['apps/web/app/services/billing-sync.server.ts']),
    { ...none, billing: true },
  )
  assert.deepEqual(
    await selectModels(['apps/web/app/modules/access/facts.ts']),
    { ...none, access: true },
  )
  assert.deepEqual(
    await selectModels([
      '.claude/skills/verify-cli-refresh-rotation/model/CliRefreshRotation.tla',
    ]),
    { ...none, 'cli-refresh': true },
  )
  assert.deepEqual(await selectModels(['scripts/lib/tlc-check.mjs']), {
    access: true,
    billing: true,
    'cli-refresh': true,
  })
  assert.deepEqual(
    await selectModels(['apps/web/app/services/billing.server.test.ts']),
    none,
  )
})

test('the merge queue runs every model, each in a CI step of its own', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-checks-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const output = path.join(directory, 'output')
  const run = spawnSync(process.execPath, ['scripts/ci/model-checks.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, EVENT_NAME: 'merge_group', GITHUB_OUTPUT: output },
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(
    fs.readFileSync(output, 'utf8'),
    'access=true\nbilling=true\ncli-refresh=true\n',
  )
  const steps = YAML.parse(
    fs.readFileSync('.github/workflows/public-ci.yml', 'utf8'),
  ).jobs['model-validation'].steps
  for (const name of Object.keys(MODELS))
    assert.ok(
      steps.some(
        (step) =>
          step.if?.includes(`steps.select.outputs.${name} == 'true'`) &&
          step.run === `node --run check:${name}-model`,
      ),
      name,
    )
})

for (const [name, skill] of Object.entries(MODELS)) {
  test(`${name} covers paths that exist and every file its skill names`, async () => {
    const paths = await modelPaths(skill)
    for (const covered of paths)
      assert.equal(
        fs.statSync(covered).isDirectory(),
        covered.endsWith('/'),
        covered,
      )
    const skillText = fs.readFileSync(
      `.claude/skills/${skill}/SKILL.md`,
      'utf8',
    )
    const whenToUse = skillText.split('## When to use')[1].split('\n## ')[0]
    const named = [
      ...whenToUse.matchAll(/`([\w./$+-]+\/[\w.$+-]+\.tsx?)`/gu),
    ].map(([, file]) =>
      file.startsWith('apps/') ? file : `apps/web/app/${file}`,
    )
    assert.ok(named.length > 0)
    for (const file of named) assert.ok(touches(paths, [file]), file)
  })
}
