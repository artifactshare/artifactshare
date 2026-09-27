import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  codeReviewInvocation,
  codeReviewOutput,
  localInstructionsFile,
  parseCodeReviewFindings,
  runCodeReview,
} from './claude-code-review.mjs'

const fence = '```'

function evidenceIn(directory) {
  return {
    baseRoot: join(directory, 'evidence', 'base'),
    headRoot: join(directory, 'evidence', 'head'),
    diffPath: join(directory, 'evidence', 'diff.patch'),
  }
}

test('findings come from the last JSON block and keep unknown severities as blockers', () => {
  const text = `Summary first.\n${fence}json\n[{"file":"a.mjs","summary":"old"}]\n${fence}\nThen the final list:\n${fence}json\n[{"file":"a.mjs","line":3,"severity":"follow_up","summary":"tidy"},{"file":"b.mjs","summary":"breaks AC-1","severity":"major"}]\n${fence}\nREVIEW_STATUS: COMPLETE`
  const findings = parseCodeReviewFindings(text)
  assert.deepEqual(
    findings.map(({ id, severity, file }) => [id, severity, file]),
    [
      ['code-review-1', 'follow_up', 'a.mjs'],
      ['code-review-2', 'blocker', 'b.mjs'],
    ],
  )
  assert.equal(
    JSON.parse(codeReviewOutput({ findings, callId: 'c1', level: 'high' }))
      .verdict,
    'FINDINGS',
  )
  assert.equal(
    JSON.parse(codeReviewOutput({ findings: [], callId: 'c1', level: 'high' }))
      .verdict,
    'GO',
  )
})

test('prose without a findings block, a malformed entry, or no complete status is rejected', () => {
  const done = '\nREVIEW_STATUS: COMPLETE'
  assert.throws(() => parseCodeReviewFindings(`No issues.${done}`), /no JSON/u)
  assert.throws(
    () =>
      parseCodeReviewFindings(`${fence}json\n{"file":"a"}\n${fence}${done}`),
    /JSON array/u,
  )
  assert.throws(
    () =>
      parseCodeReviewFindings(`${fence}json\n[{"file":"a"}]\n${fence}${done}`),
    /no summary/u,
  )
  assert.throws(
    () => parseCodeReviewFindings(`${fence}json\n[]\n${fence}`),
    /did not report REVIEW_STATUS/u,
  )
  assert.throws(
    () =>
      parseCodeReviewFindings(
        `${fence}json\n[]\n${fence}\nREVIEW_STATUS: INCOMPLETE: diff unreadable`,
      ),
    /incomplete: INCOMPLETE: diff unreadable/u,
  )
})

test('a finding that quotes a code fence does not cut the findings short', () => {
  const text = `${fence}json\n[{"file":"a.mjs","severity":"follow_up","summary":"quotes ${fence}json inside a ${fence} fence"}]\n${fence}\n\`REVIEW_STATUS: COMPLETE\``
  assert.equal(
    parseCodeReviewFindings(text)[0].summary,
    `quotes ${fence}json inside a ${fence} fence`,
  )
})

test('the invocation runs /code-review read-only on the fixed range', () => {
  const args = codeReviewInvocation({
    model: 'claude-opus-5-5',
    level: 'high',
    base: 'b'.repeat(40),
    head: 'h'.repeat(40),
    sessionId: 'session',
    evidenceRoot: '/tmp/evidence',
  })
  assert.equal(
    args[1],
    `/code-review high ${'b'.repeat(40)}...${'h'.repeat(40)}`,
  )
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,Agent')
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob,Agent')
  assert.equal(args[args.indexOf('--effort') + 1], 'high')
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk')
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project,local')
  assert.ok(args.includes('--strict-mcp-config'))
  assert.match(args[args.indexOf('--disallowedTools') + 1], /^Bash,Edit,Write/u)
  assert.equal(args[args.indexOf('--add-dir') + 1], '/tmp/evidence')
  assert.equal(args.includes('--safe-mode'), false)
})

