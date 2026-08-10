import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRequestBody,
  generateRequestId,
  main,
  commandResult,
  parseArgs,
  parseDeliveryMode,
  selectReply,
  reviewProfile,
  isGateGo,
} from './claude-review.mjs'

test('parses defaults and options after --', () => {
  assert.deepEqual(parseArgs(['--', '--depth', 'gate']), {
    target: undefined,
    depth: 'gate',
    risk: 'normal',
    note: undefined,
    timeoutMs: 1800000,
    dryRun: false,
  })
})

test('rejects invalid arguments', () => {
  assert.throws(() => parseArgs(['--depth', 'deep']), /Invalid --depth/)
  assert.throws(
    () => parseArgs(['--timeout-ms', '1.5']),
    /Invalid --timeout-ms/,
  )
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/)
  assert.throws(
    () => parseArgs(['--depth', 'loop', '--risk', 'high']),
    /requires/,
  )
  assert.throws(() => parseArgs(['--risk', 'urgent']), /Invalid --risk/)
})

test('selects the contracted reviewer and effort for each profile', () => {
  assert.deepEqual(reviewProfile('loop', 'normal'), {
    effort: 'low',
    reviewer: 'claude-reviewer-loop-low',
  })
  assert.deepEqual(reviewProfile('gate', 'normal'), {
    effort: 'high',
    reviewer: 'claude-reviewer-gate-high',
  })
  assert.deepEqual(reviewProfile('gate', 'high'), {
    effort: 'xhigh',
    reviewer: 'claude-reviewer',
  })
})

test('accepts explanatory GO replies but rejects findings and ambiguous text', () => {
  assert.equal(isGateGo('review-reply: id\nGO'), true)
  assert.equal(isGateGo('review-reply: id\nGO。\n確認しました。'), true)
  assert.equal(isGateGo('review-reply: id\nGO\n[中] typing issue'), false)
  assert.equal(isGateGo('review-reply: id\nGO\nこれは GO ではない'), false)
  assert.equal(isGateGo('review-reply: id\nGO ではない'), false)
  assert.equal(isGateGo('review-reply: id\n[低] issue\nGO'), false)
})

test('builds distinct loop and gate requests', () => {
  const common = {
    requestId: 'abc@20260725T000000Z-000000000001',
    shortSha: 'abc',
    fullSha: 'a'.repeat(40),
    target: 'x',
    round: 1,
    note: '重点',
  }
  assert.match(
    buildRequestBody({ ...common, depth: 'loop' }),
    /前回のレビュー以降/,
  )
  assert.match(buildRequestBody({ ...common, depth: 'gate' }), /全差分を対象/)
  assert.match(
    buildRequestBody({ ...common, depth: 'loop' }),
    /^review-request: abc@/,
  )
})

test('retries colliding request ids', () => {
  const existing = new Set(['abc@20260725T000000Z-000000000000'])
  let calls = 0
  const id = generateRequestId(
    'abc',
    new Date('2026-07-25T00:00:00Z'),
    () => (calls++ === 0 ? 0 : 1 / 0x1000000000000),
    existing,
  )
  assert.notEqual(id, [...existing][0])
})

test('selects only a new exact first-line reply', () => {
  const messages = [
    {
      id: 'old',
      from: 'claude-reviewer',
      to: 'claude',
      body: 'review-reply: id',
    },
    {
      id: 'middle',
      from: 'claude-reviewer',
      to: 'claude',
      body: 'note\nreview-reply: id',
    },
    { id: 'other', from: 'other', to: 'claude', body: 'review-reply: id' },
    {
      id: 'good',
      from: 'claude-reviewer',
      to: 'claude',
      body: 'review-reply: id\nGO',
    },
  ]
  const result = selectReply(messages, new Set(['old']), 'id')
  assert.equal(result.reply.id, 'good')
})

test('omits the focus line without --note and preserves blank lines', () => {
  const body = buildRequestBody({
    requestId: 'id',
    shortSha: 'abc',
    fullSha: 'a'.repeat(40),
    target: 'x',
    depth: 'loop',
    round: 1,
  })
  assert.doesNotMatch(body, /重点:/)
  assert.match(body, /review-request: id\n\n対象:/)
})

