import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  inspectMetadata,
  inspectTree,
  outgoingCommits,
  parsePrePushInput,
  parseTree,
  inspectCommitRange,
  assertProposalOnly,
  validateBoundaryManifest,
  checkStandalone,
  guardPush,
  loadBoundaryManifest,
} from './public-development-guard.mjs'

const manifest = {
  exported: [
    'package.json',
    'README.md',
    '.github/workflows/public-ci.yml',
    'proposals/a.md',
  ],
  prefixes: [{ path: 'proposals/', classification: 'public-only' }],
  classifications: {
    canonical: ['README.md'],
    'private-overlay': ['package.json'],
    'public-only': ['.github/workflows/public-ci.yml'],
  },
}
test('boundary manifest classifies every export exactly once', () => {
  assert.doesNotThrow(() => validateBoundaryManifest(manifest))
  assert.throws(
    () =>
      validateBoundaryManifest({
        ...manifest,
        classifications: {
          ...manifest.classifications,
          canonical: ['README.md', 'package.json'],
        },
      }),
    { code: 'duplicate-boundary-path', subject: 'package.json' },
  )
  assert.throws(
    () =>
      validateBoundaryManifest({
        ...manifest,
        exported: [...manifest.exported, 'secret.txt'],
      }),
    { code: 'unclassified-exported-path', subject: 'secret.txt' },
  )
})

test('prefix exclusions remain outside the public boundary', () => {
  const boundary = loadBoundaryManifest(process.cwd())
  const excludedPaths = boundary.prefixes.flatMap(
    ({ exclusions: prefixExclusions = [] }) => prefixExclusions,
  )
  assert.ok(excludedPaths.length > 0)
  for (const file of excludedPaths)
    assert.throws(() => inspectTree([{ path: file, mode: 'file' }], boundary), {
      code: 'outside-manifest',
      subject: file,
    })
})

test('boundary manifest rejects exclusions for unknown prefixes', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-exclusions-'))
  fs.mkdirSync(path.join(repo, 'config'))
  fs.copyFileSync(
    path.join('config', 'repository-boundary.json'),
    path.join(repo, 'config', 'repository-boundary.json'),
  )
  const boundaryPath = path.join(repo, 'config', 'repository-boundary.json')
  const boundary = JSON.parse(fs.readFileSync(boundaryPath, 'utf8'))
  boundary.canonical_prefix_exclusions['unknown/'] = ['file']
  fs.writeFileSync(boundaryPath, JSON.stringify(boundary))
  assert.throws(() => loadBoundaryManifest(repo), {
    code: 'unknown-prefix-exclusion',
    subject: 'unknown/',
  })
})
test('private-overlay is an allowed public-tree file and private paths are rejected', () => {
  assert.equal(
    inspectTree([{ path: 'package.json', mode: 'file' }], manifest)[0]
      .classification,
    'private-overlay',
  )
  assert.throws(
    () => inspectTree([{ path: '.ops.vars', mode: 'file' }], manifest),
    {
      code: 'outside-manifest',
      subject: '.ops.vars',
    },
  )
})
test('symlink and submodule trees are rejected', () => {
  assert.throws(
    () => inspectTree([{ path: 'README.md', mode: 'symlink' }], manifest),
    { code: 'unsafe-tree-entry', subject: 'README.md', mode: 'symlink' },
  )
  assert.throws(
    () => inspectTree([{ path: 'README.md', mode: 'submodule' }], manifest),
    { code: 'unsafe-tree-entry', subject: 'README.md', mode: 'submodule' },
  )
})
test('forbidden metadata is rejected while public metadata is allowed', () => {
  for (const value of [
    `fix (${'#'}1485)`,
    ['https://github.com', 'techtalkjp/artifactshare', 'issues/1'].join('/'),
    ['https://artifactshare.com', 'a', 'qw1jvt55i8'].join('/'),
    'artifactshare.internal',
    'pnpm deploy',
  ])
    assert.throws(() => inspectMetadata(value), { code: 'forbidden-metadata' })
  for (const value of [
    'fix parser',
    ['https://github.com', 'artifactshare/artifactshare', 'pull/1'].join('/'),
    'React Router merge queue',
  ])
    assert.doesNotThrow(() => inspectMetadata(value))
})
test('pre-push handles initial, multiple, merge, force-push, and deletion updates', () => {
  const z = '0'.repeat(40)
  const updates = parsePrePushInput(
    [
      `refs/heads/main ${'a'.repeat(40)} refs/heads/main ${z}`,
      `refs/heads/feature ${'b'.repeat(40)} refs/heads/feature ${'c'.repeat(40)}`,
      `refs/heads/merge ${'d'.repeat(40)} refs/heads/merge ${'e'.repeat(40)}`,
      `refs/heads/old ${z} refs/heads/old ${'f'.repeat(40)}`,
    ].join('\n'),
  )
  const ranges = []
  const commits = outgoingCommits(updates, 'origin', (args) => {
    ranges.push(args)
    return 'merge\nchild\n'
  })
  assert.deepEqual(ranges, [
    ['rev-list', '--reverse', 'a'.repeat(40), '--not', '--remotes=origin'],
    ['rev-list', '--reverse', 'b'.repeat(40), '--not', '--remotes=origin'],
    ['rev-list', '--reverse', 'd'.repeat(40), '--not', '--remotes=origin'],
  ])
  assert.deepEqual(commits, ['merge', 'child'])
})

