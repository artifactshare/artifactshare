import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const workflow = fs.readFileSync(
  path.join(root, 'docs/development-workflow.md'),
  'utf8',
)
const pullRequestTemplate = fs.readFileSync(
  path.join(root, '.github/PULL_REQUEST_TEMPLATE.md'),
  'utf8',
)

test('documents proportional review and validation', () => {
  assert.match(
    workflow,
    /Codex\/Claude deep-review pair is required only when a change affects schema, authorization, billing, delivery, or the public\/private boundary/u,
  )
  assert.match(
    workflow,
    /Ordinary code, workflow, and normative documentation changes still receive an appropriate self-review and targeted validation/u,
  )
  assert.match(
    workflow,
    /A change to this workflow policy itself must receive the Codex\/Claude deep-review pair before landing/u,
  )
  assert.doesNotMatch(
    workflow,
    /For an ordinary code, workflow, or normative documentation change, start Codex and Claude deep reviews/u,
  )
  assert.doesNotMatch(
    workflow,
    /The final gate remains an independent Codex\/Claude pair on one fixed target\./u,
  )
})

test('documents unbounded corrections, concurrent PRs, and optional records', () => {
  assert.match(
    workflow,
    /workflow does not impose a fixed number of correction commits/u,
  )
  assert.doesNotMatch(
    workflow,
    /initial commit and one distinct correction|third distinct commit|OBJECTIVE_REBASE_REQUIRED|one distinct correction HEAD|max_corrections/u,
  )
  assert.match(workflow, /Up to three open PRs may be active concurrently/u)
  assert.match(workflow, /workflow-usage block may be included/u)
  assert.match(workflow, /validates it when present/u)
  assert.match(
    workflow,
    /classify every deferred review finding honestly in the PR or task record/u,
  )
  assert.match(
    workflow,
    /no separate post-landing disposition record is required/u,
  )
  assert.match(
    workflow,
    /After the PR lands, run `pnpm pr:landed -- --pr <number>`\. It fast-forwards local `main`, detaches the current worktree when it holds the merged branch, and deletes the merged branch/u,
  )
  assert.doesNotMatch(workflow, /--disposition <kind>:<note>/u)
  assert.doesNotMatch(
    workflow,
    /requires one disposition per deferred finding/u,
  )

  assert.match(pullRequestTemplate, /^Optional\. If included,/mu)
  assert.match(
    pullRequestTemplate,
    /A change to this workflow policy must receive the Codex\/Claude deep-review pair before landing/u,
  )
})

test('retains fixed-target safety and public/private restrictions', () => {
  for (const phrase of [
    'committed, clean worktree',
    'exact Artifact Share version',
    'exact committed target',
    '`pnpm public:scan .`',
    'public/private boundary',
    'private URLs, issue numbers, customer context, credentials',
  ])
    assert.ok(workflow.includes(phrase), phrase)
})
