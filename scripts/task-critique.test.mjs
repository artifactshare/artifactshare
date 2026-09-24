import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { uiCritique } from './agent-role-settings.mjs'
import { screenCaptureOutputRoot } from './screen-capture-output.mjs'
import { personas, taskFlowPhases, tasks } from './task-ledger.mjs'
import {
  cleanHead,
  invocation,
  parseArgs,
  promptFor,
  readDispositions,
  runLayer,
  validateInputs,
} from './task-critique.mjs'

function fixture({ external = false, taskId = tasks[0].id } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'task-critique-'))
  const root = external
    ? join(mkdtempSync(join(tmpdir(), 'task-captures-')), 'captures')
    : join(repo, 'captures')
  const task = tasks.find((item) => item.id === taskId)
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
  return { repo, root, task, head }
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
      provider: 'claude',
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

test('carries accepted task behavior into the critique prompt', () => {
  const { repo, task, head } = fixture({ taskId: 'share-file-link' })
  const input = validateInputs(
    {
      walkthroughRoot: 'captures',
      sources: ['source.tsx'],
      taskIds: [task.id],
    },
    { repo, head },
  )
  assert.equal(input.acceptedBehavior.length, 2)
  const prompt = promptFor({ id: 'task' }, input)
  assert.match(prompt, /閲覧数は所有者本人の閲覧も含む/u)
  assert.match(prompt, /管理外のファイルは更新しない/u)
  assert.match(prompt, /new evidence of user harm/u)
})

test('accepts walkthrough evidence from the configured external capture root', () => {
  const { repo, root, task, head } = fixture({ external: true })
  const input = validateInputs(
    {
      walkthroughRoot: root,
      sources: ['source.tsx'],
      taskIds: [task.id],
    },
    { repo, head, captureRoot: dirname(root) },
  )
  assert.equal(input.root, realpathSync(root))
  assert.equal(input.imagePaths.length, taskFlowPhases.length * 2)
})

test('accepts the old external root after moving a checkout with the same HEAD', (t) => {
  const { repo, root, task } = fixture()
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '--quiet')
  git('add', 'source.tsx')
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  )
  const head = git('rev-parse', 'HEAD')
  const outputRoot = screenCaptureOutputRoot((_command, args) => git(...args))
  const oldRoot = join(outputRoot, 'walkthrough')
  mkdirSync(outputRoot, { recursive: true })
  renameSync(root, oldRoot)
  writeFileSync(
    join(oldRoot, 'manifest.json'),
    JSON.stringify({ head, tasks: [{ taskId: task.id, status: 'success' }] }),
  )
  const screenRoot = join(outputRoot, 'screens')
  mkdirSync(screenRoot)
  writeFileSync(join(screenRoot, 'viewer.png'), 'png')
  writeFileSync(
    join(screenRoot, 'manifest.json'),
    JSON.stringify([{ status: 'success', head, file: 'viewer.png' }]),
  )
  const movedRepo = `${repo}-moved`
  renameSync(repo, movedRepo)
  t.after(() => {
    rmSync(movedRepo, { recursive: true, force: true })
    rmSync(dirname(outputRoot), { recursive: true, force: true })
  })
  const movedGit = (_command, args) =>
    execFileSync('git', args, { cwd: movedRepo, encoding: 'utf8' }).trim()
  assert.equal(movedGit('git', ['rev-parse', 'HEAD']), head)
  const captureRoot = screenCaptureOutputRoot(movedGit)
  assert.notEqual(captureRoot, outputRoot)
  const context = { repo: movedRepo, head, captureRoot }
  const options = {
    walkthroughRoot: oldRoot,
    sources: ['source.tsx'],
    taskIds: [task.id],
    screenRoots: [screenRoot],
  }
  const input = validateInputs(options, context)
  assert.equal(input.root, realpathSync(oldRoot))
  assert.equal(input.imagePaths.length, taskFlowPhases.length * 2)
  assert.deepEqual(input.screenImagePaths, [
    realpathSync(join(screenRoot, 'viewer.png')),
  ])
  assert.throws(
    () => validateInputs(options, { ...context, head: 'b'.repeat(40) }),
    /HEAD must match/u,
  )

  const imagePath = input.imagePaths[0]
  unlinkSync(imagePath)
  symlinkSync(join(screenRoot, 'viewer.png'), imagePath)
  assert.throws(() => validateInputs(options, context), /capture PNG required/u)
})

