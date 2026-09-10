import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import test from 'node:test'
import {
  angles,
  controlledReviewOutput,
  renderPrompt,
  runControlledReview,
  validateFinder,
  validateVerifier,
} from './controlled-review-runner.mjs'

test('real renderer includes every grouped finder lens and the full context', () => {
  const prompt = renderPrompt({
    contextPath: new URL(
      '../.agents/skills/controlled-review/references/context.md',
      import.meta.url,
    ).pathname,
    role: 'finder',
  })
  assert.match(prompt, /全レビュー役へ渡す作業条件/u)
  for (const angle of angles) assert.match(prompt, new RegExp(angle, 'u'))
})

test('runs one finder then a fresh verifier with canonical candidate ids', async () => {
  const calls = []
  const ids = ['finder-call', 'verifier-call']
  const result = await runControlledReview({
    context: 'fixed context and dispositions',
    phase: 'implementation',
    createCallId: () => ids.shift(),
    render: ({ contextPath, candidatePath, role }) => {
      assert.equal(statSync(contextPath).mode & 0o777, 0o600)
      if (candidatePath)
        assert.equal(statSync(candidatePath).mode & 0o777, 0o600)
      return candidatePath
        ? `${role} prompt\n${readFileSync(candidatePath, 'utf8')}`
        : `${role} prompt`
    },
    invoke: (prompt, options) => {
      calls.push({ prompt, options })
      if (options.role === 'finder')
        return Promise.resolve(
          JSON.stringify({
            status: 'COMPLETE',
            candidates: [{ id: 'F1', summary: 'candidate' }],
            existing_matches: [],
          }),
        )
      assert.match(prompt, /finder-call:F1/u)
      return Promise.resolve(
        JSON.stringify({
          status: 'COMPLETE',
          verdict: 'FINDINGS',
          candidate_results: [
            {
              candidate_id: 'finder-call:F1',
              technical_verdict: 'CONFIRMED',
              evidence: 'reachable',
              scope_applicability: 'current acceptance criterion',
              prior_disposition: 'none',
              unknowns: 'none',
            },
          ],
          findings: [
            {
              id: 'finder-call:F1',
              severity: 'blocker',
              broken_acceptance_criterion: 'correctness',
              minimal_fix: 'repair it',
            },
          ],
          existing_matches: [],
        }),
      )
    },
  })
  assert.deepEqual(
    calls.map(({ options }) => [options.role, options.callId]),
    [
      ['finder', 'finder-call'],
      ['verifier', 'verifier-call'],
    ],
  )
  assert.equal(result.finder.candidates[0].id, 'finder-call:F1')
  assert.deepEqual(result.finder.candidates[0].aliases, [['finder-call', 'F1']])
  assert.equal(result.verifier.invocation_id, 'verifier-call')
  assert.match(controlledReviewOutput(result), /Caller decides/u)
})

test('skips verification only for a complete empty finder report', async () => {
  let calls = 0
  const result = await runControlledReview({
    context: 'fixed context',
    phase: 'spec',
    createCallId: () => 'finder-only',
    render: ({ role }) => role,
    invoke: () => {
      calls += 1
      return Promise.resolve(
        JSON.stringify({
          status: 'COMPLETE',
          candidates: [],
          existing_matches: [{ prior_id: 'codex:1' }],
        }),
      )
    },
  })
  assert.equal(calls, 1)
  assert.deepEqual(result.verifier.existing_matches, [{ prior_id: 'codex:1' }])
})

test('fails closed on incomplete, over-limit, and malformed finder output', () => {
  assert.throws(
    () =>
      validateFinder(
        JSON.stringify({
          status: 'INCOMPLETE',
          reason: 'target unavailable',
          candidates: [],
          existing_matches: [],
        }),
        6,
      ),
    /did not complete/u,
  )
  assert.throws(
    () =>
      validateFinder(
        JSON.stringify({
          status: 'COMPLETE',
          candidates: Array.from({ length: 7 }, (_, index) => ({
            id: `F${index}`,
          })),
          existing_matches: [{}],
        }),
        6,
      ),
    /candidate limit/u,
  )
  assert.doesNotThrow(() =>
    validateFinder(
      JSON.stringify({
        status: 'COMPLETE',
        candidates: Array.from({ length: 6 }, (_, index) => ({
          id: `F${index}`,
        })),
        existing_matches: Array.from({ length: 12 }, (_, index) => ({
          prior_id: `P${index}`,
        })),
      }),
      6,
    ),
  )
  assert.throws(() => validateFinder('not json', 6), /malformed JSON/u)
})

