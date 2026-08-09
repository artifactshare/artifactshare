import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  defaultBase,
  defaultModel,
  defaultTimeoutMs,
  listMcpNames,
  main,
  mcpListArgs,
  parseArgs,
  parseMcpNames,
  reviewArgs,
  runReview,
  terminateProcessTree,
} from './codex-review.mjs'

function fakeChild({ stdout = '', code = 0, pid = 123 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', stdout)
    child.emit('close', code, null)
  })
  return child
}

const cleanGit = (_file, args) =>
  args[0] === 'status' ? '' : `${'a'.repeat(40)}\n`

test('uses safe review defaults and accepts a prompt', () => {
  assert.deepEqual(parseArgs(['--', '--dry-run', 'Check', 'the', 'diff']), {
    model: defaultModel,
    base: defaultBase,
    timeoutMs: defaultTimeoutMs,
    dryRun: true,
    prompt: 'Check the diff',
  })
})

test('parses explicit review options after pnpm separator', () => {
  assert.deepEqual(
    parseArgs([
      '--model',
      'custom',
      '--base',
      'HEAD~2',
      '--timeout-ms',
      '25',
      '--',
      '--prompt',
    ]),
    {
      model: 'custom',
      base: 'HEAD~2',
      timeoutMs: 25,
      dryRun: false,
      prompt: '--prompt',
    },
  )
})

test('passes feature disables to MCP enumeration', async () => {
  let seen
  const names = await listMcpNames({
    spawnImpl: (command, args) => {
      seen = [command, args]
      return fakeChild({
        stdout: JSON.stringify([
          { name: 'standalone', source: 'user' },
          { name: 'plugin-mcp', source: 'plugin:browser' },
        ]),
      })
    },
    gitExec: cleanGit,
  })
  assert.deepEqual(seen, ['codex', mcpListArgs()])
  assert.deepEqual(seen[1].slice(-2), ['-c', 'web_search=disabled'])
  assert.deepEqual(names, ['standalone'])
})

test('main rejects an uncommitted worktree before starting Codex', async () => {
  let spawned = false
  const errors = []
  const code = await main({
    spawnImpl: () => {
      spawned = true
    },
    gitExec: (_file, args) => (args[0] === 'status' ? ' M file' : ''),
    errorLog: (value) => errors.push(value),
  })
  assert.equal(code, 1)
  assert.equal(spawned, false)
  assert.match(errors[0], /clean/u)
})

test('rejects unsafe MCP names without exposing the input', () => {
  assert.throws(
    () =>
      parseMcpNames(
        '[{"name":"bad.name","source":"user","transport":{"env":{"TOKEN":"secret"}}}]',
      ),
    /invalid MCP name/,
  )
  assert.throws(
    () => parseMcpNames('not json secret'),
    /parse Codex MCP list output/,
  )
})

test('builds a base review command when no additional prompt is given', () => {
  assert.deepEqual(
    reviewArgs({
      model: 'm',
      base: 'b',
      mcpNames: ['alpha', 'beta_2'],
      prompt: '',
    }),
    [
      '-m',
      'm',
      'review',
      '--disable',
      'apps',
      '--disable',
      'plugins',
      '-c',
      'apps._default.enabled=false',
      '-c',
      'check_for_update_on_startup=false',
      '-c',
      'web_search=disabled',
      '-c',
      'mcp_servers.alpha.enabled=false',
      '-c',
      'mcp_servers.beta_2.enabled=false',
      '--base',
      'b',
    ],
  )
})

test('turns an additional prompt into a custom base review target', () => {
  const args = reviewArgs({
    model: 'm',
    base: 'origin/topic',
    mcpNames: [],
    prompt: ['Check', 'the contract'],
  })
  assert.equal(args.includes('--base'), false)
  assert.match(args.at(-1), /base ref origin\/topic/)
  assert.match(
    args.at(-1),
    /Additional review instructions: Check the contract/,
  )
})

test('dry-run emits only safe invocation data and does not start review', async () => {
  const logs = []
  let calls = 0
  const code = await main({
    argv: ['--dry-run'],
    log: (value) => logs.push(value),
    errorLog: (value) => logs.push(value),
    spawnImpl: (command, args) => {
      calls += 1
      assert.equal(command, 'codex')
      assert.deepEqual(args, mcpListArgs())
      return fakeChild({
        stdout: JSON.stringify([
          {
            name: 'safe-mcp',
            source: 'user',
            transport: { env: { TOKEN: 'secret' } },
          },
        ]),
      })
    },
    gitExec: cleanGit,
  })
  assert.equal(code, 0)
  assert.equal(calls, 1)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].includes('secret'), false)
  assert.equal(logs[0].includes('transport'), false)
  assert.match(logs[0], /safe-mcp/)
})

