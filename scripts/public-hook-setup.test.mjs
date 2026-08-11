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

function hookPath(repo) {
  return path.resolve(
    repo,
    git(repo, ['rev-parse', '--git-path', 'hooks']).trim(),
    'pre-push',
  )
}

test('installs a checkout-independent boundary-only pre-push hook', () => {
  const repo = initRepo()
  try {
    execFileSync(process.execPath, [setup], { cwd: repo })
    const hook = hookPath(repo)
    const body = fs.readFileSync(hook, 'utf8')
    assert.equal(fs.statSync(hook).mode & 0o111, 0o111)
    assert.match(body, /public-development-guard\.mjs/)
    assert.match(body, /--remote "\$1"/)
    assert.doesNotMatch(body, /pre-push-review-guard|AS_PUSH_AFTER_GO/)
    assert.doesNotMatch(
      body,
      new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('upgrades the old managed review hook and check detects stale state', () => {
  const repo = initRepo()
  try {
    const hook = hookPath(repo)
    fs.writeFileSync(
      hook,
      '#!/bin/sh\n# artifactshare-managed-pre-push\nnode pre-push-review-guard.mjs\n',
    )
    let result = spawnSync(process.execPath, [setup, '--check'], {
      cwd: repo,
      env: { ...process.env, CI: '' },
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    execFileSync(process.execPath, [setup], { cwd: repo })
    result = spawnSync(process.execPath, [setup, '--check'], {
      cwd: repo,
      env: { ...process.env, CI: '' },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0)
    assert.doesNotMatch(fs.readFileSync(hook, 'utf8'), /review-guard/)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('preserves a custom hook', () => {
  const repo = initRepo()
  try {
    const hook = hookPath(repo)
    fs.writeFileSync(hook, '#!/bin/sh\nexit 7\n')
    const before = fs.readFileSync(hook)
    const result = spawnSync(process.execPath, [setup], {
      cwd: repo,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0)
    assert.match(result.stderr, /preserving existing pre-push hook/u)
    assert.deepEqual(fs.readFileSync(hook), before)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('runs only the boundary guard and forwards stdin and remote', () => {
  const repo = initRepo()
  try {
    execFileSync(process.execPath, [setup], { cwd: repo })
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true })
    fs.writeFileSync(
      path.join(repo, 'scripts/public-development-guard.mjs'),
      `import fs from 'node:fs'\nlet input=''\nfor await (const chunk of process.stdin) input += chunk\nfs.writeFileSync(process.env.GUARD_LOG, process.argv.slice(2).join('|') + ':' + input)\n`,
    )
    const log = path.join(repo, 'guard.log')
    const input = 'refs/heads/topic old refs/heads/topic new\n'
    const result = spawnSync(hookPath(repo), ['origin'], {
      cwd: repo,
      env: { ...process.env, GUARD_LOG: log },
      input,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(log, 'utf8'), `--remote|origin:${input}`)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('is harmless outside a repository and skips checks in CI', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'public-hook-outside-'))
  const repo = initRepo()
  try {
    assert.equal(
      spawnSync(process.execPath, [setup], { cwd: outside }).status,
      0,
    )
    const result = spawnSync(process.execPath, [setup, '--check'], {
      cwd: repo,
      env: { ...process.env, CI: '1' },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /skipped in CI/u)
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
