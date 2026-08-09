import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { parsePublishArgs, publishPullRequest } from './pr-publish.mjs'

test('package exposes the documented PR publication entrypoint', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  assert.equal(pkg.scripts['pr:publish'], 'node scripts/pr-publish.mjs')
})

function harness({ pr = null, fail = null, mutate = null } = {}) {
  const calls = []
  let fetches = 0
  const exec = (file, args) => {
    calls.push([file, args])
    const command = `${file} ${args.join(' ')}`
    if (fail && command.includes(fail)) throw new Error('boom')
    if (mutate) mutate(command, fetches, calls)
    if (file === 'git' && args[0] === 'fetch') {
      fetches++
      return ''
    }
    if (file === 'git' && args[0] === 'branch') return 'feature/x\n'
    if (file === 'git' && args[0] === 'rev-parse') return 'local-head\n'
    if (file === 'git' && args[0] === 'merge-base') return 'merge-base\n'
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'list')
      return JSON.stringify(pr ? [{ baseRefName: 'main', ...pr }] : [])
    return ''
  }
  return {
    calls,
    run: () =>
      publishPullRequest({
        bodyFile: 'body.md',
        title: 'Draft title',
        exec,
      }),
  }
}

test('create pushes before non-interactive draft creation', () => {
  const h = harness()
  assert.deepEqual(h.run(), { mode: 'create' })
  const external = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(
    external.indexOf('git push --set-upstream origin feature/x') <
      external.findIndex((value) => value.startsWith('gh pr create')),
  )
})

test('update edits the PR before push', () => {
  const h = harness({
    pr: { number: 3, state: 'OPEN', headRefOid: 'remote', baseRefOid: 'base' },
  })
  assert.deepEqual(h.run(), { mode: 'update', number: 3 })
  const edit = h.calls.findIndex(
    ([file, args]) => file === 'gh' && args[1] === 'edit',
  )
  const push = h.calls.findIndex(
    ([file, args]) => file === 'git' && args[0] === 'push',
  )
  assert.ok(edit < push)
})

test('non-main PR and stale local state fail before writes', () => {
  const wrongBase = harness({
    pr: { number: 3, baseRefName: 'release' },
  })
  assert.throws(() => wrongBase.run(), /base must be main/u)

  const stale = harness({
    mutate(command, fetches) {
      if (command.startsWith('git merge-base') && fetches > 1)
        throw new Error('changed')
    },
  })
  assert.throws(() => stale.run(), /changed/u)
})

test('external failures identify the safe publication stage', () => {
  assert.throws(
    () => harness({ fail: 'git fetch' }).run(),
    /fetch failed before PR publication/u,
  )
  assert.throws(
    () => harness({ fail: 'git push --set-upstream' }).run(),
    /push failed before PR creation/u,
  )
})

test('CLI parses required arguments and rejects malformed input', () => {
  assert.deepEqual(
    parsePublishArgs([
      '--',
      '--body-file',
      'body.md',
      '--title',
      'Draft title',
    ]),
    { bodyFile: 'body.md', title: 'Draft title' },
  )
  assert.throws(() => parsePublishArgs(['--unknown']), /unknown argument/u)
  assert.throws(
    () => parsePublishArgs(['--title', 'one', '--title', 'two']),
    /duplicate argument/u,
  )
})