test('does not select a reply for another request id', () => {
  const message = {
    id: 'other',
    from: 'claude-reviewer',
    to: 'claude',
    body: 'review-reply: other\nGO',
  }
  const result = selectReply([message], new Set(), 'id')
  assert.equal(result.reply, null)
  assert.deepEqual(result.ignored, [message])
})

test('parses only supported delivery modes from the first line', () => {
  assert.equal(parseDeliveryMode('mode: monitor\ndetail'), 'monitor')
  assert.equal(parseDeliveryMode('mode: turn\n'), 'turn')
  assert.equal(parseDeliveryMode('mode: both\n'), 'both')
  assert.equal(parseDeliveryMode('mode: off\n'), 'off')
  assert.equal(parseDeliveryMode('detail\nmode: monitor'), null)
  assert.equal(parseDeliveryMode('mode: unknown'), null)
})

function fakeSpawn({
  history = '',
  reply,
  matchingReply = false,
  bootCode = 0,
  bootStderr = '',
  hangApi = false,
  ignoreTerm = false,
  deliveryMode = 'monitor',
  deliveryStatusCode = 0,
  deliveryStatusStderr = '',
  deliverySetCode = 0,
  deliverySetStderr = '',
  worktreeStatus = '',
  finalHead = 'a'.repeat(40),
} = {}) {
  const calls = []
  const children = []
  let fullHeadReads = 0
  const spawnImpl = (executable, args, options) => {
    calls.push({ executable, args, options })
    const listeners = {}
    const child = {
      pid: calls.length + 1000,
      stdout: {
        setEncoding: (encoding) => {
          child.stdout.encoding = encoding
        },
        on: (event, fn) => {
          listeners.stdout = fn
        },
      },
      stderr: {
        setEncoding: (encoding) => {
          child.stderr.encoding = encoding
        },
        on: (event, fn) => {
          listeners.stderr = fn
        },
      },
      once: (event, fn) => {
        listeners[event] = fn
      },
      emitError: () => listeners.error?.(new Error('spawn failed')),
      kill: (signal) => {
        child.signals = [...(child.signals ?? []), signal]
        if (ignoreTerm && signal === 'SIGTERM') return
        listeners.close?.(null)
      },
    }
    children.push(child)
    const isApi = executable.endsWith('/api.sh')
    const isPollingApi =
      isApi && calls.some((call) => call.executable.endsWith('/send.sh'))
    if (!(isPollingApi && hangApi))
      queueMicrotask(() => {
        if (executable === 'git' && args[0] === 'status')
          listeners.stdout?.(worktreeStatus)
        if (executable === 'git' && args[1] === '--short')
          listeners.stdout?.('abc123\n')
        if (
          executable === 'git' &&
          args[0] === 'rev-parse' &&
          args[1] === 'HEAD'
        ) {
          fullHeadReads += 1
          listeners.stdout?.(
            `${fullHeadReads === 1 ? 'a'.repeat(40) : finalHead}\n`,
          )
        }
        if (executable === 'git' && args[1] === '--show-toplevel')
          listeners.stdout?.('/repo\n')
        if (executable === 'bash') listeners.stdout?.('/sentinel\n')
        if (executable.endsWith('/delivery.sh')) {
          if (args[0] === 'status') {
            listeners.stdout?.(`mode: ${deliveryMode}\n`)
            if (deliveryStatusStderr) listeners.stderr?.(deliveryStatusStderr)
          }
          if (args[0] === 'set' && deliverySetStderr)
            listeners.stderr?.(deliverySetStderr)
        }
        if (executable.endsWith('/spawn.sh') && bootStderr)
          listeners.stderr?.(bootStderr)
        if (isApi) {
          const send = calls.find((call) =>
            call.executable.endsWith('/send.sh'),
          )
          const requestId = send?.args[3]?.match(
            /^review-request: ([^\n]+)/,
          )?.[1]
          // A reply only exists once the request has been sent, so the
          // pre-send read must not already contain it — otherwise it lands in
          // the seen-id set and the wait can never pick it up.
          if (!isPollingApi) listeners.stdout?.(history)
          else if (matchingReply && requestId)
            listeners.stdout?.(
              JSON.stringify({
                id: 'reply',
                from: send?.args[2],
                to: 'claude',
                body: `review-reply: ${requestId}\nGO`,
              }),
            )
          else listeners.stdout?.(reply ?? history)
        }
        const code = executable.endsWith('/spawn.sh')
          ? bootCode
          : executable.endsWith('/delivery.sh') && args[0] === 'status'
            ? deliveryStatusCode
            : executable.endsWith('/delivery.sh') && args[0] === 'set'
              ? deliverySetCode
              : 0
        listeners.close?.(code)
      })
    return child
  }
  return {
    spawnImpl,
    calls,
    // Every main() call must route signals here. The fake pids are made up, so
    // letting the real process.kill see a group kill would signal an unrelated
    // process group on the machine.
    killImpl: (pid, signal) =>
      children.find((child) => child.pid === Math.abs(pid))?.kill(signal),
    get lastChild() {
      return children.at(-1)
    },
  }
}

