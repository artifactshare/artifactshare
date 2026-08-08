import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'

const setup = path.join(process.cwd(), 'scripts/public-hook-setup.mjs')
const git = (cwd, args, input) =>
  execFileSync('git', args, { cwd, input, encoding: 'utf8' })

function initRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'public-hook-'))
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'safe\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'initial'])
  return repo
}

test('setup installs executable hook in clone and worktree, preserving forwarding', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'public-hook-bare-'))
  const clone = path.join(bare, 'clone')
  git(bare, ['init', '--bare', '-q', 'origin.git'])
  const source = initRepo()
  git(source, ['remote', 'add', 'origin', path.join(bare, 'origin.git')])
  git(source, ['push', '-q', '-u', 'origin', 'HEAD'])
  git(bare, ['clone', '-q', 'origin.git', clone])
  const worktree = path.join(clone, 'worktree')
  git(clone, ['worktree', 'add', '-q', worktree, '-b', 'work'])
  for (const repo of [clone, worktree]) {
    execFileSync(process.execPath, [setup], { cwd: repo })
    const hooks = git(repo, ['rev-parse', '--git-path', 'hooks']).trim()
    const hook = path.resolve(repo, hooks, 'pre-push')
    assert.equal(fs.statSync(hook).mode & 0o111, 0o111)
    assert.match(fs.readFileSync(hook, 'utf8'), /--remote "\$1"/)
  }
  fs.rmSync(bare, { recursive: true, force: true })
  fs.rmSync(source, { recursive: true, force: true })
})

test('setup preserves an existing hook and is harmless outside a repository', () => {
  const repo = initRepo()
  const hookDir = path.join(repo, '.git', 'hooks')
  const hook = path.join(hookDir, 'pre-push')
  fs.writeFileSync(hook, '#!/bin/sh\nexit 7\n')
  const before = fs.readFileSync(hook)
  const setupResult = spawnSync(process.execPath, [setup], {
    cwd: repo,
    encoding: 'utf8',
  })
  assert.equal(setupResult.status, 0)
  assert.match(setupResult.stderr, /warning: preserving existing pre-push hook/)
  assert.deepEqual(fs.readFileSync(hook), before)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'public-hook-outside-'))
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, [setup], { cwd: outside }),
  )
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})
