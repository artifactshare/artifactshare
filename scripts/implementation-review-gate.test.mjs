import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { PassThrough, Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import test from 'node:test'
import {
  appendTail,
  coordinatedBase,
  main,
  parseArgs,
  recordCompletedRounds,
  runReviewer,
  waitForBoth,
  withoutReminder,
  writeText,
} from './implementation-review-gate.mjs'
import { finalReviews } from './agent-role-settings.mjs'
import { reviewReminder } from './codex-review.mjs'
import { readRounds, roundsPath } from './review-rounds.mjs'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)

function contextFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'implementation-context-'))
  const path = join(directory, 'context.txt')
  writeFileSync(
    path,
    'Purpose: verify the final review handoff.\nBoundary: scripts only.\nAcceptance: both reviewers inspect the fixed range.\n\n## Dispositions\n\nNone yet\n',
  )
  return { directory, path }
}

function explicitBaseRun(_file, args) {
  if (args[0] === 'rev-parse' && args[1] === '--verify') return `${base}\n`
  if (args[0] === 'merge-base') return `${base}\n`
  if (args[0] === 'rev-list') return '2'
  throw new Error(`Unexpected git call: ${args.join(' ')}`)
}

test('requires nonempty coordinator context and accepts an explicit base', () => {
  assert.throws(() => parseArgs([]), /--context-file is required/u)
  assert.deepEqual(parseArgs(['--context-file', 'context.txt']), {
    base: undefined,
    contextFile: 'context.txt',
  })
  assert.deepEqual(
    parseArgs(['--base', 'main', '--context-file', 'context.txt']),
    { base: 'main', contextFile: 'context.txt' },
  )
  assert.deepEqual(parseArgs(['--help']), {
    base: undefined,
    contextFile: undefined,
    help: true,
  })
})

test('waits for both reviewers before reporting a failure', async () => {
  let secondFinished = false
  const second = Promise.resolve().then(() => {
    secondFinished = true
    return 'done'
  })
  await assert.rejects(
    () => waitForBoth([Promise.reject(new Error('failed')), second]),
    /failed/u,
  )
  assert.equal(secondFinished, true)
})

test('bounds captured diagnostics and preserves UTF-8 boundaries', () => {
  const capture = appendTail(
    { buffer: Buffer.from('012345'), truncated: false },
    '6789',
    6,
  )
  assert.deepEqual(capture, {
    buffer: Buffer.from('456789'),
    truncated: true,
  })
  const unicode = appendTail(
    { buffer: Buffer.alloc(0), truncated: false },
    '前'.repeat(100),
    17,
  )
  assert.doesNotMatch(unicode.buffer.toString('utf8'), /�/u)
})

test('preserves successful output and bounds failed reviewer diagnostics', async () => {
  const stdout = 'f'.repeat(70 * 1024)
  const stderr = '前'.repeat(30 * 1024)
  const result = await runReviewer('codex', {
    spawnProcess: () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      queueMicrotask(() => {
        child.stdout.end(stdout)
        child.stderr.end(stderr)
        child.emit('close', 0)
      })
      return child
    },
  })
  assert.equal(result.stdout, stdout)
  assert.match(result.stderr, /^\[earlier output omitted\]\n/u)
  assert.doesNotMatch(result.stderr, /�/u)

  await assert.rejects(
    () =>
      runReviewer('claude', {
        spawnProcess: () => {
          const child = new EventEmitter()
          child.stdout = new PassThrough()
          child.stderr = new PassThrough()
          queueMicrotask(() => {
            child.stdout.end()
            child.stderr.end()
            child.emit('close', 0)
          })
          return child
        },
      }),
    /returned no final result/u,
  )
})

test('waits for backpressured result output and reports stream errors', async () => {
  let output = ''
  const stream = new Writable({
    highWaterMark: 16,
    write(chunk, _encoding, callback) {
      setImmediate(() => {
        output += chunk.toString()
        callback()
      })
    },
  })
  const value = 'result'.repeat(12_000)
  await writeText(stream, value)
  assert.equal(output, `${value}\n`)

  const failing = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('output closed'))
    },
  })
  await assert.rejects(() => writeText(failing, 'result'), /output closed/u)
  await new Promise((resolve) => setImmediate(resolve))
})