test('baseline manifest comes from the base commit even when the trusted tip diverges', () => {
  // The trusted tip carries a manifest that classifies nothing, so any code
  // path that reads the baseline from the tip working tree instead of the
  // base commit fails on README.md being outside every manifest path.
  const tip = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-tip-'))
  fs.mkdirSync(path.join(tip, 'config'))
  fs.writeFileSync(
    path.join(tip, 'config/repository-boundary.json'),
    JSON.stringify({ schema_version: 1, canonical_prefixes: [], paths: [] }),
  )
  // Scan policy is read from the tip by design; give it the real config.
  fs.copyFileSync(
    'config/public-repository-scan.json',
    path.join(tip, 'config/public-repository-scan.json'),
  )
  const source = fs.readFileSync('config/repository-boundary.json', 'utf8')
  const git = (args) => {
    if (args[0] === 'rev-list') return 'a'.repeat(40)
    if (args[0] === 'diff') return ''
    if (
      args[0] === 'show' &&
      String(args[1]).endsWith(':config/repository-boundary.json')
    )
      return source
    if (args[0] === 'show') return 'safe commit'
    return '100644 blob ' + 'b'.repeat(40) + '\tREADME.md\n'
  }
  assert.doesNotThrow(() =>
    inspectCommitRange({
      base: 'c'.repeat(40),
      head: 'd'.repeat(40),
      git,
      manifestRepo: tip,
      headRepoFullName: 'artifactshare/artifactshare',
      baseRepoFullName: 'artifactshare/artifactshare',
    }),
  )
})

test('commits already on the trusted tip are not re-scanned', () => {
  const merged = 'a'.repeat(40)
  const own = 'b'.repeat(40)
  const base = 'c'.repeat(40)
  const head = 'd'.repeat(40)
  const trusted = 'e'.repeat(40)
  const metadataShows = []
  const git = (args) => {
    if (args[0] === 'rev-list' && args.includes('--not')) return `${own}\n`
    if (args[0] === 'rev-list') return `${merged}\n${own}\n`
    if (args[0] === 'diff') return ''
    if (
      args[0] === 'show' &&
      String(args[1]).endsWith(':config/repository-boundary.json')
    )
      return fs.readFileSync('config/repository-boundary.json', 'utf8')
    if (args[0] === 'show') {
      metadataShows.push(args.at(-1))
      return 'safe commit'
    }
    return '100644 blob ' + 'f'.repeat(40) + '\tREADME.md\n'
  }
  inspectCommitRange({
    base,
    head,
    git,
    trustedHead: trusted,
    headRepoFullName: 'artifactshare/artifactshare',
    baseRepoFullName: 'artifactshare/artifactshare',
  })
  // Only the PR's own commit has its message (and content) inspected; the
  // commit merged in from the trusted tip is skipped.
  assert.deepEqual(metadataShows, [own])
})

