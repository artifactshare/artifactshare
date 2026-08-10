import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  parseReadyArgs,
  readClaudeGateReceipt,
  readyPullRequest,
  validateClaudeGateReceipt,
} from './pr-ready.mjs'

const head = 'a'.repeat(40)
const baseSha = 'b'.repeat(40)
const resultBytes = Buffer.from('review result\n', 'utf8')
const resultSha256 = createHash('sha256').update(resultBytes).digest('hex')
const receipt = {
  sha: head,
  depth: 'gate',
  risk: 'normal',
  requestedLevel: 'high',
  target: `origin/main...${head}`,
  baseSha,
  claudeVersion: '2.1.227 (Claude Code)',
  resultSha256,
  resultBytes: resultBytes.length,
  startedAt: '2026-08-11T00:00:00.000Z',
  finishedAt: '2026-08-11T00:01:00.000Z',
}

test('validates the review receipt, digest, level, and timestamps', () => {
  assert.equal(
    validateClaudeGateReceipt(receipt, {
      head,
      risk: 'normal',
      target: receipt.target,
      baseSha,
      resultBytes,
    }).resultSha256,
    resultSha256,
  )
  for (const changed of [
    { risk: 'high' },
    { baseSha: head },
    { resultBytes: Buffer.from('changed') },
  ])
    assert.throws(() =>
      validateClaudeGateReceipt(receipt, {
        head,
        risk: 'normal',
        target: receipt.target,
        baseSha,
        resultBytes,
        ...changed,
      }),
    )
  assert.throws(() =>
    validateClaudeGateReceipt(
      { ...receipt, finishedAt: '2026-08-10T00:00:00.000Z' },
      { head, risk: 'normal', target: receipt.target, baseSha, resultBytes },
    ),
  )
})

test('reads and validates the real two-file gate evidence', () => {
  const exec = (_file, args) => {
    if (args.includes('artifactshare/claude-gate-review.json'))
      return '/git/review.json\n'
    if (args.includes('artifactshare/claude-gate-review.txt'))
      return '/git/review.txt\n'
    if (args.includes('origin/main^{commit}')) return `${baseSha}\n`
    throw new Error(`unexpected git args: ${args.join(' ')}`)
  }
  const readFile = (path, encoding) => {
    if (path === '/git/review.json' && encoding === 'utf8')
      return JSON.stringify(receipt)
    if (path === '/git/review.txt' && encoding === undefined) return resultBytes
    throw new Error(`unexpected read: ${path}`)
  }
  assert.equal(
    readClaudeGateReceipt(exec, head, 'normal', readFile).resultSha256,
    resultSha256,
  )
})

function fakeExec({
  dirty = '',
  postSha = head,
  failPost = false,
  failQuery = false,
  prs,
} = {}) {
  const calls = []
  let isReady = false
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'git' && args[0] === 'branch') return 'feature\n'
    if (file === 'git' && args[0] === 'status') return dirty
    if (file === 'git' && args[0] === 'rev-parse') return `${head}\n`
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      if (failQuery && !isReady) throw new Error('offline')
      if (isReady && failPost) throw new Error('offline')
      return JSON.stringify(
        prs ?? [
          {
            number: 32,
            isDraft: !isReady,
            baseRefName: 'main',
            headRefName: 'feature',
            headRefOid: isReady ? postSha : head,
          },
        ],
      )
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'ready') {
      isReady = !args.includes('--undo')
      return ''
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`)
  }
  return { exec, calls }
}

function ready(fake, options = {}) {
  return readyPullRequest({
    codexGo: head,
    claudeGo: head,
    claudeRisk: 'normal',
    ...options,
    exec: fake.exec,
    readGateReceipt: () => receipt,
  })
}

test('readies the only matching draft PR and reports the review digest', () => {
  const fake = fakeExec()
  assert.deepEqual(ready(fake), {
    number: 32,
    head,
    claudeReviewSha256: resultSha256,
  })
})

test('dry-run performs no GitHub write', () => {
  const fake = fakeExec()
  assert.deepEqual(ready(fake, { dryRun: true }), {
    number: 32,
    head,
    claudeReviewSha256: resultSha256,
    dryRun: true,
  })
  assert.equal(
    fake.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    false,
  )
})

test('restores Draft when post-ready state changed', () => {
  const fake = fakeExec({ postSha: 'c'.repeat(40) })
  assert.throws(() => ready(fake), /restored Draft/)
  assert.deepEqual(fake.calls.at(-1), ['gh', ['pr', 'ready', '32', '--undo']])
})

test('requires exact approvals and Claude risk', () => {
  const fake = fakeExec()
  assert.throws(() => ready(fake, { claudeRisk: undefined }), /Usage/)
  assert.throws(() => ready(fake, { claudeGo: 'c'.repeat(40) }), /local HEAD/)
})

test('fails closed before writes for unsafe local and PR states', () => {
  const unsafe = [
    { dirty: ' M file' },
    { prs: [] },
    {
      prs: [
        {
          number: 32,
          isDraft: false,
          baseRefName: 'main',
          headRefName: 'feature',
          headRefOid: head,
        },
      ],
    },
    {
      prs: [
        {
          number: 32,
          isDraft: true,
          baseRefName: 'other',
          headRefName: 'feature',
          headRefOid: head,
        },
      ],
    },
    { failQuery: true },
  ]
  for (const setup of unsafe) {
    const fake = fakeExec(setup)
    assert.throws(() => ready(fake))
    assert.equal(
      fake.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
      false,
    )
  }
})

test('parses exact ready arguments', () => {
  assert.deepEqual(
    parseReadyArgs([
      '--',
      '--codex-go',
      head,
      '--claude-go',
      head,
      '--claude-risk',
      'high',
    ]),
    {
      codexGo: head,
      claudeGo: head,
      claudeRisk: 'high',
      dryRun: false,
      help: false,
    },
  )
  assert.throws(() => parseReadyArgs(['--other', head]))
})
