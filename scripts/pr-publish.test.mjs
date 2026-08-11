import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePublishArgs, publishPullRequest } from './pr-publish.mjs'

function harness({
  pr = null,
  title = 'Public title',
  body = 'Public body',
} = {}) {
  const calls = []
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'git' && args[0] === 'branch') return 'feature/x\n'
    if (file === 'gh' && args[1] === 'list')
      return JSON.stringify(pr ? [pr] : [])
    return ''
  }
  return {
    calls,
    run: (options = {}) =>
      publishPullRequest({
        bodyFile: 'body.md',
        title,
        readFile: () => body,
        exec,
        ...options,
      }),
  }
}

test('checks public metadata then pushes and creates a Draft', () => {
  const h = harness()
  assert.deepEqual(h.run(), { mode: 'create' })
  assert.deepEqual(h.calls.at(-2), [
    'git',
    ['push', '--set-upstream', 'origin', 'feature/x'],
  ])
  assert.deepEqual(h.calls.at(-1)[0], 'gh')
  assert.deepEqual(h.calls.at(-1)[1].slice(0, 5), [
    'pr',
    'create',
    '--draft',
    '--base',
    'main',
  ])
})

test('updates an existing branch PR without lifecycle snapshots', () => {
  const h = harness({ pr: { number: 3, baseRefName: 'main' } })
  assert.deepEqual(h.run(), { mode: 'update', number: 3 })
  assert.equal(
    h.calls.some(([file, args]) => file === 'git' && args[0] === 'fetch'),
    false,
  )
  assert.equal(
    h.calls.some(([file, args]) => file === 'git' && args[0] === 'push'),
    false,
  )
  assert.deepEqual(h.calls.at(-1)[1].slice(0, 3), ['pr', 'edit', '3'])
})

test('rejects private metadata before any command or remote write', () => {
  let called = false
  assert.throws(
    () =>
      publishPullRequest({
        bodyFile: 'body.md',
        title: 'fix #1552',
        readFile: () => 'Public body',
        exec: () => {
          called = true
        },
      }),
    /forbidden metadata/u,
  )
  assert.equal(called, false)
})

test('requires a topic branch and main as the PR base', () => {
  assert.throws(
    () =>
      publishPullRequest({
        bodyFile: 'body.md',
        title: 'Public title',
        readFile: () => 'Public body',
        exec: (file, args) => {
          if (file === 'git' && args[0] === 'branch') return 'main\n'
          return ''
        },
      }),
    /topic branch/u,
  )
  assert.throws(
    () => harness({ pr: { number: 3, baseRefName: 'release' } }).run(),
    /base must be main/u,
  )
})

test('parses the small publication option set', () => {
  assert.deepEqual(
    parsePublishArgs([
      '--',
      '--body-file',
      'body.md',
      '--title',
      'Title',
      '--dry-run',
    ]),
    { bodyFile: 'body.md', title: 'Title', dryRun: true, help: false },
  )
  assert.throws(() => parsePublishArgs(['--unknown']), /unknown argument/u)
})