test('maintainer CI range inspects metadata and the final tree', () => {
  const calls = []
  const git = (args) => {
    calls.push(args)
    if (args[0] === 'rev-list' && args[1] === '--parents')
      return `${'a'.repeat(40)} ${'c'.repeat(40)}`
    if (args[0] === 'rev-list') return 'a'.repeat(40)
    if (args[0] === 'diff') return ''
    if (
      args[0] === 'show' &&
      String(args[1]).endsWith(':config/repository-boundary.json')
    )
      return fs.readFileSync('config/repository-boundary.json', 'utf8')
    if (args[0] === 'show') return 'safe commit'
    return '100644 blob ' + 'b'.repeat(40) + '\tREADME.md\n'
  }
  assert.deepEqual(
    inspectCommitRange({
      base: 'c'.repeat(40),
      head: 'd'.repeat(40),
      git,
      headRepoFullName: 'artifactshare/artifactshare',
      baseRepoFullName: 'artifactshare/artifactshare',
    }),
    ['a'.repeat(40)],
  )
  assert.deepEqual(
    calls.map((args) => args[0]),
    // The extra leading 'show' reads the baseline manifest at the base sha;
    // the second 'rev-list' resolves the commit's parents for its own diff.
    [
      'rev-list',
      'diff',
      'show',
      'ls-tree',
      'ls-tree',
      'rev-list',
      'diff',
      'show',
      'ls-tree',
    ],
  )
  assert.deepEqual(
    parseTree('120000 blob ' + 'b'.repeat(40) + '\tREADME.md')[0].mode,
    'symlink',
  )
})

test('external CI rejects a symlink removed before the proposal-only head', () => {
  const first = 'a'.repeat(40)
  const second = 'b'.repeat(40)
  const third = 'd'.repeat(40)
  const base = 'c'.repeat(40)
  const parents = { [first]: base, [second]: first, [third]: second }
  const git = (args) => {
    if (args[0] === 'rev-list' && args[1] === '--parents')
      return `${args.at(-1)} ${parents[args.at(-1)]}`
    if (args[0] === 'rev-list') return `${first}\n${second}\n${third}\n`
    if (args[0] === 'diff') {
      const range = `${args.at(-2)}..${args.at(-1)}`
      if (range === `${base}..${third}`) return 'A\tproposals/idea.md\n'
      if (range === `${base}..${first}`) return 'A\tproposals/leak.md\n'
      if (range === `${first}..${second}`) return 'D\tproposals/leak.md\n'
      if (range === `${second}..${third}`) return 'A\tproposals/idea.md\n'
    }
    if (args[0] === 'show' && args[1] === `${first}:proposals/leak.md`)
      return 'safe-target'
    if (
      args[0] === 'show' &&
      String(args[1]).endsWith(':config/repository-boundary.json')
    )
      return fs.readFileSync('config/repository-boundary.json', 'utf8')
    if (args[0] === 'show') return 'safe commit'
    if (args[0] === 'ls-tree' && args.at(-1) === base)
      return '100644 blob ' + 'e'.repeat(40) + '\tREADME.md\n'
    if (args[0] === 'ls-tree' && args.at(-1) === third)
      return (
        '100644 blob ' +
        'e'.repeat(40) +
        '\tREADME.md\n100644 blob ' +
        'f'.repeat(40) +
        '\tproposals/idea.md\n'
      )
    if (args[0] === 'ls-tree' && args.at(-1) === first)
      return (
        '100644 blob ' +
        'e'.repeat(40) +
        '\tREADME.md\n120000 blob ' +
        'f'.repeat(40) +
        '\tproposals/leak.md\n'
      )
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }
  assert.throws(() => inspectCommitRange({ base, head: third, git }), {
    code: 'unsafe-tree-entry',
    subject: 'proposals/leak.md',
    mode: 'symlink',
  })
})