test('rejects arbitrary external roots and capture-layout symlinks escaping to them', (t) => {
  const { repo, root, task, head } = fixture({ external: true })
  const layout = join(dirname(root), '.old-screen-captures', 'a'.repeat(64))
  mkdirSync(layout, { recursive: true })
  const linkedRoot = join(layout, 'walkthrough')
  symlinkSync(root, linkedRoot)
  t.after(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(dirname(root), { recursive: true, force: true })
  })
  for (const walkthroughRoot of [root, linkedRoot]) {
    assert.throws(
      () =>
        validateInputs(
          { walkthroughRoot, sources: ['source.tsx'], taskIds: [task.id] },
          { repo, head },
        ),
      /inside the repository or screen capture output root/u,
    )
  }
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
    /capture PNG required/u,
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
    /capture PNG required/u,
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
    /capture PNG required/u,
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
  assert.match(
    task,
    /Give every resolved finding one disposition: fix-now, measure-first, or do-not-pursue/u,
  )
  assert.match(task, /numerator and denominator/u)
  assert.match(task, /privacy boundary/u)
  assert.match(task, /decision checkpoint/u)
  assert.match(task, /decision rule stated before collection/u)
  assert.match(task, /Do not delay these findings for measurement/u)
  assert.match(
    task,
    /verified product-defect with a proportional fix that adds no product complexity/u,
  )
  assert.match(task, /needs-verification, return NEEDS INPUT/u)
  assert.match(task, /evidence that must be recaptured or supplied/u)
  assert.match(task, /remaining evidence is sufficient/u)
  assert.match(task, /claims with no evidence of a product problem/u)
  assert.match(
    task,
    /Unknown frequency or user impact belongs to measure-first only when evidence supports a plausible product problem, no fix-now condition applies, and remediation would add product complexity/u,
  )
  assert.match(task, /Each resolved finding includes/u)
  assert.match(task, /required evidence, with no disposition/u)
  assert.match(
    task,
    /Split a minimal fix-now repair from a larger measure-first remediation into separate findings with separate evidence and dispositions/u,
  )
  const request = invocation(
    { id: 'task', model: 'fable', effort: 'low' },
    task,
  )
  assert.ok(request.args.includes('fable'))
  assert.ok(request.args.includes('low'))
})

test('selects one Codex layer with every validated PNG as an image argument', () => {
  const input = {
    selected: ['task'],
    evidencePaths: ['evidence.json'],
    imagePaths: ['desktop.png', 'mobile.png'],
    screenImagePaths: ['screen.png'],
    sourcePaths: ['source.tsx'],
  }
  const prompt = promptFor({ id: 'combined' }, input)
  assert.match(prompt, /Combined visual and task critique/u)
  const request = invocation(
    { id: 'combined', provider: 'codex', ...uiCritique.codex },
    prompt,
    input,
  )
  assert.equal(request.command, 'codex')
  assert.deepEqual(
    request.args.slice(
      request.args.indexOf('--image'),
      request.args.indexOf('-'),
    ),
    [
      '--image',
      'desktop.png',
      '--image',
      'mobile.png',
      '--image',
      'screen.png',
    ],
  )
  assert.equal(request.args.includes(uiCritique.codex.model), true)
  assert.equal(
    request.args.includes(
      `model_reasoning_effort=${JSON.stringify(uiCritique.codex.effort)}`,
    ),
    true,
  )
  assert.equal(request.input, prompt)
})

test('passes the Codex combined prompt to the reviewer stdin', async () => {
  const layer = { id: 'combined', provider: 'codex', ...uiCritique.codex }
  const input = {
    selected: ['task'],
    evidencePaths: ['evidence.json'],
    imagePaths: ['desktop.png'],
    screenImagePaths: [],
    sourcePaths: ['source.tsx'],
  }
  let capturedInvocation
  const result = await runLayer(layer, input, {
    repo: '/repo',
    run: (command, args, options) => {
      capturedInvocation = { command, args, options }
      return { status: 0, stdout: 'No findings', stderr: '' }
    },
  })
  assert.equal(result, 'No findings')
  assert.equal(capturedInvocation.command, 'codex')
  assert.equal(capturedInvocation.args.at(-1), '-')
  assert.equal(capturedInvocation.options.input, promptFor(layer, input))
})

test('unwraps a successful reviewer result', async () => {
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
    await runLayer(
      { id: 'task', model: 'fable', effort: 'low' },
      { selected: [], evidencePaths: [], imagePaths: [], sourcePaths: [] },
      { run, repo: process.cwd() },
    ),
    'No findings',
  )
  assert.equal(
    await runLayer(
      { id: 'task', model: 'fable', effort: 'low' },
      { selected: [], evidencePaths: [], imagePaths: [], sourcePaths: [] },
      { run: (...args) => Promise.resolve(run(...args)), repo: process.cwd() },
    ),
    'No findings',
  )
})

test('fails closed on missing permission denial metadata', async () => {
  const run = () => ({
    status: 0,
    stdout: JSON.stringify({
      is_error: false,
      subtype: 'success',
      result: 'No findings',
    }),
    stderr: '',
  })
  await assert.rejects(
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

test('dispositions from earlier rounds reach every critique layer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critique-dispositions-'))
  const file = join(dir, 'dispositions.md')
  writeFileSync(file, '- fixed: time and size wrapped in version rows\n')
  assert.equal(
    parseArgs([
      '--walkthrough-root',
      'w',
      '--source',
      's',
      '--dispositions-file',
      file,
    ]).dispositionsFile,
    file,
  )
  const dispositions = readDispositions(file, dir)
  const input = {
    selected: ['task'],
    evidencePaths: [],
    imagePaths: [],
    screenImagePaths: [],
    sourcePaths: [],
    dispositions,
  }
  for (const layer of [
    { id: 'visual', model: 'm', effort: 'e' },
    { id: 'task', model: 'm', effort: 'e' },
  ]) {
    const prompt = promptFor(layer, input)
    assert.match(prompt, /Do not re-raise a dispositioned finding/u)
    assert.match(prompt, /fixed: time and size wrapped in version rows/u)
  }
  assert.doesNotMatch(
    promptFor(
      { id: 'task', model: 'm', effort: 'e' },
      { ...input, dispositions: undefined },
    ),
    /Dispositions/u,
  )
  writeFileSync(file, '   \n')
  assert.throws(() => readDispositions(file, dir), /empty/u)
  assert.throws(
    () => readDispositions(join(dir, 'missing.md'), dir),
    /could not be read/u,
  )
  assert.equal(readDispositions(undefined, dir), undefined)
})
