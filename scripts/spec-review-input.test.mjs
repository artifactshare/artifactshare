import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertReviewAllowed,
  cliPackage,
  normalizeReviewResult,
  reviewStateMarker,
  scopeLock,
  specReviewPrompt,
  specMetrics,
} from './spec-review-input.mjs'

function envelope(overrides = {}) {
  return JSON.stringify({
    ok: true,
    data: {
      content: `## Scope lock

### Owner decisions

- Keep the bounded behavior.

### Non-goals

- Future generalization.

### Acceptance criteria

- The final requirement is met.

## Requirement

Final requirement`,
      version_id: 'v1',
      truncated: false,
      comments_has_more: false,
      comments: [
        { status: 'resolved', id: 'old', messages: [] },
        {
          status: 'open',
          id: 'open',
          anchor: 'requirement',
          messages: [
            {
              message_id: 'm1',
              body: 'Check this edge',
              created_at: '2026-08-11T00:00:00Z',
              ignored: 'private transport detail',
            },
          ],
        },
      ],
      ...overrides,
    },
  })
}

test('builds one bounded prompt for both spec reviewers', () => {
  let invocation
  const { prompt, scopeLock: parsedScopeLock } = specReviewPrompt({
    artifactUrl: 'https://example.test/a/spec',
    versionId: 'v1',
    run: (file, args) => {
      invocation = [file, args]
      return envelope()
    },
  })
  assert.equal(invocation[0], 'npm')
  assert.ok(invocation[1].includes(`--package=${cliPackage}`))
  assert.ok(invocation[1].includes('https://example.test/a/spec'))
  assert.match(prompt, /Artifact Share version: v1/u)
  assert.match(prompt, /Final requirement/u)
  assert.match(prompt, /Check this edge/u)
  assert.match(prompt, /PRIOR FINDINGS AND DISPOSITIONS/u)
  assert.match(parsedScopeLock.owner_decisions, /bounded behavior/u)
  assert.doesNotMatch(prompt, /private transport detail|"old"/u)
})

test('rejects stale or incomplete spec input', () => {
  const options = {
    artifactUrl: 'https://example.test/a/spec',
    versionId: 'v1',
  }
  assert.throws(
    () =>
      specReviewPrompt({
        ...options,
        run: () => envelope({ version_id: 'v2' }),
      }),
    /version does not match/u,
  )
  assert.throws(
    () =>
      specReviewPrompt({
        ...options,
        run: () => envelope({ truncated: true }),
      }),
    /incomplete/u,
  )
})

test('rejects an incomplete or nonnumeric baseline on every round', () => {
  const options = {
    artifactUrl: 'https://example.test/a/spec',
    versionId: 'v1',
    run: () => envelope(),
  }
  assert.throws(
    () => specReviewPrompt({ ...options, baselineSize: Number.NaN }),
    /finite nonnegative baseline/u,
  )
  assert.throws(
    () => specReviewPrompt({ ...options, baselineSize: 10 }),
    /finite nonnegative baseline/u,
  )
})

test('removes state messages without hiding legitimate thread messages', () => {
  const { comments } = specReviewPrompt({
    artifactUrl: 'https://example.test/a/spec',
    versionId: 'v1',
    run: () =>
      envelope({
        comments: [
          {
            status: 'open',
            id: 'mixed',
            anchor: 'requirement',
            messages: [
              {
                message_id: 'real',
                body: 'Keep this review comment',
                created_at: '2026-08-11T00:00:00Z',
              },
              {
                message_id: 'state',
                body: `${reviewStateMarker}\n{"versions":[]}`,
                created_at: '2026-08-11T00:01:00Z',
              },
            ],
          },
        ],
      }),
  })
  assert.equal(comments[0].messages[0].body, 'Keep this review comment')
  assert.equal(comments[0].messages.length, 1)
})

