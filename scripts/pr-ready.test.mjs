import assert from 'node:assert/strict'
import test from 'node:test'
import { parseReadyArgs, readyPullRequest } from './pr-ready.mjs'

const head = 'a'.repeat(40)

function fakeExec({
  dirty = '',
  prs = [
    {
      number: 32,
      isDraft: true,
      baseRefName: 'main',
      headRefName: 'feature',
      headRefOid: head,
    },
  ],
  failQuery = false,
  failPostQuery = false,
  postReadyPrs,
} = {}) {
  const calls = []
  let ready = false
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'git' && args[0] === 'branch') return 'feature\n'
    if (file === 'git' && args[0] === 'status') return dirty
    if (file === 'git' && args[0] === 'rev-parse') return `${head}\n`
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      if (failQuery) throw new Error('offline')
      if (ready && failPostQuery) throw new Error('confirmation offline')
      if (ready)
        return JSON.stringify(
          postReadyPrs ?? prs.map((pr) => ({ ...pr, isDraft: false })),
        )
      return JSON.stringify(prs)
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'ready') {
      ready = !args.includes('--undo')
      return ''
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`)
  }
  return { exec, calls }
}

test('readies the only draft PR after both reviewers approve pushed HEAD', () => {
  const fake = fakeExec()
  assert.deepEqual(
    readyPullRequest({ codexGo: head, claudeGo: head, exec: fake.exec }),
    { number: 32, head },
  )
  assert.deepEqual(fake.calls.at(-1)[0], 'gh')
  assert.deepEqual(fake.calls.at(-1)[1].slice(0, 3), ['pr', 'list', '--state'])
})

test('restores Draft when the remote SHA changes during readying', () => {
  const fake = fakeExec({
    postReadyPrs: [
      {
        number: 32,
        isDraft: false,
        baseRefName: 'main',
        headRefName: 'feature',
        headRefOid: 'b'.repeat(40),
      },
    ],
  })
  assert.throws(
    () => readyPullRequest({ codexGo: head, claudeGo: head, exec: fake.exec }),
    /restored Draft/,
  )
  assert.deepEqual(fake.calls.at(-1), ['gh', ['pr', 'ready', '32', '--undo']])
})

test('restores Draft when post-ready confirmation fails', () => {
  const fake = fakeExec({ failPostQuery: true })
  assert.throws(
    () => readyPullRequest({ codexGo: head, claudeGo: head, exec: fake.exec }),
    /confirmation failed; restored Draft/,
  )
  assert.deepEqual(fake.calls.at(-1), ['gh', ['pr', 'ready', '32', '--undo']])
})

test('fails closed before writes when local or PR state is unsafe', () => {
  for (const options of [
    { dirty: ' M file' },
    { prs: [] },
    {
      prs: [
        { number: 1, isDraft: false, baseRefName: 'main', headRefOid: head },
      ],
    },
    {
      prs: [
        { number: 1, isDraft: true, baseRefName: 'other', headRefOid: head },
      ],
    },
    {
      prs: [
        {
          number: 1,
          isDraft: true,
          baseRefName: 'main',
          headRefOid: 'b'.repeat(40),
        },
      ],
    },
    { failQuery: true },
  ]) {
    const fake = fakeExec(options)
    assert.throws(() =>
      readyPullRequest({ codexGo: head, claudeGo: head, exec: fake.exec }),
    )
    assert.equal(
      fake.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
      false,
    )
  }
})

test('requires both reviewer GO values to equal local HEAD', () => {
  for (const [codexGo, claudeGo] of [
    [undefined, head],
    [head, 'b'.repeat(40)],
  ]) {
    const fake = fakeExec()
    assert.throws(() =>
      readyPullRequest({ codexGo, claudeGo, exec: fake.exec }),
    )
    assert.equal(
      fake.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
      false,
    )
  }
})

test('parses exact ready arguments', () => {
  assert.deepEqual(
    parseReadyArgs(['--', '--codex-go', head, '--claude-go', head]),
    { codexGo: head, claudeGo: head, dryRun: false, help: false },
  )
  assert.throws(() => parseReadyArgs(['--other', head]))
  assert.deepEqual(parseReadyArgs(['--help']), {
    codexGo: undefined,
    claudeGo: undefined,
    dryRun: false,
    help: true,
  })
})

test('dry-run validates without readying the PR', () => {
  const fake = fakeExec()
  assert.deepEqual(
    readyPullRequest({
      codexGo: head,
      claudeGo: head,
      dryRun: true,
      exec: fake.exec,
    }),
    { number: 32, head, dryRun: true },
  )
  assert.equal(
    fake.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    false,
  )
})
