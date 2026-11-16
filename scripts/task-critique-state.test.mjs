import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import {
  captureRootIdentity,
  critiqueCompletionRecord,
  critiqueStatePath,
  readCritiqueRecord,
  writeCritiqueRecord,
} from './task-critique-state.mjs'

const headA = 'a'.repeat(40)
const headB = 'b'.repeat(40)

function repository(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'critique-state-')))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const repo = join(parent, 'main')
  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '--quiet', '-b', 'main', repo])
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.test')
  git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'initial')
  // Each run resolves Git from the repository, never from this process's cwd.
  const runIn = (cwd) => (file, args) =>
    execFileSync(file, args, { cwd, encoding: 'utf8' }).trim()
  return { parent, repo, git, runIn }
}

function record(head, roots = { walkthroughRoot: '/captures/walkthrough' }) {
  return critiqueCompletionRecord({ head, ...roots })
}

test('linked worktrees share a branch record in the Git common directory', (t) => {
  const { parent, repo, git, runIn } = repository(t)
  const linked = join(parent, 'linked')
  git(repo, 'worktree', 'add', '--quiet', '-b', 'topic', linked)

  const written = writeCritiqueRecord(record(headA), {
    run: runIn(linked),
    repo: linked,
  })
  assert.equal(dirname(dirname(dirname(written))), join(repo, '.git'))

  // The main worktree reports a relative `.git`; it resolves against `repo`.
  assert.equal(runIn(repo)('git', ['rev-parse', '--git-common-dir']), '.git')
  const fromMain = critiqueStatePath('topic', { run: runIn(repo), repo })
  assert.equal(fromMain, written)
  assert.deepEqual(readCritiqueRecord(fromMain), record(headA))
})

test('records are isolated by branch and keep only the latest completion', (t) => {
  const { repo, git, runIn } = repository(t)
  const run = runIn(repo)
  writeCritiqueRecord(record(headA), { run, repo })
  git(repo, 'switch', '--quiet', '-c', 'fix/a-b')
  writeCritiqueRecord(record(headB), { run, repo })
  git(repo, 'switch', '--quiet', '-c', 'fix_a-b')

  const pathFor = (branch) => critiqueStatePath(branch, { run, repo })
  assert.equal(readCritiqueRecord(pathFor('main')).head, headA)
  assert.equal(readCritiqueRecord(pathFor('fix/a-b')).head, headB)
  assert.equal(readCritiqueRecord(pathFor('fix_a-b')), undefined)

  git(repo, 'switch', '--quiet', 'main')
  writeCritiqueRecord(record(headB), { run, repo })
  assert.equal(readCritiqueRecord(pathFor('main')).head, headB)
  assert.equal(readdirSync(dirname(pathFor('main'))).length, 2)
})

test('a detached HEAD writes no record', (t) => {
  const { repo, git, runIn } = repository(t)
  git(repo, 'switch', '--quiet', '--detach')
  assert.equal(
    writeCritiqueRecord(record(headA), { run: runIn(repo), repo }),
    undefined,
  )
  assert.throws(() =>
    readdirSync(join(repo, '.git', 'artifactshare', 'task-critique')),
  )
})

test('stores allowlisted keys and hashed roots with private modes', (t) => {
  const { repo, runIn } = repository(t)
  const walkthroughRoot = join(repo, 'private-walkthrough-root')
  const screenRoot = join(repo, 'private-screen-root')
  const path = writeCritiqueRecord(
    record(headA, { walkthroughRoot, screenRoots: [screenRoot] }),
    { run: runIn(repo), repo },
  )
  const text = readFileSync(path, 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(text)), [
    'schema_version',
    'head',
    'completed',
    'walkthroughRoot',
    'screenRoots',
  ])
  assert.deepEqual(JSON.parse(text), {
    schema_version: 1,
    head: headA,
    completed: true,
    walkthroughRoot: captureRootIdentity(walkthroughRoot),
    screenRoots: [captureRootIdentity(screenRoot)],
  })
  assert.doesNotMatch(text, /private-|\//u)
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700)
  }
})

test('malformed, incomplete-shape and unsupported records are no evidence', (t) => {
  const { repo, runIn } = repository(t)
  const path = writeCritiqueRecord(record(headA), { run: runIn(repo), repo })
  const valid = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(readCritiqueRecord(path), valid)
  const faults = [
    ['truncated JSON', '{ "schema_version": 1'],
    ['unsupported version', { ...valid, schema_version: 2 }],
    ['short HEAD', { ...valid, head: 'abc' }],
    ['non-boolean completion', { ...valid, completed: 'yes' }],
    ['plaintext root', { ...valid, walkthroughRoot: '/captures/walkthrough' }],
    ['no roots', { ...valid, walkthroughRoot: null, screenRoots: [] }],
    ['extra prose', { ...valid, findings: 'reviewer output' }],
    ['missing key', { schema_version: 1, head: headA, completed: true }],
  ]
  for (const [name, value] of faults) {
    writeFileSync(
      path,
      typeof value === 'string' ? value : JSON.stringify(value),
    )
    assert.equal(readCritiqueRecord(path), undefined, name)
  }
  writeFileSync(path, JSON.stringify({ ...valid, completed: false }))
  assert.equal(readCritiqueRecord(path).completed, false)
  assert.equal(readCritiqueRecord(join(repo, 'absent.json')), undefined)
})

test('a failed replacement keeps the previous record', (t) => {
  const { repo, runIn } = repository(t)
  const run = runIn(repo)
  const path = writeCritiqueRecord(record(headA), { run, repo })
  const directory = dirname(path)
  chmodSync(directory, 0o500)
  try {
    try {
      writeFileSync(join(directory, 'probe'), '')
      rmSync(join(directory, 'probe'))
      t.skip('directory permissions are not enforced for this user')
      return
    } catch (error) {
      if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error
    }
    assert.throws(() => writeCritiqueRecord(record(headB), { run, repo }), {
      code: /^(?:EACCES|EPERM)$/u,
    })
    assert.equal(readCritiqueRecord(path).head, headA)
    assert.deepEqual(readdirSync(directory), [basename(path)])
  } finally {
    chmodSync(directory, 0o700)
  }
})
