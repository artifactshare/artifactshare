import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import test from 'node:test'
import {
  assertSafeCaptureOutput,
  createCaptureOutput,
  removeCaptureOutput,
  screenCaptureOutputDirectory,
  screenCaptureOutputRoot,
} from './screen-capture-output.mjs'
import { captureRetries, shouldRetryCapture } from './screen-capture.mjs'

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'capture-output-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const primary = join(base, 'primary')
  mkdirSync(primary)
  const git = (cwd, args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git(primary, ['init', '--quiet'])
  git(primary, [
    '-c',
    'user.name=Capture Test',
    '-c',
    'user.email=capture@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'fixture',
  ])
  return { base, primary, git }
}

test('primary and linked worktrees write to distinct deterministic roots outside each checkout', (t) => {
  const { base, primary, git } = fixture(t)
  const linked = join(base, 'linked')
  git(primary, ['worktree', 'add', '--quiet', '--detach', linked])
  const roots = [primary, linked].map((checkout) => {
    const run = (file, args) => {
      assert.equal(file, 'git')
      return git(checkout, args)
    }
    const root = screenCaptureOutputRoot(run)
    const gitDir = git(checkout, ['rev-parse', '--absolute-git-dir'])
    assert.equal(
      root,
      join(
        dirname(checkout),
        `.${basename(checkout)}-screen-captures`,
        createHash('sha256').update(gitDir).digest('hex'),
      ),
    )
    assert.equal(screenCaptureOutputRoot(run), root)
    assert.ok(relative(checkout, root).startsWith(`..${sep}`))
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'capture.png'), 'capture')
    assert.equal(
      git(checkout, ['status', '--porcelain', '--untracked-files=all']),
      '',
    )
    return root
  })
  assert.notEqual(roots[0], roots[1])
})

test('legacy captures remain intact and ignored after updating the ignore rules', (t) => {
  const { primary, git } = fixture(t)
  copyFileSync(
    new URL('../.gitignore', import.meta.url),
    join(primary, '.gitignore'),
  )
  git(primary, ['add', '.gitignore'])
  git(primary, [
    '-c',
    'user.name=Capture Test',
    '-c',
    'user.email=capture@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'current ignore rules',
  ])
  for (const legacy of ['screen-captures', '.tmp-task-walkthrough']) {
    mkdirSync(join(primary, legacy))
    writeFileSync(join(primary, legacy, 'evidence.json'), 'legacy evidence')
  }
  const root = screenCaptureOutputRoot((_file, args) => git(primary, args))
  mkdirSync(join(root, 'new-label'), { recursive: true })
  writeFileSync(join(root, 'new-label', 'evidence.json'), 'new evidence')
  assert.equal(
    git(primary, ['status', '--porcelain', '--untracked-files=all']),
    '',
  )
  for (const legacy of ['screen-captures', '.tmp-task-walkthrough']) {
    assert.equal(
      readFileSync(join(primary, legacy, 'evidence.json'), 'utf8'),
      'legacy evidence',
    )
    assert.equal(
      git(primary, ['check-ignore', `${legacy}/evidence.json`]),
      `${legacy}/evidence.json`,
    )
  }
  // Compatibility is restricted to the two old root-level directories.
  mkdirSync(join(primary, 'nested', 'screen-captures'), { recursive: true })
  writeFileSync(
    join(primary, 'nested', 'screen-captures', 'evidence.json'),
    'visible',
  )
  assert.match(
    git(primary, ['status', '--porcelain', '--untracked-files=all']),
    /nested\/screen-captures\/evidence.json/,
  )
})

test('rejects a checkout at the filesystem root', () => {
  assert.throws(
    () =>
      screenCaptureOutputRoot((_file, args) =>
        args.includes('--show-toplevel') ? '/' : '/.git',
      ),
    /filesystem root/,
  )
})