test('main rejects an uncommitted worktree before contacting the reviewer', async () => {
  const fake = fakeSpawn({ worktreeStatus: ' M file\n' })
  const errors = []
  const code = await main({
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    errorLog: (value) => errors.push(value),
  })
  assert.equal(code, 1)
  assert.equal(
    fake.calls.some((call) => call.executable.endsWith('/send.sh')),
    false,
  )
  assert.match(errors[0], /clean/u)
})

test('main skips spawn when reviewer is already ready and sends', async () => {
  const fake = fakeSpawn({ history: '', hangApi: true })
  const calls = []
  const code = await main({
    argv: ['--timeout-ms', '100'],
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => true,
    now: () => new Date('2026-07-25T00:00:00Z'),
    random: () => 0,
    wait: async () => {},
    log: (value) => calls.push(value),
    errorLog: () => {},
  })
  assert.equal(code, 124)
  assert.equal(
    fake.calls.filter((call) => call.executable.endsWith('/spawn.sh')).length,
    0,
  )
  assert.equal(
    fake.calls.filter((call) => call.executable.endsWith('/send.sh')).length,
    1,
  )
})

test('main boots when sentinel is absent', async () => {
  const fake = fakeSpawn({ history: '' })
  const code = await main({
    argv: ['--timeout-ms', '10'],
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => false,
    wait: async () => {},
    log: () => {},
    errorLog: () => {},
  })
  assert.equal(code, 124)
  assert.equal(
    fake.calls.filter((call) => call.executable.endsWith('/spawn.sh')).length,
    1,
  )
  const launch = fake.calls.find((call) =>
    call.executable.endsWith('/spawn.sh'),
  )
  assert.deepEqual(launch.args.slice(-4), [
    '--model',
    'opus',
    '--effort',
    'low',
  ])
})

test('main keeps each depth/risk profile aligned across ready, history, spawn, send, and reply', async () => {
  for (const [argv, reviewer, effort] of [
    [[], 'claude-reviewer-loop-low', 'low'],
    [['--depth', 'gate'], 'claude-reviewer-gate-high', 'high'],
    [['--depth', 'gate', '--risk', 'high'], 'claude-reviewer', 'xhigh'],
  ]) {
    const fake = fakeSpawn({ matchingReply: true })
    const receipts = []
    const code = await main({
      argv: [...argv, '--timeout-ms', '10'],
      spawnImpl: fake.spawnImpl,
      killImpl: fake.killImpl,
      exists: () => false,
      wait: async () => {},
      writeGateReceipt: (receipt) => receipts.push(receipt),
      log: () => {},
      errorLog: () => {},
    })
    assert.equal(code, 0)
    const ready = fake.calls.find((call) => call.executable === 'bash')
    const history = fake.calls.find((call) => call.executable.endsWith('/api.sh'))
    const spawn = fake.calls.find((call) => call.executable.endsWith('/spawn.sh'))
    const send = fake.calls.find((call) => call.executable.endsWith('/send.sh'))
    assert.equal(ready.args.at(-1), reviewer)
    assert.equal(history.args[history.args.indexOf('--agent') + 1], reviewer)
    assert.equal(spawn.args[1], reviewer)
    assert.equal(spawn.args.at(-1), effort)
    assert.equal(send.args[2], reviewer)
    assert.match(send.args[3], /設定: depth=/u)
    assert.equal(receipts.length, argv.includes('--depth') ? 1 : 0)
  }
})

