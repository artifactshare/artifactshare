import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgs, ready } from './pr-ready.mjs'

const head = 'a'.repeat(40)

function harness({
  remoteHead = head,
  draft = true,
  base = 'main',
  dirty = false,
} = {}) {
  const calls = []
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'git' && args[0] === 'branch') return 'topic\n'
    if (file === 'git' && args[0] === 'rev-parse') return `${head}\n`
    if (file === 'git' && args[0] === 'status') return dirty ? ' M file' : ''
    if (file === 'gh' && args[1] === 'list')
      return JSON.stringify([
        {
          number: 56,
          isDraft: draft,
          baseRefName: base,
          headRefName: 'topic',
          headRefOid: remoteHead,
        },
      ])
    return ''
  }
  return { calls, exec }
}

test('needs no reviewer SHA arguments', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false })
  assert.deepEqual(parseArgs(['--', '--dry-run']), { dryRun: true })
  assert.throws(() => parseArgs(['--codex-go', head]), /Usage/u)
})

test('checks required status then makes the pushed Draft ready', () => {
  const h = harness()
  assert.deepEqual(ready({ exec: h.exec, parsed: { dryRun: false } }), {
    number: 56,
    head,
    dryRun: false,
  })
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(
    commands.indexOf('gh pr checks 56 --required') <
      commands.indexOf('gh pr ready 56'),
  )
})

test('rejects dirty, stale, non-Draft, and wrong-base state before Ready', () => {
  for (const options of [
    { dirty: true },
    { remoteHead: 'b'.repeat(40) },
    { draft: false },
    { base: 'release' },
  ]) {
    const h = harness(options)
    assert.throws(() => ready({ exec: h.exec, parsed: { dryRun: false } }))
    assert.equal(
      h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
      false,
    )
  }
})

test('does not attempt repository-specific rollback after Ready', () => {
  const h = harness()
  h.exec = (file, args) => {
    if (file === 'gh' && args[1] === 'ready') throw new Error('GitHub failed')
    return harness().exec(file, args)
  }
  assert.throws(
    () => ready({ exec: h.exec, parsed: { dryRun: false } }),
    /GitHub failed/u,
  )
})
