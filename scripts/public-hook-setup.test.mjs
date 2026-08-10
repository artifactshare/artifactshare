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
  const raw = path.resolve(
    repo,
    git(repo, ['rev-parse', '--git-path', 'hooks']).trim(),
  )
  return path.join(fs.realpathSync(raw), 'pre-push')
}

function writeGuard(repo, name, marker, extra = '') {
  const file = path.join(repo, 'scripts', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node\nimport fs from 'node:fs'\nlet input = ''\nfor await (const chunk of process.stdin) input += chunk\nfs.appendFileSync(process.env.GUARD_LOG, ${JSON.stringify(marker)} + ':' + process.argv.slice(2).join('|') + ':' + input)\n${extra}\n`,
  )
  fs.chmodSync(file, 0o755)
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
    assert.match(fs.readFileSync(hook, 'utf8'), /pre-push-review-guard\.mjs/)
    assert.match(
      fs.readFileSync(hook, 'utf8'),
      /artifactshare-managed-pre-push/,
    )
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

test('setup upgrades the legacy boundary-only hook', () => {
  const repo = initRepo()
  const hook = path.join(repo, '.git', 'hooks', 'pre-push')
  fs.writeFileSync(
    hook,
    '#!/bin/sh\nexec node "/tmp/public-development-guard.mjs" --remote "$1"\n',
  )
  execFileSync(process.execPath, [setup], { cwd: repo })
  const body = fs.readFileSync(hook, 'utf8')
  assert.match(body, /public-development-guard\.mjs/)
  assert.match(body, /pre-push-review-guard\.mjs/)
  fs.rmSync(repo, { recursive: true, force: true })
})

test('check distinguishes missing, current, legacy, stale, and custom without writing', () => {
  const repo = initRepo()
  const hook = path.join(repo, '.git', 'hooks', 'pre-push')
  const runCheck = () =>
    spawnSync(process.execPath, [setup, '--check'], {
      cwd: repo,
      encoding: 'utf8',
    })
  let result = runCheck()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /run node scripts\/public-hook-setup\.mjs/)
  execFileSync(process.execPath, [setup], { cwd: repo })
  result = runCheck()
  assert.equal(result.status, 0)
  const expected = fs.readFileSync(hook)
  fs.writeFileSync(hook, Buffer.concat([expected, Buffer.from('# stale\n')]))
  const staleBefore = fs.readFileSync(hook)
  const staleMode = fs.statSync(hook).mode
  result = runCheck()
  assert.equal(result.status, 1)
  assert.deepEqual(fs.readFileSync(hook), staleBefore)
  assert.equal(fs.statSync(hook).mode, staleMode)
  fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(hook, 0o700)
  const customBefore = fs.readFileSync(hook)
  const customMode = fs.statSync(hook).mode
  result = runCheck()
  assert.equal(result.status, 0)
  assert.match(result.stderr, /preserving custom/)
  assert.deepEqual(fs.readFileSync(hook), customBefore)
  assert.equal(fs.statSync(hook).mode, customMode)
  fs.rmSync(repo, { recursive: true, force: true })
})

test('check skips in CI with visible output and repository outside is harmless', () => {
  const repo = initRepo()
  const result = spawnSync(process.execPath, [setup, '--check'], {
    cwd: repo,
    env: { ...process.env, CI: '1' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /skipped in CI/)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'public-hook-outside-'))
  assert.equal(
    spawnSync(process.execPath, [setup, '--check'], { cwd: outside }).status,
    0,
  )
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

test('managed hook resolves the push source root at runtime and guards may be absent', () => {
  const repo = initRepo()
  execFileSync(process.execPath, [setup], { cwd: repo })
  const hook = path.join(repo, '.git', 'hooks', 'pre-push')
  const body = fs.readFileSync(hook, 'utf8')
  assert.match(body, /git rev-parse --show-toplevel/)
  assert.doesNotMatch(
    body,
    new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  )
  assert.match(body, /missing; skipping/)
  fs.rmSync(path.join(repo, 'scripts'), { recursive: true, force: true })
  const result = spawnSync(hook, ['origin', 'head', 'refs/heads/main'], {
    cwd: repo,
    input: '',
    encoding: 'utf8',
  })
  assert.equal(result.status, 0)
  assert.match(result.stderr, /missing/)
  fs.rmSync(repo, { recursive: true, force: true })
})

test('clone and linked worktree share one canonical, checkout-independent hook', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'public-hook-shared-'))
  const source = initRepo()
  const clone = path.join(base, 'clone')
  try {
    git(base, ['init', '--bare', '-q', 'origin.git'])
    git(source, ['remote', 'add', 'origin', path.join(base, 'origin.git')])
    git(source, ['push', '-q', '-u', 'origin', 'HEAD'])
    git(base, ['clone', '-q', 'origin.git', clone])
    const worktree = path.join(clone, 'linked')
    git(clone, ['worktree', 'add', '-q', worktree, '-b', 'linked'])
    assert.equal(hookPath(clone), hookPath(worktree))
    execFileSync(process.execPath, [setup], { cwd: clone })
    const first = fs.readFileSync(hookPath(clone))
    execFileSync(process.execPath, [setup], { cwd: worktree })
    assert.deepEqual(fs.readFileSync(hookPath(worktree)), first)
    assert.doesNotMatch(
      first.toString(),
      new RegExp(clone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
    assert.doesNotMatch(
      first.toString(),
      new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(source, { recursive: true, force: true })
  }
})

test('shared hook runs guards from the linked worktree and forwards input and remote', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'public-hook-runtime-'))
  const source = initRepo()
  try {
    git(base, ['init', '--bare', '-q', 'origin.git'])
    git(source, ['remote', 'add', 'origin', path.join(base, 'origin.git')])
    git(source, ['push', '-q', '-u', 'origin', 'HEAD'])
    const clone = path.join(base, 'clone')
    git(base, ['clone', '-q', 'origin.git', clone])
    const linked = path.join(clone, 'linked')
    git(clone, ['worktree', 'add', '-q', linked, '-b', 'linked'])
    writeGuard(clone, 'public-development-guard.mjs', 'clone-boundary')
    writeGuard(clone, 'pre-push-review-guard.mjs', 'clone-review')
    writeGuard(linked, 'public-development-guard.mjs', 'linked-boundary')
    writeGuard(linked, 'pre-push-review-guard.mjs', 'linked-review')
    execFileSync(process.execPath, [setup], { cwd: clone })
    const log = path.join(base, 'guards.log')
    const input = 'refs/heads/linked abc refs/heads/main\n'
    const result = spawnSync(hookPath(linked), ['origin', 'head'], {
      cwd: linked,
      env: { ...process.env, GUARD_LOG: log, AS_PUSH_AFTER_GO: '1' },
      input,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const records = fs.readFileSync(log, 'utf8')
    assert.match(
      records,
      /linked-boundary:--remote\|origin:refs\/heads\/linked abc refs\/heads\/main\n/,
    )
    assert.match(
      records,
      /linked-review::refs\/heads\/linked abc refs\/heads\/main\n/,
    )
    assert.doesNotMatch(records, /clone-(?:boundary|review)/)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(source, { recursive: true, force: true })
  }
})

test('missing guards are independent and successful with warnings', () => {
  for (const missing of ['boundary', 'review', 'both']) {
    const repo = initRepo()
    try {
      execFileSync(process.execPath, [setup], { cwd: repo })
      const log = path.join(repo, 'guards.log')
      const hook = hookPath(repo)
      if (missing !== 'boundary' && missing !== 'both')
        writeGuard(repo, 'public-development-guard.mjs', 'boundary')
      if (missing !== 'review' && missing !== 'both')
        writeGuard(repo, 'pre-push-review-guard.mjs', 'review')
      const result = spawnSync(hookPath(repo), ['origin'], {
        cwd: repo,
        env: { ...process.env, GUARD_LOG: log, AS_PUSH_AFTER_GO: '1' },
        input: 'refs/heads/main old refs/heads/main\n',
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, `${missing}: ${result.stderr}`)
      const output = `${result.stdout}${result.stderr}`
      if (missing === 'both') {
        assert.match(output, /skipping boundary guard/)
        assert.match(output, /skipping review guard/)
        assert.equal(fs.existsSync(log), false)
      } else {
        assert.match(output, new RegExp(`skipping ${missing} guard`))
        assert.match(
          fs.readFileSync(log, 'utf8'),
          missing === 'boundary' ? /review/ : /boundary/,
        )
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  }
})

test('state matrix checks without writing and repairs managed states', () => {
  const repo = initRepo()
  const hook = hookPath(repo)
  try {
    const states = [
      [
        'legacy',
        '#!/bin/sh\nexec node public-development-guard.mjs --remote "$1"\n',
        0o700,
        1,
      ],
      [
        'stale',
        '#!/bin/sh\n# artifactshare-managed-pre-push\nstale\n',
        0o640,
        1,
      ],
      [
        'managed-nonexec',
        '#!/bin/sh\n# artifactshare-managed-pre-push\n',
        0o600,
        1,
      ],
      ['current-nonexec', null, 0o640, 1],
      ['current-owner-nonexec', null, 0o655, 1],
      ['custom', '#!/bin/sh\nexit 9\n', 0o701, 0],
    ]
    execFileSync(process.execPath, [setup], { cwd: repo })
    const canonical = fs.readFileSync(hook)
    for (const [name, bytes, mode, status] of states) {
      fs.writeFileSync(hook, bytes ?? canonical)
      fs.chmodSync(hook, mode)
      const before = fs.readFileSync(hook)
      const beforeMode = fs.statSync(hook).mode & 0o777
      const result = spawnSync(process.execPath, [setup, '--check'], {
        cwd: repo,
        encoding: 'utf8',
      })
      assert.equal(result.status, status, name)
      assert.deepEqual(fs.readFileSync(hook), before, name)
      assert.equal(fs.statSync(hook).mode & 0o777, beforeMode, name)
    }
    for (const bytes of [states[0][1], states[1][1], states[2][1]]) {
      fs.writeFileSync(hook, bytes)
      fs.chmodSync(hook, 0o600)
      execFileSync(process.execPath, [setup], { cwd: repo })
      assert.deepEqual(fs.readFileSync(hook), canonical)
      assert.equal(fs.statSync(hook).mode & 0o777, 0o755)
    }
    fs.chmodSync(hook, 0o640)
    execFileSync(process.execPath, [setup], { cwd: repo })
    assert.equal(fs.statSync(hook).mode & 0o777, 0o755)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('package wiring keeps installer and validation contracts', () => {
  const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts
  const installer = fs.readFileSync(setup, 'utf8')
  assert.equal(scripts.prepare, 'node scripts/public-hook-setup.mjs')
  assert.match(scripts['dev:setup'], /^node scripts\/public-hook-setup\.mjs &&/)
  assert.match(scripts['validate:static'], /pnpm check:public-hook(?: &&|$)/)
  assert.match(installer, /process\.platform === 'win32'/)
})
