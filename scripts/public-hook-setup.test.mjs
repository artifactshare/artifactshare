import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'

const setup = path.join(process.cwd(), 'scripts/public-hook-setup.mjs')
const git = (cwd, args, input) =>
  execFileSync('git', args, { cwd, input, encoding: 'utf8' })

function copyFromCheckout(repo, files) {
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.copyFileSync(path.join(process.cwd(), file), path.join(repo, file))
  }
}

function writeFakeGuard(repo, source) {
  copyFromCheckout(repo, ['scripts/pre-push.mjs'])
  fs.writeFileSync(
    path.join(repo, 'scripts/public-development-guard.mjs'),
    source,
  )
}

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

test('installs a checkout-independent pre-push hook', () => {
  const repo = initRepo()
  try {
    execFileSync(process.execPath, [setup], { cwd: repo })
    const hook = hookPath(repo)
    const body = fs.readFileSync(hook, 'utf8')
    assert.equal(fs.statSync(hook).mode & 0o111, 0o111)
    assert.match(body, /exec node "\$repo_root\/scripts\/pre-push\.mjs" "\$@"/)
    assert.doesNotMatch(body, /pnpm/)
    assert.doesNotMatch(
      body,
      new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
    const result = spawnSync(hook, ['origin'], {
      cwd: repo,
      input: '',
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(
      result.stderr,
      /pre-push\.mjs and scripts\/public-development-guard\.mjs are missing/u,
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

test('replaces a managed hook that embeds the checks', () => {
  const repo = initRepo()
  try {
    const hook = hookPath(repo)
    fs.writeFileSync(
      hook,
      '#!/bin/sh\n# artifactshare-managed-pre-push\npnpm -s format\nnode "$repo_root/scripts/public-development-guard.mjs" --remote "$1"\n',
    )
    const check = () =>
      spawnSync(process.execPath, [setup, '--check'], {
        cwd: repo,
        env: { ...process.env, CI: '' },
        encoding: 'utf8',
      })
    assert.match(check().stderr, /public hook is stale/u)
    execFileSync(process.execPath, [setup], { cwd: repo })
    assert.equal(check().status, 0)
    assert.match(fs.readFileSync(hook, 'utf8'), /scripts\/pre-push\.mjs/u)
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

test('runs the boundary guard and forwards stdin and remote', () => {
  const repo = initRepo()
  try {
    execFileSync(process.execPath, [setup], { cwd: repo })
    writeChecks(repo, { format: 0, lint: 0 })
    writeFakeGuard(
      repo,
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

function writeChecks(repo, { format, lint }) {
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({
      name: 'hook-fixture',
      private: true,
      scripts: {
        format: `node -e "process.exit(${format})"`,
        lint: `node -e "process.exit(${lint})"`,
      },
    }),
  )
}

for (const [name, checks, message] of [
  ['formatting', { format: 1, lint: 0 }, /formatting differs/u],
  ['lint', { format: 0, lint: 1 }, /pnpm lint failed/u],
]) {
  test(`refuses a push whose ${name} check fails, before the boundary guard`, () => {
    const repo = initRepo()
    try {
      execFileSync(process.execPath, [setup], { cwd: repo })
      writeChecks(repo, checks)
      writeFakeGuard(
        repo,
        `import fs from 'node:fs'\nfs.writeFileSync(process.env.GUARD_LOG, 'ran')\n`,
      )
      const log = path.join(repo, 'guard.log')
      const result = spawnSync(hookPath(repo), ['origin'], {
        cwd: repo,
        env: { ...process.env, GUARD_LOG: log },
        input: '',
        encoding: 'utf8',
      })
      assert.equal(result.status, 1)
      assert.match(result.stderr, message)
      assert.equal(fs.existsSync(log), false)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
}

test('lets a push through when formatting and lint pass', () => {
  const repo = initRepo()
  try {
    execFileSync(process.execPath, [setup], { cwd: repo })
    writeChecks(repo, { format: 0, lint: 0 })
    writeFakeGuard(repo, '')
    const result = spawnSync(hookPath(repo), ['origin'], {
      cwd: repo,
      input: '',
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('git push refuses a commit whose content fails the CI scan, even after a later fix', () => {
  const repo = initRepo()
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'public-hook-remote-'))
  try {
    git(remote, ['init', '-q', '--bare'])
    git(repo, ['remote', 'add', 'origin', remote])
    execFileSync(process.execPath, [setup], { cwd: repo })
    writeChecks(repo, { format: 0, lint: 0 })
    copyFromCheckout(repo, [
      'scripts/pre-push.mjs',
      'scripts/public-development-guard.mjs',
      'scripts/lib/scan-patterns.mjs',
      'config/repository-boundary.json',
      'config/public-repository-scan.json',
    ])
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'add guard'])
    const clean = git(repo, ['rev-parse', 'HEAD']).trim()
    const push = (ref) =>
      spawnSync('git', ['push', '-q', 'origin', ref], {
        cwd: repo,
        encoding: 'utf8',
      })
    git(repo, ['push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/main'])

    const address = ['someone', 'customer.net'].join('@')
    git(repo, ['checkout', '-q', '-b', 'topic'])
    fs.appendFileSync(path.join(repo, 'README.md'), `${address}\n`)
    git(repo, ['commit', '-qam', 'add contact'])
    const leaking = git(repo, ['rev-parse', 'HEAD']).trim()
    fs.writeFileSync(path.join(repo, 'README.md'), 'safe\n')
    git(repo, ['commit', '-qam', 'remove contact'])
    let result = push('topic')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /changed-content-finding: README\.md/u)
    assert.ok(
      result.stderr.includes(`personal-data: found \`${address}\` at line 2`),
      result.stderr,
    )
    assert.ok(
      result.stderr.includes(`rewrite commit ${leaking.slice(0, 12)}`),
      result.stderr,
    )
    assert.equal(git(remote, ['branch', '--list', 'topic']), '')

    git(repo, ['checkout', '-q', '-B', 'topic', clean])
    fs.appendFileSync(path.join(repo, 'README.md'), 'contact: docs\n')
    git(repo, ['commit', '-qam', 'add contact'])
    result = push('topic')
    assert.equal(result.status, 0, result.stderr)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(remote, { recursive: true, force: true })
  }
})

test('falls back to the boundary guard on a branch without scripts/pre-push.mjs', () => {
  const repo = initRepo()
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'public-hook-remote-'))
  try {
    git(remote, ['init', '-q', '--bare'])
    git(repo, ['remote', 'add', 'origin', remote])
    execFileSync(process.execPath, [setup], { cwd: repo })
    copyFromCheckout(repo, [
      'scripts/public-development-guard.mjs',
      'scripts/lib/scan-patterns.mjs',
      'config/repository-boundary.json',
      'config/public-repository-scan.json',
    ])
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'add guard'])
    git(repo, ['push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/main'])
    git(repo, ['checkout', '-q', '-b', 'topic'])
    git(repo, ['commit', '--allow-empty', '-qm', `fix (${'#'}123)`])
    const result = spawnSync('git', ['push', '-q', 'origin', 'topic'], {
      cwd: repo,
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /running only the boundary guard/u)
    assert.ok(
      result.stderr.includes(
        `issue-reference: found \`${'#'}123\`; remove \`${'#'}123\` and state the fact in words`,
      ),
      result.stderr,
    )
    assert.equal(git(remote, ['branch', '--list', 'topic']), '')
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(remote, { recursive: true, force: true })
  }
})