test('coordinator resolves explicit base before launching both reviewers', async () => {
  const fixture = contextFixture()
  const calls = []
  const snapshots = []
  let recorded
  try {
    const code = await main({
      argv: ['--base', 'release', '--context-file', fixture.path],
      run: explicitBaseRun,
      readCleanHead: () => head,
      review: (name, args) => {
        calls.push({ name, args })
        const snapshot = args[args.indexOf('--context-file') + 1]
        snapshots.push({
          path: snapshot,
          content: readFileSync(snapshot, 'utf8'),
          mode: statSync(snapshot).mode & 0o777,
        })
        return Promise.resolve({
          name,
          stdout: `${name} result\n${reviewReminder}`,
          stderr: `${name} timing`,
        })
      },
      log: () => {},
      timingLog: () => {},
      recordRounds: (_head, options) => {
        recorded = { _head, ...options }
      },
    })
    assert.equal(code, 0)
    assert.deepEqual(
      calls.map(({ name }) => name),
      ['codex', 'claude'],
    )
    assert.equal(
      new Set(calls.map(({ args }) => args.at(args.indexOf('--base') + 1)))
        .size,
      1,
    )
    assert.equal(calls[0].args[calls[0].args.indexOf('--base') + 1], base)
    assert.equal(
      new Set(
        calls.map(({ args }) => args.at(args.indexOf('--expected-head') + 1)),
      ).size,
      1,
    )
    assert.equal(
      calls[0].args[calls[0].args.indexOf('--expected-head') + 1],
      head,
    )
    assert.equal(
      new Set(
        calls.map(({ args }) => args.at(args.indexOf('--context-file') + 1)),
      ).size,
      1,
    )
    assert.deepEqual(
      snapshots.map(({ content }) => content),
      [readFileSync(fixture.path, 'utf8'), readFileSync(fixture.path, 'utf8')],
    )
    assert.deepEqual(
      snapshots.map(({ mode }) => mode),
      [0o400, 0o400],
    )
    assert.deepEqual(
      calls.map(({ args }) => [
        args[args.indexOf('--model') + 1],
        args[args.indexOf('--effort') + 1],
      ]),
      [
        [finalReviews.codex.model, finalReviews.codex.effort],
        [finalReviews.claude.model, finalReviews.claude.effort],
      ],
    )
    assert.equal(recorded._head, head)
    assert.equal(recorded.base, base)
    assert.deepEqual(recorded.profile, finalReviews)
    assert.ok(snapshots.every(({ path }) => !existsSync(path)))
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('final gate rejects a blank second reviewer without delivery or history', async () => {
  const fixture = contextFixture()
  const logs = []
  let recorded = false
  try {
    await assert.rejects(
      () =>
        main({
          argv: ['--base', 'release', '--context-file', fixture.path],
          run: explicitBaseRun,
          readCleanHead: () => head,
          review: (name) =>
            Promise.resolve({
              name,
              stdout: name === 'claude' ? '' : 'codex result',
              stderr: '',
            }),
          log: (value) => logs.push(value),
          recordRounds: () => {
            recorded = true
          },
        }),
      /returned no final result/u,
    )
    assert.deepEqual(logs, [])
    assert.equal(recorded, false)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a failed reviewer leaves its successful peer undelivered and records no pair', async () => {
  const fixture = contextFixture()
  const logs = []
  let recorded = false
  try {
    await assert.rejects(
      () =>
        main({
          argv: ['--base', 'release', '--context-file', fixture.path],
          run: explicitBaseRun,
          readCleanHead: () => head,
          review: (name) =>
            name === 'codex'
              ? Promise.reject(new Error('codex failed'))
              : Promise.resolve({
                  name,
                  stdout: 'claude result',
                  stderr: '',
                }),
          log: (value) => logs.push(value),
          recordRounds: () => {
            recorded = true
          },
        }),
      /codex failed/u,
    )
    assert.deepEqual(logs, [])
    assert.equal(recorded, false)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a combined result delivery failure records no pair', async () => {
  const fixture = contextFixture()
  let writes = 0
  let recorded = false
  try {
    await assert.rejects(
      () =>
        main({
          argv: ['--base', 'release', '--context-file', fixture.path],
          run: explicitBaseRun,
          readCleanHead: () => head,
          review: (name) =>
            Promise.resolve({ name, stdout: `${name} result`, stderr: '' }),
          log: () => {
            writes += 1
            throw new Error('output closed')
          },
          timingLog: () => {},
          recordRounds: () => {
            recorded = true
          },
        }),
      /output closed/u,
    )
    assert.equal(writes, 1)
    assert.equal(recorded, false)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('late HEAD mutation leaves results undelivered and history unchanged', async () => {
  const fixture = contextFixture()
  let reads = 0
  const logs = []
  let recorded = false
  try {
    await assert.rejects(
      () =>
        main({
          argv: ['--base', 'release', '--context-file', fixture.path],
          run: explicitBaseRun,
          readCleanHead: () => (reads++ < 1 ? head : 'c'.repeat(40)),
          review: (name) =>
            Promise.resolve({ name, stdout: 'result', stderr: '' }),
          log: (value) => logs.push(value),
          recordRounds: () => {
            recorded = true
          },
        }),
      /changed during review/u,
    )
    assert.deepEqual(logs, [])
    assert.equal(recorded, false)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('delivers the complete pair once and verifies the checkout before history', async () => {
  const fixture = contextFixture()
  const logs = []
  const events = []
  let headReads = 0
  try {
    const code = await main({
      argv: ['--base', 'release', '--context-file', fixture.path],
      run: explicitBaseRun,
      readCleanHead: () => {
        headReads += 1
        return head
      },
      review: (name) =>
        Promise.resolve({
          name,
          stdout: `${name} findings\n${reviewReminder}`,
          stderr: `${name} timing`,
        }),
      log: (value) => {
        logs.push(value)
        events.push('delivery')
      },
      timingLog: () => {},
      recordRounds: () => events.push('history'),
    })
    assert.equal(code, 0)
    assert.equal(headReads, 3)
    assert.deepEqual(logs, [
      `## Codex\n\ncodex findings\n\n## Claude\n\nclaude findings\n\n${reviewReminder}`,
    ])
    assert.deepEqual(events, ['delivery', 'history'])
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a no-target range is incomplete and does not launch children', async () => {
  const fixture = contextFixture()
  let launched = false
  try {
    await assert.rejects(
      () =>
        main({
          argv: ['--base', 'release', '--context-file', fixture.path],
          run: (_file, args) => {
            if (args[0] === 'rev-parse' && args[1] === '--verify')
              return `${base}\n`
            if (args[0] === 'merge-base') return `${base}\n`
            if (args[0] === 'rev-list') return '0'
            throw new Error(`Unexpected git call: ${args.join(' ')}`)
          },
          readCleanHead: () => head,
          review: () => {
            launched = true
            return Promise.resolve({
              name: 'unexpected',
              stdout: 'result',
              stderr: '',
            })
          },
        }),
      /No implementation review target/u,
    )
    assert.equal(launched, false)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('records both reviewer histories with the final pair metadata', () => {
  const common = mkdtempSync(join(tmpdir(), 'implementation-rounds-'))
  const run = (_file, args) => {
    if (args[0] === 'branch') return 'fix/review-gate'
    if (args[0] === 'rev-parse') return common
    throw new Error(`Unexpected git call: ${args.join(' ')}`)
  }
  try {
    recordCompletedRounds(head, { base, profile: finalReviews, run })
    for (const reviewer of ['codex', 'claude']) {
      const round = readRounds(roundsPath('fix/review-gate', reviewer, run))
        .rounds[0]
      assert.equal(round.head, head)
      assert.equal(round.base, base)
      assert.deepEqual(round.profile, finalReviews)
    }
  } finally {
    rmSync(common, { recursive: true, force: true })
  }
})

test('uses shared Git history to narrow a default coordinated review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'implementation-git-history-'))
  const repo = join(root, 'repo')
  const template = join(root, 'git-template')
  const globalConfig = join(root, 'global.gitconfig')
  const fixture = contextFixture()
  mkdirSync(repo)
  mkdirSync(template)
  writeFileSync(globalConfig, '')
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TEMPLATE_DIR: template,
  }
  const git = (args) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: gitEnvironment,
    }).trim()
  try {
    git(['init', '-b', 'main'])
    writeFileSync(join(repo, 'file.txt'), 'base\n')
    git(['add', 'file.txt'])
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-m',
      'base',
    ])
    const defaultBaseSha = git(['rev-parse', 'HEAD'])
    git(['update-ref', 'refs/remotes/origin/main', defaultBaseSha])
    git(['switch', '-c', 'feature'])
    writeFileSync(join(repo, 'file.txt'), 'reviewed\n')
    git(['add', 'file.txt'])
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-m',
      'reviewed',
    ])
    const reviewedHead = git(['rev-parse', 'HEAD'])
    const run = (file, args) => {
      const output = execFileSync(file, args, {
        cwd: repo,
        encoding: 'utf8',
        env: gitEnvironment,
      }).trim()
      return file === 'git' && args.join(' ') === 'rev-parse --git-common-dir'
        ? resolvePath(repo, output)
        : output
    }
    recordCompletedRounds(reviewedHead, {
      base: defaultBaseSha,
      profile: finalReviews,
      run,
    })
    writeFileSync(join(repo, 'file.txt'), 'current\n')
    git(['add', 'file.txt'])
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-m',
      'current',
    ])
    const currentHead = git(['rev-parse', 'HEAD'])
    const calls = []
    const code = await main({
      argv: ['--context-file', fixture.path],
      run,
      readCleanHead: () => {
        assert.equal(git(['status', '--porcelain']), '')
        return git(['rev-parse', 'HEAD'])
      },
      review: (name, args) => {
        calls.push({ name, args })
        return Promise.resolve({ name, stdout: `${name} result`, stderr: '' })
      },
      log: () => {},
      timingLog: () => {},
    })
    assert.equal(code, 0)
    assert.deepEqual(
      calls.map(({ args }) => args[args.indexOf('--base') + 1]),
      [reviewedHead, reviewedHead],
    )
    for (const reviewer of ['codex', 'claude']) {
      const path = roundsPath('feature', reviewer, run)
      assert.equal(path.startsWith(join(repo, '.git', 'artifactshare')), true)
      const rounds = readRounds(path).rounds
      assert.equal(rounds.at(-1).head, currentHead)
      assert.equal(rounds.at(-1).base, reviewedHead)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('removes only the exact shared reminder suffix', () => {
  assert.equal(withoutReminder(`Finding\n${reviewReminder}`), 'Finding')
  assert.equal(withoutReminder('Finding'), 'Finding')
})