test('main enables monitor before spawn when delivery is off', async () => {
  const fake = fakeSpawn({ history: '', deliveryMode: 'off' })
  const logs = []
  await main({
    argv: ['--timeout-ms', '1'],
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => false,
    wait: async () => {},
    log: (value) => logs.push(value),
    errorLog: () => {},
  })
  const commands = fake.calls.map((call) =>
    call.executable.endsWith('/delivery.sh')
      ? `delivery:${call.args[0]}`
      : call.executable.split('/').at(-1),
  )
  const setIndex = commands.indexOf('delivery:set')
  const spawnIndex = commands.indexOf('spawn.sh')
  assert.notEqual(setIndex, -1)
  assert.notEqual(spawnIndex, -1)
  assert.ok(setIndex < spawnIndex)
  assert.deepEqual(fake.calls[setIndex].args, [
    'set',
    'monitor',
    'claude-code',
    '/repo',
  ])
  assert.match(logs[0], /off から monitor/)
})

test('main replaces turn delivery with monitor', async () => {
  const fake = fakeSpawn({ history: '', deliveryMode: 'turn' })
  await main({
    argv: ['--timeout-ms', '1'],
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => true,
    wait: async () => {},
    log: () => {},
    errorLog: () => {},
  })
  const set = fake.calls.find(
    (call) =>
      call.executable.endsWith('/delivery.sh') && call.args[0] === 'set',
  )
  assert.deepEqual(set.args, ['set', 'monitor', 'claude-code', '/repo'])
})

test('main preserves monitor and both delivery', async () => {
  for (const deliveryMode of ['monitor', 'both']) {
    const fake = fakeSpawn({ history: '', deliveryMode })
    await main({
      argv: ['--timeout-ms', '1'],
      spawnImpl: fake.spawnImpl,
      killImpl: fake.killImpl,
      exists: () => true,
      wait: async () => {},
      log: () => {},
      errorLog: () => {},
    })
    assert.equal(
      fake.calls.some(
        (call) =>
          call.executable.endsWith('/delivery.sh') && call.args[0] === 'set',
      ),
      false,
    )
  }
})

test('main reports failed reviewer boot without sending', async () => {
  const fake = fakeSpawn({ bootCode: 3 })
  const errors = []
  const code = await main({
    argv: ['--timeout-ms', '10'],
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => false,
    log: () => {},
    errorLog: (value) => errors.push(value),
  })
  assert.equal(code, 1)
  assert.equal(
    fake.calls.some((call) => call.executable.endsWith('/send.sh')),
    false,
  )
  assert.match(errors[0], /reviewer は停止していない/)
})

test('dry-run prints the planned request without starting or sending', async () => {
  const fake = fakeSpawn({ history: '', deliveryMode: 'off' })
  const output = []
  const code = await main({
    argv: ['--dry-run'],
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => true,
    log: (value) => output.push(JSON.parse(value)),
    errorLog: () => {},
  })
  assert.equal(code, 0)
  assert.equal(
    fake.calls.some((call) => call.executable.endsWith('/spawn.sh')),
    false,
  )
  assert.equal(
    fake.calls.some((call) => call.executable.endsWith('/send.sh')),
    false,
  )
  assert.ok(output[0].request.body)
  assert.deepEqual(output[0].delivery, {
    currentMode: 'off',
    plannedMode: 'monitor',
  })
  assert.equal(
    fake.calls.some(
      (call) =>
        call.executable.endsWith('/delivery.sh') && call.args[0] === 'set',
    ),
    false,
  )
  assert.match(
    output[0].request.body,
    new RegExp(`origin/main\\.\\.\\.${'a'.repeat(40)}`),
  )
  assert.match(
    output[0].request.body,
    new RegExp(`local commit ${'a'.repeat(40)}`),
  )
})

test('main stops before spawn and send when delivery status fails', async () => {
  const fake = fakeSpawn({
    deliveryStatusCode: 1,
    deliveryStatusStderr: 'status failed',
  })
  const errors = []
  const code = await main({
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => false,
    log: () => {},
    errorLog: (value) => errors.push(value),
  })
  assert.equal(code, 1)
  assert.match(errors[0], /delivery status failed for \/repo: status failed/)
  assert.equal(
    fake.calls.some((call) => /\/(spawn|send)\.sh$/.test(call.executable)),
    false,
  )
})