test('verifier must cover each candidate exactly and retain refutations', () => {
  const result = validateVerifier(
    JSON.stringify({
      status: 'COMPLETE',
      verdict: 'GO',
      candidate_results: [
        {
          candidate_id: 'call:F1',
          technical_verdict: 'REFUTED',
          evidence: 'guard prevents it',
          scope_applicability: 'current scope',
          prior_disposition: 'none',
          unknowns: 'none',
        },
      ],
      findings: [],
      existing_matches: [{ prior_id: 'old' }],
    }),
    ['call:F1'],
    6,
    [{ prior_id: 'old' }],
  )
  assert.equal(result.candidate_results[0].technical_verdict, 'REFUTED')
  assert.doesNotThrow(() =>
    validateVerifier(
      JSON.stringify({
        status: 'COMPLETE',
        verdict: 'GO',
        candidate_results: [
          {
            candidate_id: 'call:F1',
            technical_verdict: 'REFUTED',
            evidence: 'guard prevents it',
            scope_applicability: 'current scope',
            prior_disposition: 'none',
            unknowns: 'none',
          },
        ],
        findings: [],
        existing_matches: [{ disposition: 'fixed', prior_id: 'old' }],
      }),
      ['call:F1'],
      6,
      [{ prior_id: 'old', disposition: 'fixed' }],
    ),
  )
  assert.throws(
    () =>
      validateVerifier(
        JSON.stringify({
          status: 'COMPLETE',
          verdict: 'GO',
          candidate_results: [],
          findings: [],
          existing_matches: [],
        }),
        ['call:F1'],
        6,
      ),
    /exactly one/u,
  )
  assert.throws(
    () =>
      validateVerifier(
        JSON.stringify({
          status: 'COMPLETE',
          verdict: 'GO',
          candidate_results: [
            {
              candidate_id: 'call:F1',
              technical_verdict: 'REFUTED',
              evidence: 'guard prevents it',
              scope_applicability: 'current scope',
              prior_disposition: 'none',
              unknowns: 'none',
            },
          ],
          findings: [{ id: 'call:F1', severity: 'follow_up' }],
          existing_matches: [],
        }),
        ['call:F1'],
        6,
      ),
    /refuted candidate/u,
  )
  assert.throws(
    () =>
      validateVerifier(
        JSON.stringify({
          status: 'COMPLETE',
          verdict: 'GO',
          candidate_results: [
            { candidate_id: 'call:F1', technical_verdict: 'PLAUSIBLE' },
          ],
          findings: [],
          existing_matches: [],
        }),
        ['call:F1'],
        6,
      ),
    /nonempty evidence/u,
  )
})

test('one wall deadline is shared by finder and verifier', async () => {
  const times = [0, 100, 250, 400]
  const timeouts = []
  await runControlledReview({
    context: 'fixed context',
    phase: 'implementation',
    timeoutMs: 1_000,
    now: () => times.shift(),
    createCallId: () => 'call',
    render: ({ role }) => role,
    invoke: (_prompt, options) => {
      timeouts.push(options.timeoutMs)
      return Promise.resolve(
        options.role === 'finder'
          ? JSON.stringify({
              status: 'COMPLETE',
              candidates: [{ id: 'F1' }],
              existing_matches: [],
            })
          : JSON.stringify({
              status: 'COMPLETE',
              verdict: 'GO',
              candidate_results: [
                {
                  candidate_id: 'call:F1',
                  technical_verdict: 'REFUTED',
                  evidence: 'guard prevents it',
                  scope_applicability: 'current scope',
                  prior_disposition: 'none',
                  unknowns: 'none',
                },
              ],
              findings: [],
              existing_matches: [],
            }),
      )
    },
  })
  assert.deepEqual(timeouts, [900, 600])
})