test('discards a successful review when HEAD changes while Codex runs', async () => {
  let spawnCalls = 0
  let headReads = 0
  const errors = []
  const code = await main({
    spawnImpl: () => {
      spawnCalls += 1
      return fakeChild({ stdout: spawnCalls === 1 ? '[]' : '' })
    },
    gitExec: (_file, args) => {
      if (args[0] === 'status') return ''
      headReads += 1
      return `${(headReads === 1 ? 'a' : 'b').repeat(40)}\n`
    },
    errorLog: (value) => errors.push(value),
  })
  assert.equal(code, 1)
  assert.match(errors[0], /changed during review/)
})

test('MCP list timeout terminates the process tree before review starts', async () => {
  const killed = []
  let calls = 0
  const child = new EventEmitter()
  child.pid = 460
  await assert.rejects(
    () =>
      listMcpNames({
        timeoutMs: 1,
        graceMs: 1,
        closeTimeoutMs: 1,
        spawnImpl: (command) => {
          calls += 1
          assert.equal(command, 'codex')
          return child
        },
        platform: 'darwin',
        killImpl: (pid, signal) => {
          killed.push([pid, signal])
          if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close'))
        },
      }),
    /MCP list timed out/,
  )
  assert.deepEqual(killed, [
    [-460, 'SIGTERM'],
    [-460, 'SIGKILL'],
  ])
  assert.equal(calls, 1)
})

test('review timeout kills the POSIX process group and returns 124', async () => {
  const killed = []
  const child = new EventEmitter()
  child.pid = 456
  const code = await runReview({
    args: ['review'],
    timeoutMs: 1,
    graceMs: 1,
    spawnImpl: () => child,
    killImpl: (pid, signal) => {
      killed.push([pid, signal])
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close'))
    },
    platform: 'darwin',
  })
  assert.equal(code, 124)
  assert.deepEqual(killed, [
    [-456, 'SIGTERM'],
    [-456, 'SIGKILL'],
  ])
})

test('review timeout does not SIGKILL after SIGTERM closes the child', async () => {
  const killed = []
  const child = new EventEmitter()
  child.pid = 457
  const code = await runReview({
    args: ['review'],
    timeoutMs: 1,
    graceMs: 10,
    spawnImpl: () => child,
    killImpl: (pid, signal) => {
      killed.push([pid, signal])
      if (signal === 'SIGTERM')
        setTimeout(() => child.emit('close', null, signal), 0)
    },
    platform: 'darwin',
  })
  assert.equal(code, 124)
  assert.deepEqual(killed, [[-457, 'SIGTERM']])
})

test('review timeout force-kills a child that ignores SIGTERM', async () => {
  const killed = []
  const child = new EventEmitter()
  child.pid = 458
  const code = await runReview({
    args: ['review'],
    timeoutMs: 1,
    graceMs: 1,
    closeTimeoutMs: 1,
    spawnImpl: () => child,
    killImpl: (pid, signal) => {
      killed.push([pid, signal])
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close'))
    },
    platform: 'darwin',
  })
  assert.equal(code, 124)
  assert.deepEqual(killed, [
    [-458, 'SIGTERM'],
    [-458, 'SIGKILL'],
  ])
})

test('awaits Windows tree termination and escalates after a nonzero graceful exit', async () => {
  const calls = []
  const codes = [1, 0]
  const spawnImpl = (...args) => {
    calls.push(args)
    return fakeChild({ code: codes.shift() })
  }
  const forceKill = await terminateProcessTree(459, {
    platform: 'win32',
    spawnImpl,
  })
  assert.equal(await forceKill(), 0)
  assert.deepEqual(calls, [
    ['taskkill', ['/PID', '459', '/T'], { stdio: 'ignore' }],
    ['taskkill', ['/F', '/PID', '459', '/T'], { stdio: 'ignore' }],
  ])
})

test('Windows review timeout force-kills after graceful taskkill fails', async () => {
  const calls = []
  const child = new EventEmitter()
  child.pid = 459
  const code = await runReview({
    args: ['review'],
    timeoutMs: 1,
    graceMs: 1,
    closeTimeoutMs: 10,
    platform: 'win32',
    spawnImpl: (command, args) => {
      if (command === 'codex') return child
      calls.push(args)
      const force = args.includes('/F')
      if (force) queueMicrotask(() => child.emit('close'))
      return fakeChild({ code: force ? 0 : 1 })
    },
  })
  assert.equal(code, 124)
  assert.deepEqual(calls, [
    ['/PID', '459', '/T'],
    ['/F', '/PID', '459', '/T'],
  ])
})

test('preserves a normally exiting review code', async () => {
  const code = await runReview({
    args: ['review'],
    timeoutMs: 100,
    spawnImpl: () => fakeChild({ code: 7 }),
  })
  assert.equal(code, 7)
})
