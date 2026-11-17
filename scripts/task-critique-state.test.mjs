import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
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
import { gitCommonDir, roundsPath } from './review-rounds.mjs'
import {
  captureRootIdentity,
  critiqueRecord,
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
  const commonDirOf = (cwd) => gitCommonDir(runIn(cwd), cwd)
  return { parent, repo, git, runIn, commonDirOf }
}

function record(head, roots = { walkthroughRoot: '/captures/walkthrough' }) {
  return critiqueRecord({ head, completed: true, ...roots })
}

test('linked worktrees share a branch record in the Git common directory', (t) => {
  const { parent, repo, git, runIn, commonDirOf } = repository(t)
  const linked = join(parent, 'linked')
  git(repo, 'worktree', 'add', '--quiet', '-b', 'topic', linked)

  const written = writeCritiqueRecord(record(headA), {
    commonDir: commonDirOf(linked),
    branch: 'topic',
  })
  assert.equal(dirname(dirname(dirname(written))), join(repo, '.git'))

  // The main worktree reports a relative `.git`; it resolves against `repo`.
  assert.equal(runIn(repo)('git', ['rev-parse', '--git-common-dir']), '.git')
  const fromMain = critiqueStatePath(commonDirOf(repo), 'topic')
  assert.equal(fromMain, written)
  assert.deepEqual(readCritiqueRecord(fromMain), record(headA))
  // The review rounds resolve under the same shared directory.
  assert.equal(
    dirname(dirname(dirname(roundsPath('topic', 'codex', runIn(linked))))),
    join(repo, '.git'),
  )
})

test('records are isolated by branch and keep only the latest record', (t) => {
  const { repo, commonDirOf } = repository(t)
  const commonDir = commonDirOf(repo)
  const pathFor = (branch) => critiqueStatePath(commonDir, branch)
  writeCritiqueRecord(record(headA), { commonDir, branch: 'main' })
  writeCritiqueRecord(record(headB), { commonDir, branch: 'fix/a-b' })

  assert.equal(readCritiqueRecord(pathFor('main')).head, headA)
  assert.equal(readCritiqueRecord(pathFor('fix/a-b')).head, headB)
  assert.equal(readCritiqueRecord(pathFor('fix_a-b')), undefined)

  writeCritiqueRecord(record(headB), { commonDir, branch: 'main' })
  assert.equal(readCritiqueRecord(pathFor('main')).head, headB)
  assert.equal(readdirSync(dirname(pathFor('main'))).length, 2)
})

test('stores allowlisted keys and hashed roots with private modes', (t) => {
  const { repo, commonDirOf } = repository(t)
  const walkthroughRoot = join(repo, 'private-walkthrough-root')
  const screenRoot = join(repo, 'private-screen-root')
  const path = writeCritiqueRecord(
    critiqueRecord({
      head: headA,
      completed: false,
      walkthroughRoot,
      screenRoots: [screenRoot],
    }),
    { commonDir: commonDirOf(repo), branch: 'topic' },
  )
  const text = readFileSync(path, 'utf8')
  assert.deepEqual(JSON.parse(text), {
    schema_version: 1,
    head: headA,
    completed: false,
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
  const { repo, commonDirOf } = repository(t)
  const path = writeCritiqueRecord(record(headA), {
    commonDir: commonDirOf(repo),
    branch: 'topic',
  })
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
  assert.equal(readCritiqueRecord(join(repo, 'absent.json')), undefined)
})

test('a failed replacement keeps the previous record', (t) => {
  const { repo, commonDirOf } = repository(t)
  const commonDir = commonDirOf(repo)
  const path = writeCritiqueRecord(record(headA), {
    commonDir,
    branch: 'topic',
  })
  const failure = Object.assign(new Error('rename failed'), { code: 'EIO' })
  assert.throws(
    () =>
      writeCritiqueRecord(record(headB), {
        commonDir,
        branch: 'topic',
        rename: () => {
          throw failure
        },
      }),
    failure,
  )
  assert.equal(readCritiqueRecord(path).head, headA)
  assert.deepEqual(readdirSync(dirname(path)), [basename(path)])
})