test('the change context is present only while the review runs', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'code-review-repo-'))
  const localPath = join(repository, localInstructionsFile)
  let seen
  const result = await runCodeReview({
    context: 'Acceptance: AC-7 says "percent".',
    repository,
    base: 'base',
    head: 'head',
    createCallId: () => 'call-1',
    prepareEvidence: ({ directory }) => evidenceIn(directory),
    invoke: ({ role, callId, evidenceRoot }) => {
      seen = {
        role,
        callId,
        evidenceRoot,
        text: readFileSync(localPath, 'utf8'),
      }
      return Promise.resolve(
        `${fence}json\n[]\n${fence}\nREVIEW_STATUS: COMPLETE`,
      )
    },
  })
  assert.deepEqual(result, { findings: [], callId: 'call-1' })
  assert.equal(seen.role, 'code-review')
  assert.match(seen.text, /AC-7/u)
  assert.match(seen.text, /base-to-head diff: .*diff\.patch/u)
  assert.match(
    seen.text,
    /A blocker is a finding that prevents what the issue/u,
  )
  assert.equal(existsSync(localPath), false)

  await assert.rejects(
    runCodeReview({
      context: 'x',
      repository,
      base: 'base',
      head: 'head',
      prepareEvidence: ({ directory }) => evidenceIn(directory),
      invoke: () => Promise.reject(new Error('provider failed')),
    }),
    /provider failed/u,
  )
  assert.equal(existsSync(localPath), false)
})

test("an owner's existing CLAUDE.local.md is refused and left untouched", async () => {
  const repository = mkdtempSync(join(tmpdir(), 'code-review-repo-'))
  const localPath = join(repository, localInstructionsFile)
  writeFileSync(localPath, 'mine')
  let invoked = false
  await assert.rejects(
    runCodeReview({
      context: 'x',
      repository,
      base: 'base',
      head: 'head',
      prepareEvidence: ({ directory }) => evidenceIn(directory),
      invoke: () => {
        invoked = true
        return Promise.resolve('')
      },
    }),
    /already exists/u,
  )
  assert.equal(invoked, false)
  assert.equal(readFileSync(localPath, 'utf8'), 'mine')
})

test('an interrupt removes the instructions file before the default exit', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'code-review-repo-'))
  const localPath = join(repository, localInstructionsFile)
  const { EventEmitter } = await import('node:events')
  const signals = Object.assign(new EventEmitter(), {
    pid: 1,
    killed: [],
    kill(pid, name) {
      this.killed.push([pid, name])
    },
  })
  await runCodeReview({
    context: 'x',
    repository,
    base: 'base',
    head: 'head',
    signals,
    prepareEvidence: ({ directory }) => evidenceIn(directory),
    invoke: () => {
      assert.equal(existsSync(localPath), true)
      signals.emit('SIGTERM')
      assert.equal(existsSync(localPath), false)
      return Promise.resolve(
        `${fence}json\n[]\n${fence}\nREVIEW_STATUS: COMPLETE`,
      )
    },
  })
  assert.deepEqual(signals.killed, [[1, 'SIGTERM']])
  assert.equal(signals.listenerCount('SIGINT'), 0)
})

test('only the last JSON block counts, even when an earlier one parses', () => {
  const text = `${fence}json\n[]\n${fence}\n${fence}json\n[{"file": broken\n${fence}\nREVIEW_STATUS: COMPLETE`
  assert.throws(() => parseCodeReviewFindings(text), /not valid JSON/u)
  const withId = parseCodeReviewFindings(
    `${fence}json\n[{"id":"x","file":"a","summary":"s","severity":"follow_up"}]\n${fence}\nREVIEW_STATUS: COMPLETE`,
  )
  assert.equal(withId[0].id, 'code-review-1')
})