test('CI range rejects forbidden content removed by a later commit', () => {
  const first = 'a'.repeat(40)
  const second = 'b'.repeat(40)
  const base = 'c'.repeat(40)
  const parents = { [first]: base, [second]: first }
  const git = (args) => {
    if (args[0] === 'rev-list' && args[1] === '--parents')
      return `${args.at(-1)} ${parents[args.at(-1)]}`
    if (args[0] === 'rev-list') return `${first}\n${second}\n`
    if (args[0] === 'ls-tree')
      return '100644 blob ' + 'd'.repeat(40) + '\tREADME.md\n'
    if (args[0] === 'diff') {
      const range = `${args.at(-2)}..${args.at(-1)}`
      if (range === `${base}..${second}`) return ''
      if (range === `${base}..${first}`) return 'A\tproposals/leak.md\n'
      if (range === `${first}..${second}`) return 'D\tproposals/leak.md\n'
    }
    if (args[0] === 'show' && args[1] === `${first}:proposals/leak.md`)
      return 'https://github.com/example/internal/' + 'issues/123'
    if (
      args[0] === 'show' &&
      String(args[1]).endsWith(':config/repository-boundary.json')
    )
      return fs.readFileSync('config/repository-boundary.json', 'utf8')
    if (args[0] === 'show') return 'safe commit'
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }
  assert.throws(
    () =>
      inspectCommitRange({
        base,
        head: second,
        git,
        headRepoFullName: 'artifactshare/artifactshare',
        baseRepoFullName: 'artifactshare/artifactshare',
      }),
    {
      code: 'changed-content-finding',
      subject: 'proposals/leak.md',
      category: 'private-reference',
    },
  )
})

test('external PRs may only add one root-level proposal document', () => {
  assert.doesNotThrow(() =>
    assertProposalOnly([{ status: 'A', path: 'proposals/idea.md' }]),
  )
  for (const changed of [
    [{ status: 'M', path: 'README.md' }],
    [{ status: 'M', path: 'config/repository-boundary.json' }],
    [
      { status: 'A', path: 'proposals/a.md' },
      { status: 'A', path: 'proposals/b.md' },
    ],
  ])
    assert.throws(() => assertProposalOnly(changed), {
      code: 'proposal-document-only',
    })
})

test('standalone check classifies the current repository tree', () => {
  assert.ok(checkStandalone(process.cwd()).length > 0)
  assert.doesNotThrow(() =>
    execFileSync('node', ['scripts/public-development-guard.mjs', '--check']),
  )
  assert.throws(
    () =>
      execFileSync('node', [
        'scripts/public-development-guard.mjs',
        '--check',
        '--remote',
        'origin',
      ]),
    /unknown option/,
  )
  assert.throws(
    () =>
      execFileSync('node', [
        'scripts/public-development-guard.mjs',
        '--remote',
      ]),
    /remote option requires a value/,
  )
})

