import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { personas, taskFlowPhases, tasks } from './task-ledger.mjs'
import {
  cleanHead,
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
  const head = 'a'.repeat(40)
  const persona = personas.find((item) => item.id === task.persona)
  mkdirSync(join(root, task.id), { recursive: true })
  writeFileSync(join(repo, 'source.tsx'), 'export const screen = true\n')
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({ head, tasks: [{ taskId: task.id, status: 'success' }] }),
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
  return { repo, task, head }
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
      screenRoots: [],
      dryRun: true,
    },
  )
  assert.throws(
    () => parseArgs(['--walkthrough-root', 'captures']),
    /--source/u,
  )
})

test('accepts complete current desktop and mobile evidence', () => {
  const { repo, task, head } = fixture()
  const input = validateInputs(
    {
      walkthroughRoot: 'captures',
      sources: ['source.tsx'],
      taskIds: [task.id],
    },
    { repo, head },
  )
  assert.deepEqual(input.selected, [task.id])
  assert.equal(input.imagePaths.length, taskFlowPhases.length * 2)
})

test('passes commit-matched standalone screen captures to the visual layer', () => {
  const { repo, task, head } = fixture()
  const screenRoot = join(repo, 'screens')
  mkdirSync(screenRoot)
  writeFileSync(join(screenRoot, 'viewer.png'), 'png')
  writeFileSync(
    join(screenRoot, 'manifest.json'),
    JSON.stringify([
      {
        status: 'success',
        screen: 'viewer',
        state: 'default',
        viewport: 'mobile',
        file: 'viewer.png',
        head,
      },
    ]),
  )
  const input = validateInputs(
    {
      walkthroughRoot: 'captures',
      sources: ['source.tsx'],
      taskIds: [task.id],
      screenRoots: ['screens'],
    },
    { repo, head },
  )
  assert.deepEqual(input.screenImagePaths, [
    realpathSync(join(screenRoot, 'viewer.png')),
  ])
})

test('rejects walkthrough PNG paths outside the repository', () => {
  const { repo, task, head } = fixture()
  const path = join(repo, 'captures', task.id, 'evidence.json')
  const evidence = JSON.parse(readFile(path))
  evidence.runs[0].steps[0].file = '../../../outside.png'
  writeFileSync(path, JSON.stringify(evidence))
  assert.throws(
    () =>
      validateInputs(
        {
          walkthroughRoot: 'captures',
          sources: ['source.tsx'],
          taskIds: [task.id],
        },
        { repo, head },
      ),
    /repository PNG required/u,
  )
})

test('rejects source symlinks that resolve outside the repository', () => {
  const { repo, task, head } = fixture()
  const external = join(
    mkdtempSync(join(tmpdir(), 'task-source-')),
    'secret.ts',
  )
  writeFileSync(external, 'private')
  symlinkSync(external, join(repo, 'linked-source.ts'))
  assert.throws(
    () =>
      validateInputs(
        {
          walkthroughRoot: 'captures',
          sources: ['linked-source.ts'],
          taskIds: [task.id],
        },
        { repo, head },
      ),
    /inside the repository/u,
  )
})

test('rejects evidence PNG symlinks that resolve outside the repository', () => {
  const { repo, task, head } = fixture()
  const evidencePath = join(repo, 'captures', task.id, 'evidence.json')
  const evidence = JSON.parse(readFile(evidencePath))
  const imagePath = join(
    repo,
    'captures',
    task.id,
    evidence.runs[0].steps[0].file,
  )
  const external = join(mkdtempSync(join(tmpdir(), 'task-image-')), 'image.png')
  writeFileSync(external, 'private')
  unlinkSync(imagePath)
  symlinkSync(external, imagePath)
  assert.throws(
    () =>
      validateInputs(
        {
          walkthroughRoot: 'captures',
          sources: ['source.tsx'],
          taskIds: [task.id],
        },
        { repo, head },
      ),
    /repository PNG required/u,
  )
})

test('rejects walkthrough PNG paths outside the task capture root', () => {
  const { repo, task, head } = fixture()
  const unrelated = join(repo, 'captures', 'unrelated.png')
  writeFileSync(unrelated, 'png')
  const path = join(repo, 'captures', task.id, 'evidence.json')
  const evidence = JSON.parse(readFile(path))
  evidence.runs[0].steps[0].file = '../unrelated.png'
  writeFileSync(path, JSON.stringify(evidence))
  assert.throws(
    () =>
      validateInputs(
        {
          walkthroughRoot: 'captures',
          sources: ['source.tsx'],
          taskIds: [task.id],
        },
        { repo, head },
      ),
    /repository PNG required/u,
  )
})

test('rejects stale task snapshots', () => {
  const { repo, task, head } = fixture()
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
        { repo, head },
      ),
    /snapshot is stale/u,
  )
})

test('rejects array-shaped step evidence', () => {
  const { repo, task, head } = fixture()
  const path = join(repo, 'captures', task.id, 'evidence.json')
  const evidence = JSON.parse(readFile(path))
  evidence.runs[0].steps[0].evidence = []
  writeFileSync(path, JSON.stringify(evidence))
  assert.throws(
    () =>
      validateInputs(
        {
          walkthroughRoot: 'captures',
          sources: ['source.tsx'],
          taskIds: [task.id],
        },
        { repo, head },
      ),
    /evidence required/u,
  )
})

test('builds distinct visual and task reviewer contracts', () => {
  const input = {
    selected: ['task'],
    evidencePaths: ['evidence.json'],
    imagePaths: ['01.png'],
    screenImagePaths: ['screen.png'],
    sourcePaths: ['source.tsx'],
  }
  const visual = promptFor({ id: 'visual' }, input)
  const task = promptFor({ id: 'task' }, input)
  assert.match(visual, /blocker only when the screen responsibility/u)
  assert.match(visual, /screen\.png/u)
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

test('fails closed on missing permission denial metadata', () => {
  const run = () => ({
    status: 0,
    stdout: JSON.stringify({
      is_error: false,
      subtype: 'success',
      result: 'No findings',
    }),
    stderr: '',
  })
  assert.throws(
    () =>
      runLayer(
        { id: 'task', model: 'fable', effort: 'low' },
        { selected: [], evidencePaths: [], imagePaths: [], sourcePaths: [] },
        { run, repo: process.cwd() },
      ),
    /critique failed/u,
  )
})

test('requires a clean committed checkout', () => {
  const exec = (_file, args) =>
    args[0] === 'status' ? ' M source.tsx' : `${'a'.repeat(40)}\n`
  assert.throws(() => cleanHead(exec, '/repo'), /clean committed checkout/u)
})

function readFile(path) {
  return readFileSync(path, 'utf8')
}
