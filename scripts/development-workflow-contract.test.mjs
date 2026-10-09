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
  assert.match(
    workflow,
    /at most three completed review pairs under the current review profile; `review:implementation` refuses a fourth with `ROUND_CAP`/u,
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
    /After the PR lands, `pr:ready -- --queue` runs landing cleanup automatically; otherwise run `pnpm pr:landed -- --pr <number>`\. Cleanup releases the ledger entry so another PR can become Ready\. It fast-forwards local `main`, detaches the current worktree when it holds the merged branch, and deletes the merged branch/u,
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

test('documents changed browser repetitions without altering required-check policy', () => {
  for (const phrase of [
    'changed-browser-repetitions',
    'Changed browser behavior repetitions',
    'case-sensitive',
    'fixed PR head SHA',
    'merge base',
    'added/modified (`A`/`M`)',
    'Renames, including modified renames',
    'first 10 files',
    'omitted paths',
    'before dependency installation or config loading',
    'Vitest discovery',
    'effective excludes',
    'no browsers are installed',
    '`REPETITIONS`',
    'defaults to `5`',
    '`1` through `10`',
    'Renames, including modified renames, copies, deletions, and paths outside that pattern are excluded',
    '10-minute process-tree timeout',
    'bound execution to 150 invocations',
    'sorted file/project order',
    'at most 15 file/project pairs',
    'summary lists skipped pairs with the pair-cap reason',
    'Every selected file/project pair receives the configured repetitions',
    '120-minute repetition-step deadline',
    '150-minute job timeout',
    'uses `always()`',
    'Only browsers required by the plan are installed',
    'passes/requested repetitions',
    'all-skipped',
    'Setup failures are explicit',
    'Required-check policy is a separate decision',
  ])
    assert.ok(workflow.includes(phrase), phrase)
})

test('queue rebuild confirms removal and monitoring requires manual recovery', () => {
  for (const phrase of [
    'GraphQL `dequeuePullRequest`, confirms the entry is absent within a bounded wait',
    'then calls `enqueuePullRequest`',
    'bounded membership reconciliation and enqueue restoration',
    'monitoring is passive: it never dequeues or enqueues',
    'one bounded GraphQL read',
    'a confirmed merge returns the merged result',
    'a closed PR fails without rebuild advice',
    'the timeout retains the unavailable entry state, read error, and manual rerun instruction',
    'Time in the current state is unknown',
    'manually rerun `pnpm pr:queue -- --pr <number>`',
  ])
    assert.ok(workflow.includes(phrase), phrase)
  assert.doesNotMatch(workflow, /`--disable-auto` then `--auto`/u)
})

test('browser guidance retains stderr without obsolete library replacement instructions', () => {
  assert.doesNotMatch(
    workflow,
    /libsoup|WEBKIT_LIBSOUP_CACHE_DIR|r2359|1\.63\.0/iu,
  )
  assert.match(workflow, /DEBUG=pw:browser/u)
  assert.match(
    workflow,
    /installs the Playwright browsers matching the workspace dependency/u,
  )
})
