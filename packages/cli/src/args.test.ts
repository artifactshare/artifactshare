import assert from 'node:assert/strict'
import { test } from 'vitest'
import { insertDefaultSubcommand } from './args.js'

test('preview <file> gains the default subcommand', () => {
  assert.deepEqual(insertDefaultSubcommand(['preview', './lp.html']), [
    'preview',
    'start',
    './lp.html',
  ])
})

test('a value flag before preview does not hide the command', () => {
  assert.deepEqual(
    insertDefaultSubcommand(['--profile', 'work', 'preview', './lp.html']),
    ['--profile', 'work', 'preview', 'start', './lp.html'],
  )
  assert.deepEqual(
    insertDefaultSubcommand(['--base-url=https://x.test', 'preview', 'a.md']),
    ['--base-url=https://x.test', 'preview', 'start', 'a.md'],
  )
})

test('explicit subcommands are left alone', () => {
  for (const sub of ['start', 'next', 'done', 'reply', 'stop']) {
    assert.deepEqual(insertDefaultSubcommand(['preview', sub, './lp.html']), [
      'preview',
      sub,
      './lp.html',
    ])
  }
  assert.deepEqual(
    insertDefaultSubcommand(['preview', 'next', '--wait', '90']),
    ['preview', 'next', '--wait', '90'],
  )
})

test('preview without a positional keeps the parent command', () => {
  // `preview --help` must still list the subcommands, and bare `preview` must
  // still report that one is required.
  assert.deepEqual(insertDefaultSubcommand(['preview', '--help']), [
    'preview',
    '--help',
  ])
  assert.deepEqual(insertDefaultSubcommand(['preview']), ['preview'])
})

test('other commands are untouched', () => {
  assert.deepEqual(insertDefaultSubcommand(['share', './lp.html']), [
    'share',
    './lp.html',
  ])
  assert.deepEqual(insertDefaultSubcommand([]), [])
})
