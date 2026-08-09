import assert from 'node:assert/strict'
import test from 'node:test'
import { parseReadyArgs, readyPullRequest } from './pr-ready.mjs'

const head = 'a'.repeat(40)

function fakeExec({
  dirty = '',
  prs = [{ number: 32, isDraft: true, baseRefName: 'main', headRefOid: head }],
  failQuery = false,
} = {}) {
  const calls = []
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'git' && args[0] === 'branch') return 'feature\n'
    if (file === 'git' && args[0] === 'status') return dirty
    if (file === 'git' && args[0] === 'rev-parse') return `${head}\n`
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      if (failQuery) throw new Error('offline')
      return JSON.stringify(prs)
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'ready') return ''
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
  assert.deepEqual(fake.calls.at(-1), ['gh', ['pr', 'ready', '32']])
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
    { codexGo: head, claudeGo: head },
  )
  assert.throws(() => parseReadyArgs(['--other', head]))
})