test('main stops before spawn and send when delivery mode is invalid', async () => {
  const fake = fakeSpawn({ deliveryMode: 'unknown' })
  const errors = []
  const code = await main({
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => false,
    log: () => {},
    errorLog: (value) => errors.push(value),
  })
  assert.equal(code, 1)
  assert.match(errors[0], /invalid mode for \/repo/)
  assert.equal(
    fake.calls.some((call) => /\/(spawn|send)\.sh$/.test(call.executable)),
    false,
  )
})

test('main stops before spawn and send when delivery set fails', async () => {
  const fake = fakeSpawn({
    deliveryMode: 'off',
    deliverySetCode: 1,
    deliverySetStderr: 'set failed',
  })
  const errors = []
  const code = await main({
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => false,
    log: () => {},
    errorLog: (value) => errors.push(value),
  })
  assert.equal(code, 1)
  assert.match(errors[0], /delivery set failed for \/repo: set failed/)
  assert.equal(
    fake.calls.some((call) => /\/(spawn|send)\.sh$/.test(call.executable)),
    false,
  )
})

test('main accepts a matching reply and labels it', async () => {
  const fake = fakeSpawn({ matchingReply: true })
  const logs = []
  const code = await main({
    argv: ['--timeout-ms', '100'],
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => true,
    wait: async () => {},
    random: () => 0,
    log: (value) => logs.push(value),
    errorLog: () => {},
  })
  assert.equal(code, 0)
  assert.match(logs[0], /採用した返信/)
})

test('discards a matching reply when HEAD changes during Claude review', async () => {
  const fake = fakeSpawn({ matchingReply: true, finalHead: 'b'.repeat(40) })
  const errors = []
  const code = await main({
    argv: ['--timeout-ms', '100'],
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => true,
    wait: async () => {},
    random: () => 0,
    log: () => {},
    errorLog: (value) => errors.push(value),
  })
  assert.equal(code, 1)
  assert.match(errors[0], /changed during review/)
})

test('main returns 124 and kills a hung history child', async () => {
  const fake = fakeSpawn({ hangApi: true })
  const code = await main({
    argv: ['--timeout-ms', '1'],
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => true,
    log: () => {},
    errorLog: () => {},
  })
  assert.equal(code, 124)
  assert.deepEqual(fake.lastChild.signals, ['SIGTERM'])
})

test('main escalates to SIGKILL when the hung child ignores SIGTERM', async () => {
  const fake = fakeSpawn({ hangApi: true, ignoreTerm: true })
  const code = await main({
    argv: ['--timeout-ms', '1'],
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => true,
    log: () => {},
    errorLog: () => {},
  })
  assert.equal(code, 124)
  assert.deepEqual(fake.lastChild.signals, ['SIGTERM', 'SIGKILL'])
})

test('main shows an unmatched reply and counts it at the limit', async () => {
  const fake = fakeSpawn({
    reply: JSON.stringify({
      id: 'stale',
      from: 'claude-reviewer-loop-low',
      to: 'claude',
      body: 'review-reply: 前のラウンドの依頼 ID\n遅れて届いた返信',
    }),
  })
  const logs = []
  const errors = []
  const code = await main({
    argv: ['--timeout-ms', '1'],
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => true,
    wait: async () => {},
    log: (value) => logs.push(value),
    errorLog: (value) => errors.push(value),
  })
  assert.equal(code, 124)
  assert.match(logs[0], /対応しない返信/)
  assert.match(logs[1], /遅れて届いた返信/)
  assert.match(errors.at(-1), /対応しない返信 1 件/)
})

test('main reports a failed spawn without sending', async () => {
  const fake = fakeSpawn({ bootCode: 1, bootStderr: 'spawn: no team\n' })
  const errors = []
  const code = await main({
    argv: ['--timeout-ms', '10'],
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => false,
    log: () => {},
    errorLog: (value) => errors.push(value),
  })
  assert.equal(code, 1)
  assert.equal(
    fake.calls.some((call) => call.executable.endsWith('/send.sh')),
    false,
  )
  assert.match(errors[0], /spawn: no team/)
})