test('keeps headings inside fenced examples in the scope lock', () => {
  const lock = scopeLock(`## Scope lock

### Owner decisions

\`\`\`markdown
## Example
### Non-goals
\`\`\`

Keep the example.

### Non-goals

- No expansion.

### Acceptance criteria

- Example remains intact.

## Requirement`)
  assert.match(lock.owner_decisions, /## Example/u)
  assert.match(lock.owner_decisions, /Keep the example/u)
  assert.match(lock.non_goals, /No expansion/u)
})

test('rejects an unclosed fence in the scope lock', () => {
  assert.throws(
    () =>
      scopeLock(`## Scope lock

### Owner decisions

\`\`\`markdown
example

### Non-goals

- No expansion.

### Acceptance criteria

- Complete.`),
    /Unclosed fenced code block/u,
  )
})

test('does not pass an unsupported or repeated owner-decision blocker', () => {
  const result = normalizeReviewResult(
    JSON.stringify({
      verdict: 'FINDINGS',
      findings: [
        {
          id: 'unsupported',
          severity: 'blocker',
          summary: 'Prefer another tradeoff',
          broken_acceptance_criterion: null,
          new_evidence: null,
          minimal_fix: 'Change it',
          conflicts_with_owner_decision: true,
        },
        {
          id: 'supported',
          severity: 'blocker',
          summary: 'Current AC fails',
          broken_acceptance_criterion: 'AC 2',
          new_evidence: 'The described state is unreachable',
          minimal_fix: 'Remove that state',
          conflicts_with_owner_decision: false,
        },
      ],
    }),
  )
  assert.equal(result.findings[0].severity, 'non_actionable')
  assert.equal(result.findings[1].severity, 'blocker')
})

test('recomputes verdict after unsupported blockers are downgraded', () => {
  const result = normalizeReviewResult(
    JSON.stringify({
      verdict: 'FINDINGS',
      findings: [
        {
          id: 'owner-tradeoff',
          severity: 'blocker',
          summary: 'Prefer another tradeoff',
          broken_acceptance_criterion: null,
          new_evidence: null,
          minimal_fix: 'Change it',
          conflicts_with_owner_decision: true,
        },
      ],
    }),
  )
  assert.equal(result.verdict, 'GO')
  assert.equal(result.findings[0].severity, 'non_actionable')
})

test('accepts findings that contain only non-blockers', () => {
  const result = normalizeReviewResult(
    JSON.stringify({
      verdict: 'FINDINGS',
      findings: [
        {
          id: 'later',
          severity: 'follow_up',
          summary: 'Consider later cleanup',
        },
      ],
    }),
  )
  assert.equal(result.verdict, 'GO')
})

test('accepts detailed reviewer output above the former per-reviewer limit', () => {
  const result = normalizeReviewResult(
    JSON.stringify({
      verdict: 'FINDINGS',
      findings: [
        {
          id: 'large',
          severity: 'follow_up',
          summary: 'x'.repeat(1300),
        },
      ],
    }),
  )
  assert.equal(result.verdict, 'GO')
  assert.equal(result.findings[0].summary.length, 1300)
})

test('rejects reviewer output above the expanded durable-state budget', () => {
  assert.throws(
    () =>
      normalizeReviewResult(
        JSON.stringify({
          verdict: 'FINDINGS',
          findings: [
            {
              id: 'too-large',
              severity: 'follow_up',
              summary: 'x'.repeat(1600),
            },
          ],
        }),
      ),
    /concise output limit/u,
  )
})

test('rejects too many findings even when individually short', () => {
  assert.throws(
    () =>
      normalizeReviewResult(
        JSON.stringify({
          verdict: 'FINDINGS',
          findings: Array.from({ length: 6 }, (_, index) => ({
            id: `f${index}`,
            severity: 'follow_up',
          })),
        }),
      ),
    /finding count limit/u,
  )
})

test('stops runaway correction rounds, growth, concepts, and contradictory findings', () => {
  const metrics = { size: 100, conceptCount: 1 }
  const bundle = (...values) => ({
    baseline_metrics: metrics,
    prior_findings: values.map((_, index) => ({ id: `f${index}` })),
    dispositions: values.map((value, index) => ({ id: `f${index}`, ...value })),
  })
  assert.doesNotThrow(() =>
    assertReviewAllowed({
      metrics,
      reviewRound: 2,
      baselineMetrics: metrics,
      dispositions: bundle({ disposition: 'fixed' }),
    }),
  )
  assert.doesNotThrow(() =>
    assertReviewAllowed({
      metrics,
      reviewRound: 2,
      baselineMetrics: metrics,
      dispositions: {
        baseline_metrics: metrics,
        prior_findings: [],
        dispositions: [],
      },
    }),
  )
  assert.throws(
    () =>
      assertReviewAllowed({
        metrics,
        reviewRound: 4,
        dispositions: bundle({ disposition: 'fixed' }),
      }),
    /CIRCUIT_BREAKER/u,
  )
  assert.throws(
    () =>
      assertReviewAllowed({
        metrics: { size: 161, conceptCount: 1 },
        baselineMetrics: metrics,
      }),
    /size grew/u,
  )
  assert.throws(
    () =>
      assertReviewAllowed({
        metrics: { size: 100, conceptCount: 6 },
        baselineMetrics: metrics,
      }),
    /concepts/u,
  )
  assert.throws(
    () => assertReviewAllowed({ metrics, reviewRound: 2 }),
    /require dispositions/u,
  )
  assert.throws(
    () =>
      assertReviewAllowed({
        metrics,
        reviewRound: 2,
        baselineMetrics: metrics,
        dispositions: bundle(
          { disposition: 'fixed', contradiction: true },
          { disposition: 'fixed', contradiction: true },
          { disposition: 'fixed' },
        ),
      }),
    /dominant/u,
  )
  assert.throws(
    () =>
      assertReviewAllowed({
        metrics,
        reviewRound: 2,
        baselineMetrics: metrics,
        dispositions: bundle({ disposition: 'fixed', repeated: true }),
      }),
    /repeated/u,
  )
  assert.throws(
    () =>
      assertReviewAllowed({
        metrics,
        reviewRound: 2,
        baselineMetrics: metrics,
        dispositions: {
          baseline_metrics: metrics,
          prior_findings: [{ id: 'a' }, { id: 'b' }],
          dispositions: [{ id: 'a', disposition: 'fixed' }],
        },
      }),
    /Every previous finding/u,
  )
})

test('fails closed on malformed reviewer findings', () => {
  assert.throws(
    () => normalizeReviewResult('{"findings":[{"severity":"P1"}]}'),
    /invalid severity/u,
  )
  assert.throws(
    () => normalizeReviewResult('{"findings":[null]}'),
    /finding 1 is invalid/u,
  )
  assert.throws(
    () => normalizeReviewResult('{"verdict":"FINDINGS","findings":[]}'),
    /inconsistent/u,
  )
  assert.throws(
    () =>
      normalizeReviewResult(
        '{"findings":[{"id":"same","severity":"follow_up"},{"id":"same","severity":"non_actionable"}]}',
      ),
    /ids must be unique/u,
  )
})

test('counts distinct exception and state concepts', () => {
  assert.equal(
    specMetrics('Unless X.\nUnless X.\n## State machine\n## Statement')
      .conceptCount,
    2,
  )
})
