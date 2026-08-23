import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { personas, taskFlowPhases, tasks } from './task-ledger.mjs'
import {
  invocation,
  parseArgs,
  promptFor,
  runLayer,
  validateInputs,
} from './task-critique.mjs'

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'task-critique-'))
  const root = join(repo, 'captures')
  const task = tasks[0]
  const persona = personas.find((item) => item.id === task.persona)
  mkdirSync(join(root, task.id), { recursive: true })
  writeFileSync(join(repo, 'source.tsx'), 'export const screen = true\n')
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({ tasks: [{ taskId: task.id, status: 'success' }] }),
  )
  const runs = ['desktop', 'mobile'].map((viewport) => ({
    viewport,
    status: 'success',
    steps: taskFlowPhases.map((phase, index) => {
      const file = `${index + 1}-${phase}-${viewport}.png`
      writeFileSync(join(root, task.id, file), 'png')
      return { phase, file, evidence: { url: `https://localhost/${phase}` } }
    }),
  }))
  writeFileSync(
    join(root, task.id, 'evidence.json'),
    JSON.stringify({ task, persona, runs }),
  )
  return { repo, task }
}

test('parses repeatable task and source options', () => {
  assert.deepEqual(
    parseArgs([
      '--',
      '--walkthrough-root',
      'captures',
      '--source',
      'a.tsx',
      '--source',
      'b.ts',
      '--task',
      'one',
      '--dry-run',
    ]),
    {
      walkthroughRoot: 'captures',
      sources: ['a.tsx', 'b.ts'],
      taskIds: ['one'],
      dryRun: true,
    },
  )
  assert.throws(
    () => parseArgs(['--walkthrough-root', 'captures']),
    /--source/u,
  )
})

test('accepts complete current desktop and mobile evidence', () => {
  const { repo, task } = fixture()
  const input = validateInputs(
    {
      walkthroughRoot: 'captures',
      sources: ['source.tsx'],
      taskIds: [task.id],
    },
    { repo },
  )
  assert.deepEqual(input.selected, [task.id])
  assert.equal(input.imagePaths.length, taskFlowPhases.length * 2)
})

test('rejects stale task snapshots', () => {
  const { repo, task } = fixture()
  const path = join(repo, 'captures', task.id, 'evidence.json')
  const evidence = JSON.parse(readFile(path))
  evidence.task.confirmation = 'stale'
  writeFileSync(path, JSON.stringify(evidence))
  assert.throws(
    () =>
      validateInputs(
        {
          walkthroughRoot: 'captures',
          sources: ['source.tsx'],
          taskIds: [task.id],
        },
        { repo },
      ),
    /snapshot is stale/u,
  )
})

test('builds distinct visual and task reviewer contracts', () => {
  const input = {
    selected: ['task'],
    evidencePaths: ['evidence.json'],
    imagePaths: ['01.png'],
    sourcePaths: ['source.tsx'],
  }
  const visual = promptFor({ id: 'visual' }, input)
  const task = promptFor({ id: 'task' }, input)
  assert.match(visual, /blocker only when the screen responsibility/u)
  assert.match(task, /all eight dimensions/u)
  assert.match(task, /completion and confirmation/u)
  assert.match(task, /needs to decide X/u)
  const request = invocation(
    { id: 'task', model: 'fable', effort: 'low' },
    task,
  )
  assert.ok(request.args.includes('fable'))
  assert.ok(request.args.includes('low'))
})

test('unwraps a successful reviewer result', () => {
  const run = () => ({
    status: 0,
    stdout: JSON.stringify({
      is_error: false,
      subtype: 'success',
      result: 'No findings',
      permission_denials: [],
    }),
    stderr: '',
  })
  assert.equal(
    runLayer(
      { id: 'task', model: 'fable', effort: 'low' },
      { selected: [], evidencePaths: [], imagePaths: [], sourcePaths: [] },
      { run, repo: process.cwd() },
    ),
    'No findings',
  )
})

function readFile(path) {
  return readFileSync(path, 'utf8')
}