test('default guardPush implementation passes a real temporary repository', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'public-guard-'))
  const original = process.cwd()
  try {
    fs.mkdirSync(path.join(repo, 'config'))
    for (const file of [
      'config/repository-boundary.json',
      'config/public-repository-scan.json',
    ])
      fs.copyFileSync(path.join(original, file), path.join(repo, file))
    fs.writeFileSync(path.join(repo, 'README.md'), 'safe\n')
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repo,
    })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'safe commit'], { cwd: repo })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim()
    process.chdir(repo)
    assert.doesNotThrow(() =>
      guardPush({
        input: `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`,
        branch: 'main',
      }),
    )

    fs.rmSync(path.join(repo, 'README.md'))
    fs.symlinkSync('target', path.join(repo, 'README.md'))
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'symlink'], { cwd: repo })
    const symlinkHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim()
    assert.throws(
      () =>
        guardPush({
          input: `refs/heads/main ${symlinkHead} refs/heads/main ${'0'.repeat(40)}\n`,
          branch: 'main',
        }),
      { code: 'unsafe-tree-entry', subject: 'README.md', mode: 'symlink' },
    )

    // A fresh branch off the safe commit: the push range must carry only the
    // private path, not the symlink from the branch above.
    execFileSync('git', ['checkout', '-q', '-b', 'private', head], {
      cwd: repo,
    })
    fs.writeFileSync(path.join(repo, '.ops.vars'), 'private\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'private path'], { cwd: repo })
    const privateHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim()
    assert.throws(
      () =>
        guardPush({
          input: `refs/heads/main ${privateHead} refs/heads/main ${'0'.repeat(40)}\n`,
          branch: 'main',
        }),
      { code: 'outside-manifest', subject: '.ops.vars' },
    )

    execFileSync('git', ['checkout', '-q', '-b', 'metadata', head], {
      cwd: repo,
    })
    execFileSync(
      'git',
      ['commit', '--allow-empty', '-qm', `fix (${'#'}1485)`],
      {
        cwd: repo,
      },
    )
    const metadataHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim()
    assert.throws(
      () =>
        guardPush({
          input: `refs/heads/main ${metadataHead} refs/heads/main ${'0'.repeat(40)}\n`,
          branch: 'main',
        }),
      (error) =>
        error.code === 'forbidden-metadata' &&
        error.message.includes(
          `issue-reference: found \`${'#'}1485\`; remove \`${'#'}1485\` and state the fact in words`,
        ) &&
        error.message.includes(`rewrite commit ${metadataHead.slice(0, 12)}`),
    )
  } finally {
    process.chdir(original)
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('metadata files can be checked on their own before a pull request is opened', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-metadata-'))
  const run = (body) => {
    const file = path.join(directory, 'pr.txt')
    fs.writeFileSync(file, body)
    return spawnSync(
      process.execPath,
      ['scripts/public-development-guard.mjs', '--metadata-file', file],
      { encoding: 'utf8' },
    )
  }
  try {
    let result = run(
      'feat(cli): add a flag\n\nThe flag replaces the old one.\n',
    )
    assert.equal(result.status, 0, result.stderr)

    result = run(`fix(web): close the gap\n\nFollows ${'#'}123.\n`)
    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      [
        'forbidden-metadata: pull request',
        `  issue-reference: found \`${'#'}123\`; remove \`${'#'}123\` and state the fact in words`,
        '  fix: edit the pull request title or body, then rerun the check',
        '',
      ].join('\n'),
    )

    result = spawnSync(
      process.execPath,
      ['scripts/public-development-guard.mjs', '--metadata-file', '--other'],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /metadata-file value is required/u)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('boundary errors name the violation, the matched path, and the fix', () => {
  for (const [check, code, subject, fix] of [
    [
      () => inspectTree([{ path: '.ops.vars', mode: 'file' }], manifest),
      'outside-manifest',
      '.ops.vars',
      /fix: add the path to canonical .* in config\/repository-boundary\.json/u,
    ],
    [
      () => inspectTree([{ path: 'README.md', mode: 'symlink' }], manifest),
      'unsafe-tree-entry',
      'README.md',
      /fix: replace the symlink with a regular file/u,
    ],
    [
      () => assertProposalOnly([{ status: 'M', path: 'README.md' }]),
      'proposal-document-only',
      undefined,
      /fix: an external pull request may add one proposals/u,
    ],
  ])
    assert.throws(check, (error) => {
      const [first, ...rest] = error.message.split('\n')
      assert.equal(first, subject ? `${code}: ${subject}` : code)
      assert.match(rest.join('\n'), fix)
      return true
    })
})