test('commandResult sets UTF-8 encoding on both streams', async () => {
  const fake = fakeSpawn({ history: '' })
  const result = commandResult(fake.spawnImpl, 'git', [
    'rev-parse',
    '--short',
    'HEAD',
  ])
  await result
  const encodingChild = fake.lastChild
  assert.ok(encodingChild)
  assert.equal(encodingChild.stdout.encoding, 'utf8')
  assert.equal(encodingChild.stderr.encoding, 'utf8')
})

test('configures detached process groups only for polling', async () => {
  const fake = fakeSpawn({ history: '', hangApi: true })
  const code = await main({
    argv: ['--timeout-ms', '1'],
    spawnImpl: fake.spawnImpl,
    killImpl: fake.killImpl,
    exists: () => false,
    log: () => {},
    errorLog: () => {},
  })
  assert.equal(code, 124)
  for (const call of fake.calls)
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'])
  const detached = fake.calls.filter((call) => call.options.detached)
  assert.equal(detached.length, 1)
  assert.equal(detached[0].executable.endsWith('/api.sh'), true)
  const pollingIndex = fake.calls.indexOf(detached[0])
  // The pre-send history read hits api.sh too, so position is what separates it
  // from the polling call.
  assert.ok(
    pollingIndex >
      fake.calls.findIndex((call) => call.executable.endsWith('/send.sh')),
  )
  const readiness = fake.calls.find((call) => call.executable === 'bash')
  // agmsg_ready_path needs the skill dir, not the scripts dir under it.
  assert.doesNotMatch(readiness.options.env.SKILL_DIR, /\/scripts$/)
})

test('main kills the polling child process group through killImpl', async () => {
  const fake = fakeSpawn({ hangApi: true, ignoreTerm: true })
  const signals = []
  let pollingPid
  const code = await main({
    argv: ['--timeout-ms', '1'],
    spawnImpl: (...args) => {
      const child = fake.spawnImpl(...args)
      if (
        args[0].endsWith('/api.sh') &&
        fake.calls.some((call) => call.executable.endsWith('/send.sh'))
      )
        pollingPid = child.pid
      return child
    },
    killImpl: (pid, signal) => signals.push([pid, signal]),
    exists: () => true,
    log: () => {},
    errorLog: () => {},
  })
  assert.equal(code, 124)
  assert.deepEqual(signals.at(-2), [-pollingPid, 'SIGTERM'])
  assert.deepEqual(signals.at(-1), [-pollingPid, 'SIGKILL'])
})

test('main warns with the polling pid when force kill does not close the child', async () => {
  const fake = fakeSpawn({ hangApi: true, ignoreTerm: true })
  const errors = []
  const code = await main({
    argv: ['--timeout-ms', '1'],
    spawnImpl: fake.spawnImpl,
    killImpl: () => {},
    exists: () => true,
    log: () => {},
    errorLog: (value) => errors.push(value),
  })
  assert.equal(code, 124)
  assert.match(errors.at(-1), /pid: 100\d+/)
})

test('main returns promptly when polling child emits spawn error', async () => {
  const fake = fakeSpawn({ history: '', hangApi: true })
  const spawnImpl = (...args) => {
    const child = fake.spawnImpl(...args)
    if (
      args[0].endsWith('/api.sh') &&
      fake.calls.some((call) => call.executable.endsWith('/send.sh'))
    )
      queueMicrotask(() => child.emitError?.())
    return child
  }
  // The fake emits the error through its existing error listener without a long timer.
  const errors = []
  const before = process
    .getActiveResourcesInfo()
    .filter((resource) => resource === 'Timeout').length
  const result = commandResult(spawnImpl, 'api.sh', [], {
    timeoutMs: 8000,
    killImpl: fake.killImpl,
  })
  fake.lastChild.emitError()
  await assert.rejects(result, /spawn failed/)
  const after = process
    .getActiveResourcesInfo()
    .filter((resource) => resource === 'Timeout').length
  assert.equal(after, before)
  const code = await main({
    argv: ['--timeout-ms', '8000'],
    spawnImpl,
    killImpl: fake.killImpl,
    exists: () => true,
    log: () => {},
    errorLog: (value) => errors.push(value),
  })
  assert.equal(code, 1)
  assert.ok(errors.length)
})