test('preserves an explicitly injected screen capture output root', () => {
  assert.equal(
    screenCaptureOutputDirectory('before', '/tmp/explicit-captures'),
    join('/tmp/explicit-captures', 'before'),
  )
})

test('reads the retry budget from the environment', () => {
  assert.equal(captureRetries({}), 2)
  assert.equal(captureRetries({ SCREEN_CAPTURE_RETRIES: '0' }), 0)
  assert.equal(captureRetries({ SCREEN_CAPTURE_RETRIES: '3' }), 3)
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: '-1' }))
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: 'many' }))
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: '1e3' }))
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: '11' }))
})

test('retries only readiness timeouts within the budget', () => {
  const timeout = { kind: 'readiness_timeout' }
  assert.equal(shouldRetryCapture(timeout, 0, 2, true), true)
  assert.equal(shouldRetryCapture(timeout, 1, 2, true), true)
  assert.equal(shouldRetryCapture(timeout, 2, 2, true), false)
  assert.equal(shouldRetryCapture(timeout, 0, 0, true), false)
  assert.equal(shouldRetryCapture({ kind: 'navigation' }, 0, 2, true), false)
  // A readiness timeout after an interaction is the interaction's fault.
  assert.equal(shouldRetryCapture(timeout, 0, 2, false), false)
})

test('rejects output roots overlapping a registered worktree before removal or creation', async (t) => {
  const { base, primary, git } = fixture(t)
  mkdirSync(join(primary, 'docs'))
  writeFileSync(join(primary, 'docs', 'tracked.txt'), 'preserve')
  git(primary, ['add', 'docs'])
  git(primary, [
    '-c',
    'user.name=Capture Test',
    '-c',
    'user.email=capture@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'tracked fixture',
  ])
  const run = (_file, args) => git(primary, args)
  const root = screenCaptureOutputRoot(run)
  assert.doesNotThrow(() => assertSafeCaptureOutput([root], run))
  // Register the collision after resolving/preflighting the deterministic root.
  git(primary, ['worktree', 'add', '--quiet', '--detach', root])
  const alias = join(base, 'alias')
  symlinkSync(root, alias)
  for (const candidate of [
    root,
    dirname(root),
    join(root, 'docs'),
    alias,
    primary,
  ]) {
    const target = join(candidate, 'docs')
    await assert.rejects(
      removeCaptureOutput(candidate, target, run),
      /overlaps a registered worktree/,
    )
    await assert.rejects(
      createCaptureOutput(candidate, join(candidate, 'new-output'), run),
      /overlaps a registered worktree/,
    )
  }
  // A cleanup target can independently alias a worktree under a safe root.
  const safeRoot = join(base, 'safe-output')
  mkdirSync(safeRoot)
  const cleanupAlias = join(safeRoot, 'docs')
  symlinkSync(root, cleanupAlias)
  await assert.rejects(
    removeCaptureOutput(safeRoot, cleanupAlias, run),
    /overlaps a registered worktree/,
  )
  await assert.rejects(
    createCaptureOutput(safeRoot, cleanupAlias, run),
    /overlaps a registered worktree/,
  )
  assert.equal(
    readFileSync(join(root, 'docs', 'tracked.txt'), 'utf8'),
    'preserve',
  )
  assert.equal(git(root, ['status', '--porcelain']), '')
  assert.equal(git(primary, ['status', '--porcelain']), '')
  // Explicit external injection and label-scoped replacement still work.
  await createCaptureOutput(safeRoot, join(safeRoot, 'before'), run)
  writeFileSync(join(safeRoot, 'before', 'keep.txt'), 'keep')
  await createCaptureOutput(safeRoot, join(safeRoot, 'after'), run)
  await removeCaptureOutput(safeRoot, join(safeRoot, 'after'), run)
  assert.equal(
    readFileSync(join(safeRoot, 'before', 'keep.txt'), 'utf8'),
    'keep',
  )
})
