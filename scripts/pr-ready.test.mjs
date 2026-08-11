import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgs, ready } from './pr-ready.mjs'

const head = 'a'.repeat(40)

test('parses reviewer SHA confirmations', () => {
  assert.deepEqual(
    parseArgs(['--', '--codex-go', head, '--claude-go', head, '--dry-run']),
    { codexGo: head, claudeGo: head, dryRun: true },
  )
})

test('readies the matching pushed draft without review receipts', () => {
  const calls = []
  let listCount = 0
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'git' && args[0] === 'branch') return 'topic\n'
    if (file === 'git' && args[0] === 'rev-parse') return `${head}\n`
    if (file === 'git' && args[0] === 'status') return ''
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      listCount += 1
      return JSON.stringify([
        {
          number: 54,
          isDraft: listCount === 1,
          baseRefName: 'main',
          headRefName: 'topic',
          headRefOid: head,
        },
      ])
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'ready') return ''
    throw new Error(`Unexpected call: ${file} ${args.join(' ')}`)
  }
  assert.deepEqual(
    ready({
      exec,
      parsed: { codexGo: head, claudeGo: head, dryRun: false },
    }),
    { number: 54, head, dryRun: false },
  )
  assert.equal(
    calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    true,
  )
})

test('rejects stale reviewer confirmations', () => {
  const exec = (file, args) => {
    if (file === 'git' && args[0] === 'branch') return 'topic\n'
    if (file === 'git' && args[0] === 'rev-parse') return `${head}\n`
    if (file === 'git' && args[0] === 'status') return ''
    throw new Error('remote write must not run')
  }
  assert.throws(
    () =>
      ready({
        exec,
        parsed: { codexGo: 'b'.repeat(40), claudeGo: head, dryRun: false },
      }),
    /must equal HEAD/u,
  )
})
