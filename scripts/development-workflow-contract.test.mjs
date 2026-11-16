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

test('documents proportional specification review and the exact-HEAD Ready prerequisite', () => {
  assert.match(
    workflow,
    /For a specification, the Codex\/Claude deep-review pair is required only when a change affects schema, authorization, billing, delivery, or the public\/private boundary/u,
  )
  assert.match(
    workflow,
    /Ordinary specifications receive an appropriate self-review and targeted validation instead/u,
  )
  assert.match(
    workflow,
    /Every implementation, whether ordinary code, workflow, normative documentation, or boundary-sensitive, reaches Ready only after the implementation gate \(`pnpm review:implementation`\) has recorded a completed Codex\/Claude pair for its exact committed HEAD under the current review profile; `pr:ready` enforces this\./u,
  )
  assert.match(
    workflow,
    /A pair recorded for an earlier commit, a single reviewer, a different profile, or legacy or unreadable history does not count; the refusal names HEAD, and `pnpm review:implementation` on that HEAD is the retry\./u,
  )
  assert.match(
    workflow,
    /When the diff contains UI changes, it also requires a completed `pnpm critique:tasks` record for that exact HEAD/u,
  )
  assert.match(
    workflow,
    /SHA-256 identities of the validated walkthrough and screen capture roots, whose recorded capture HEAD equals that HEAD\. It stores no plaintext paths, prompts, sources, scope judgments, dispositions, or reviewer output/u,
  )
  assert.match(
    workflow,
    /A later commit makes the record obsolete for Ready\./u,
  )
  for (const text of [workflow, pullRequestTemplate]) {
    assert.doesNotMatch(text, /--ui-gate-complete/u)
    assert.doesNotMatch(text, /ordinary change, summarize the self-review/iu)
  }
  assert.doesNotMatch(
    workflow,
    /Ordinary code, workflow, and normative documentation changes still receive an appropriate self-review and targeted validation, but do not require this pair/u,
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

test('requires root-cause rationale next to the smallest-design guidance', () => {
  const proportional = workflow
    .split('## Keep the workflow proportional\n')[1]
    ?.split('\n## ')[0]
  assert.ok(proportional)
  assert.match(
    proportional,
    /Prefer the smallest reversible design that solves the observed case\.\n\nSmall is not the same as a workaround\./u,
  )
  assert.match(
    proportional,
    /Before choosing a design, name the root cause of the observed problem and the change that removes it, even when that change is outside the files first mentioned\./u,
  )
  assert.match(
    proportional,
    /A workaround is acceptable only when the commit message \(repeated in the PR description\) records the workaround, the root cause it leaves in place, and a reason other than size or effort, such as an explicit owner decision or a conflict with protected scope\./u,
  )
  assert.match(
    proportional,
    /Examples of workarounds include a type assertion such as `as unknown as`, a longer wait or timeout, a skip, a retry, a swallowed error, or a special case for one input\./u,
  )
  assert.match(
    proportional,
    /Agents copy neighbouring code, so an unexplained workaround becomes the pattern for later changes\./u,
  )
  assert.match(
    proportional,
    /If the failure is hypothetical, belongs to a possible future expansion, or is already handled by an existing mechanism, classify the proposal as a follow-up or non-actionable rather than expanding the current change\./u,
  )
})

test('classifies introduced workarounds without the required record as blockers', () => {
  const classification = workflow
    .split(
      'Classify every review finding by its effect on the current change:\n',
    )[1]
    ?.split('\nChanging the specification')[0]
  assert.ok(classification)
  const blocker = classification
    .split('\n')
    .find((line) => line.startsWith('- **Blocker:**'))
  assert.ok(blocker)
  assert.match(
    blocker,
    /A workaround introduced by the change, including an existing workaround copied to a new site, is also a blocker if the commit messages of the change omit the workaround, the root cause it leaves in place, or a reason other than size or effort\./u,
  )
  const limits = classification
    .split('\n\n')
    .find((paragraph) => paragraph.startsWith('Do not promote'))
  assert.ok(limits)
  assert.match(
    limits,
    /Apply the introduced-workaround exception in the \*\*Blocker\*\* definition above\./u,
  )
  assert.match(
    limits,
    /A change that adds no workaround is not blocked for lacking a root-cause statement\./u,
  )
  assert.match(
    limits,
    /A complete record does not exempt a workaround from the other blocker criteria\./u,
  )
  assert.match(
    limits,
    /Requests to fix pre-existing workarounds elsewhere remain follow-ups\./u,
  )
  assert.match(
    limits,
    /Do not promote a finding to blocker merely because it would make the design more general, more future-proof, or more internally complete\./u,
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
    'no browsers are launched',
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
    'a lane with no pairs skips execution',
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
    /contract tests require equality with Compose and the exact Playwright version/u,
  )
})

test('viewer units precede browser discovery with separate timing and honest failure reporting', () => {
  for (const phrase of [
    'Before browser discovery',
    'test:unit:viewer',
    'app/routes/a.$id/+components',
    'viewer-controller-testing.md',
    'source-only and unit-only',
    'No browser discovery runs after unit assertion failure',
    '55-minute job timeout',
    'total of 34 minutes',
    'leaving six minutes',
  ])
    assert.ok(workflow.includes(phrase), phrase)
})

test('the PR Change section requests the public workaround record', () => {
  const change = pullRequestTemplate.split('## Change\n')[1]?.split('\n## ')[0]
  assert.ok(change)
  assert.match(
    change,
    /Describe any workaround, the root cause it leaves in place, and a reason other than size or effort\. Record this in the commit message \(repeated in the PR description\)\./u,
  )
})
