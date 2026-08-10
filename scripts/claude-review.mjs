#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { terminateProcessTree } from './lib/process-tree.mjs'

const team = 'artifactshare'
const reviewer = 'claude-reviewer'
const requester = 'claude'
const defaultTimeoutMs = 1_800_000
const pollIntervalMs = 10_000
const historyLimit = 200
const timeoutExitCode = 124
const killGraceMs = 250
const scriptsDir = join(
  process.env.AGMSG_SKILL_DIR || join(homedir(), '.agents', 'skills', 'agmsg'),
  'scripts',
)

function usage() {
  return `Usage: pnpm review:claude -- [options]

Options:
  --target <text>        Loop-only review target. Default: origin/main...<full HEAD SHA>
  --depth <loop|gate>    Review depth. Default: loop
  --risk <normal|high>   Risk class. Default: normal (high requires gate)
  --note <text>          Specific focus for this review
  --timeout-ms <ms>      Reply timeout. Default: ${defaultTimeoutMs}
  --dry-run              Print the planned review without starting or sending
  -h, --help             Show this help.`
}

function parseArgs(argv) {
  const options = {
    target: undefined,
    depth: 'loop',
    risk: 'normal',
    note: undefined,
    timeoutMs: defaultTimeoutMs,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '-h' || arg === '--help') return { ...options, help: true }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (
      ['--target', '--depth', '--risk', '--note', '--timeout-ms'].includes(arg)
    ) {
      const value = argv[++i]
      if (!value || value.startsWith('--'))
        throw new Error(`Missing value for ${arg}`)
      if (arg === '--target') options.target = value
      if (arg === '--depth') options.depth = value
      if (arg === '--risk') options.risk = value
      if (arg === '--note') options.note = value
      if (arg === '--timeout-ms') options.timeoutMs = Number(value)
      continue
    }
    if (arg.startsWith('-'))
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`)
    throw new Error(`Unexpected positional argument: ${arg}`)
  }
  if (!['loop', 'gate'].includes(options.depth))
    throw new Error('Invalid --depth. Use loop or gate.')
  if (!['normal', 'high'].includes(options.risk))
    throw new Error('Invalid --risk. Use normal or high.')
  if (options.depth === 'loop' && options.risk === 'high')
    throw new Error('--risk high requires --depth gate.')
  if (options.depth === 'gate' && options.target !== undefined)
    throw new Error('--depth gate fixes the target; omit --target.')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
    throw new Error('Invalid --timeout-ms. Use a positive integer.')
  return options
}

function reviewProfile(depth, risk) {
  if (depth === 'loop')
    return { effort: 'low', reviewer: 'claude-reviewer-loop-low' }
  if (risk === 'high') return { effort: 'xhigh', reviewer: 'claude-reviewer' }
  return { effort: 'high', reviewer: 'claude-reviewer-gate-high' }
}

function isGateGo(body) {
  const lines = String(body ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const content = lines.slice(1)
  return content.length === 1 && ['GO', 'GO。'].includes(content[0])
}

function gateReceiptPath(spawnImpl) {
  return commandResult(spawnImpl, 'git', [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'artifactshare/claude-gate-go.json',
  ])
}

async function writeGateReceiptDefault(receipt, spawnImpl) {
  const result = await gateReceiptPath(spawnImpl)
  if (result.code !== 0 || !result.stdout.trim())
    throw new Error(result.stderr || 'Could not determine gate receipt path.')
  const path = result.stdout.trim()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`)
}

function firstLineValue(body, prefix) {
  const line = String(body ?? '')
    .split(/\r?\n/, 1)[0]
    .trim()
  return line.startsWith(`${prefix}: `) ? line.slice(prefix.length + 2) : null
}

function parseDeliveryMode(output) {
  const mode = firstLineValue(output, 'mode')
  return ['monitor', 'turn', 'both', 'off'].includes(mode) ? mode : null
}

function parseHistory(body) {
  return String(body ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const message = JSON.parse(line)
        return message && typeof message === 'object' ? [message] : []
      } catch {
        return []
      }
    })
}

function generateRequestId(
  shortSha,
  now = new Date(),
  random = Math.random,
  existingIds = new Set(),
) {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const hex = Math.floor(random() * 0x1000000000000)
      .toString(16)
      .padStart(12, '0')
    const id = `${shortSha}@${timestamp}-${hex}`
    if (!existingIds.has(id)) return id
  }
  throw new Error('Could not generate a unique review request id.')
}

function roundNumber(shortSha, requestIds) {
  return (
    [...requestIds].filter((id) => id.startsWith(`${shortSha}@`)).length + 1
  )
}

function buildRequestBody({
  requestId,
  shortSha,
  fullSha,
  target,
  depth,
  note,
  round,
  risk,
  effort,
  reviewer: selectedReviewer,
}) {
  const weight =
    depth === 'gate'
      ? '全差分を対象に、最大の深さで見てほしい。最終ゲートなので、このラウンドは 1 回だけである。'
      : '前回のレビュー以降に触った範囲だけを対象にし、深追いせず、その範囲で壊れているかを判断してほしい。'
  return [
    `review-request: ${requestId}`,
    `対象: local commit ${fullSha}、${target}、このラウンドは #r${round}。`,
    `設定: depth=${depth}、risk=${risk}、effort=${effort}、request ID=${requestId}。`,
    '読む範囲: 指定された対象だけを読み、作業ツリーの未 commit の状態や古い remote の差分は読まないこと。',
    '共有 worktree: git checkout、テスト実行、編集、commit をしないこと。追加の実機確認が必要なら別 worktree を使うこと。',
    `このラウンドの重さ: ${weight}`,
    note ? `重点: ${note}` : null,
    '観点: 正確性・回帰・抜けているテスト、再利用・単純化・効率・抽象度の保守性、受け入れ基準との整合。',
    '触ってよい情報: 差分、関連ファイル抜粋、issue / PR 本文、検証結果。',
    '読まないもの: secret、認証情報、.env、秘密鍵、token、顧客データ、個人情報。',
    `返答形式: 1 行目を review-reply: ${requestId} だけにし、続けて GO または重要度順の指摘。1 行目が一致しない返信はこの依頼への回答として扱われない。`,
    `返信の送り方: ${join(scriptsDir, 'send.sh')} ${team} ${selectedReviewer} ${requester} '<本文>'。`,
  ]
    .filter((line) => line !== null)
    .join('\n\n')
}

function selectReply(
  messages,
  seenIds,
  requestId,
  selectedReviewer = reviewer,
) {
  const ignored = []
  for (const message of messages) {
    if (
      seenIds.has(message.id) ||
      message.from !== selectedReviewer ||
      message.to !== requester
    )
      continue
    if (firstLineValue(message.body, 'review-reply') === requestId)
      return { reply: message, ignored }
    ignored.push(message)
  }
  return { reply: null, ignored }
}

async function waitForClose(closed, state, ms) {
  if (state.closed) return true
  let timer
  try {
    await Promise.race([
      closed,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms)
      }),
    ])
    return state.closed
  } finally {
    clearTimeout(timer)
  }
}

async function commandResult(spawnImpl, executable, args, options = {}) {
  const {
    timeoutMs,
    graceMs = killGraceMs,
    killImpl,
    errorLog = () => {},
    ...spawnOptions
  } = options
  if (timeoutMs !== undefined) spawnOptions.detached = true
  const child = spawnImpl(executable, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...spawnOptions,
  })
  let stdout = ''
  let stderr = ''
  // setEncoding before the data handlers. Concatenating raw Buffers splits a
  // multi-byte character at the ~64KB chunk boundary, so a long reply body
  // degrades to U+FFFD while the JSON around it stays parseable — a silent loss.
  child.stdout?.setEncoding?.('utf8')
  child.stderr?.setEncoding?.('utf8')
  child.stdout?.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk) => {
    stderr += chunk
  })

  const state = { closed: false, code: 1 }
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      state.closed = true
      state.code = code ?? 1
      resolve()
    })
  })

  if (timeoutMs === undefined) {
    await closed
    return { code: state.code, stdout, stderr }
  }
  if (await waitForClose(closed, state, timeoutMs))
    return { code: state.code, stdout, stderr }
  // Take the whole group down, not just the direct child: api.sh runs sqlite3 as
  // its own child, and signalling only bash leaves that grandchild holding the
  // stdio pipe — the command would return 124 while node itself never exits.
  // Only this receive-check child is detached; spawn.sh owns the reviewer's
  // terminal and must outlive the command.
  const forceKill = await terminateProcessTree(child.pid, {
    killImpl: killImpl ?? process.kill,
  })
  if (!(await waitForClose(closed, state, graceMs))) {
    await forceKill()
    if (!(await waitForClose(closed, state, graceMs)))
      errorLog(`子プロセスが残っている可能性がある (pid: ${child.pid})。`)
  }
  return { timedOut: true, code: timeoutExitCode, stdout, stderr }
}

async function main({
  argv = process.argv.slice(2),
  spawnImpl = spawn,
  log = console.log,
  errorLog = console.error,
  now = () => new Date(),
  random = Math.random,
  exists = existsSync,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  killImpl,
  writeGateReceipt = writeGateReceiptDefault,
} = {}) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      log(usage())
      return 0
    }
    const statusResult = await commandResult(spawnImpl, 'git', [
      'status',
      '--porcelain',
    ])
    if (statusResult.code !== 0)
      throw new Error(statusResult.stderr || 'Could not inspect the worktree.')
    if (statusResult.stdout.trim())
      throw new Error('Working tree must be clean before review.')
    const shaResult = await commandResult(spawnImpl, 'git', [
      'rev-parse',
      '--short',
      'HEAD',
    ])
    if (shaResult.code !== 0)
      throw new Error(shaResult.stderr || 'Could not read HEAD.')
    const shortSha = shaResult.stdout.trim()
    const fullShaResult = await commandResult(spawnImpl, 'git', [
      'rev-parse',
      'HEAD',
    ])
    if (fullShaResult.code !== 0)
      throw new Error(fullShaResult.stderr || 'Could not read HEAD.')
    const fullSha = fullShaResult.stdout.trim()
    if (!/^[0-9a-f]{7,40}$/u.test(fullSha))
      throw new Error('Could not resolve the committed review SHA.')
    if (options.target === undefined)
      options.target = `origin/main...${fullSha}`
    const profile = reviewProfile(options.depth, options.risk)
    const selectedReviewer = profile.reviewer
    const readyResult = await commandResult(
      spawnImpl,
      'bash',
      [
        '-c',
        'source "$1/lib/actas-lock.sh"; agmsg_ready_path "$2" "$3"',
        '_',
        scriptsDir,
        team,
        selectedReviewer,
      ],
      {
        env: {
          ...process.env,
          SKILL_DIR: scriptsDir.replace(/\/scripts$/, ''),
        },
      },
    )
    if (readyResult.code !== 0)
      throw new Error(
        readyResult.stderr || 'Could not determine reviewer readiness.',
      )
    const sentinel = readyResult.stdout.trim()
    const ready = exists(sentinel)
    const historyArgs = [
      'get',
      'teams',
      team,
      'messages',
      '--agent',
      selectedReviewer,
      '--limit',
      String(historyLimit),
    ]
    const historyResult = await commandResult(
      spawnImpl,
      join(scriptsDir, 'api.sh'),
      historyArgs,
    )
    if (historyResult.code !== 0)
      throw new Error(historyResult.stderr || 'Could not read agmsg history.')
    const messages = parseHistory(historyResult.stdout)
    const seenIds = new Set(messages.map((message) => message.id))
    const requestIds = new Set(
      messages
        .map((message) => firstLineValue(message.body, 'review-request'))
        .filter(Boolean),
    )
    const requestId = generateRequestId(shortSha, now(), random, requestIds)
    const round = roundNumber(shortSha, requestIds)
    const body = buildRequestBody({
      ...options,
      requestId,
      shortSha,
      fullSha,
      round,
      risk: options.risk,
      effort: profile.effort,
      reviewer: selectedReviewer,
    })
    const rootResult = await commandResult(spawnImpl, 'git', [
      'rev-parse',
      '--show-toplevel',
    ])
    if (rootResult.code !== 0)
      throw new Error(rootResult.stderr || 'Could not determine project root.')
    const root = rootResult.stdout.trim()
    const deliveryExecutable = join(scriptsDir, 'delivery.sh')
    const deliveryStatus = await commandResult(spawnImpl, deliveryExecutable, [
      'status',
      'claude-code',
      root,
    ])
    if (deliveryStatus.code !== 0)
      throw new Error(
        `delivery status failed for ${root}: ${deliveryStatus.stderr.trim() || 'unknown error'}`,
      )
    const currentMode = parseDeliveryMode(deliveryStatus.stdout)
    if (currentMode === null)
      throw new Error(
        `delivery status returned an invalid mode for ${root}: ${deliveryStatus.stdout.trim() || '(empty output)'}`,
      )
    const plannedMode = ['monitor', 'both'].includes(currentMode)
      ? null
      : 'monitor'
    const launch = [
      join(scriptsDir, 'spawn.sh'),
      [
        'claude-code',
        selectedReviewer,
        '--project',
        root,
        '--team',
        team,
        '--model',
        'opus',
        '--effort',
        profile.effort,
      ],
    ]
    if (options.dryRun) {
      log(
        JSON.stringify({
          reviewerReady: ready,
          sentinel,
          delivery: { currentMode, plannedMode },
          launch: { executable: launch[0], args: launch[1] },
          request: {
            team,
            from: requester,
            to: selectedReviewer,
            requestId,
            round,
            depth: options.depth,
            risk: options.risk,
            effort: profile.effort,
            target: options.target,
            sha: fullSha,
            body,
          },
          timeoutMs: options.timeoutMs,
        }),
      )
      return 0
    }
    if (plannedMode !== null) {
      const deliverySet = await commandResult(spawnImpl, deliveryExecutable, [
        'set',
        plannedMode,
        'claude-code',
        root,
      ])
      if (deliverySet.code !== 0)
        throw new Error(
          `delivery set failed for ${root}: ${deliverySet.stderr.trim() || 'unknown error'}`,
        )
      log(`delivery mode を ${currentMode} から monitor へ変更した: ${root}`)
    }
    if (!ready) {
      const boot = await commandResult(spawnImpl, launch[0], launch[1])
      if (boot.code === 3) {
        errorLog(
          'reviewer の起動待ちが上限に達した。reviewer は停止していないため、次回実行で再利用される。',
        )
        return 1
      }
      if (boot.code !== 0) {
        errorLog(boot.stderr)
        return 1
      }
    }
    const send = await commandResult(spawnImpl, join(scriptsDir, 'send.sh'), [
      team,
      requester,
      selectedReviewer,
      body,
    ])
    if (send.code !== 0)
      throw new Error(send.stderr || 'Could not send review request.')
    const deadline = Date.now() + options.timeoutMs
    const ignoredIds = new Set()
    let ignoredCount = 0
    const reportIgnored = () => {
      if (ignoredCount)
        errorLog(`対応しない返信 ${ignoredCount} 件を受信した。`)
    }
    while (Date.now() < deadline) {
      const result = await commandResult(
        spawnImpl,
        join(scriptsDir, 'api.sh'),
        historyArgs,
        {
          timeoutMs: Math.max(0, deadline - Date.now()),
          killImpl,
          errorLog,
        },
      )
      if (result.timedOut) {
        reportIgnored()
        return timeoutExitCode
      }
      if (result.code !== 0)
        throw new Error(result.stderr || 'Could not read agmsg history.')
      const selected = selectReply(
        parseHistory(result.stdout),
        seenIds,
        requestId,
        selectedReviewer,
      )
      for (const message of selected.ignored)
        if (!ignoredIds.has(message.id)) {
          ignoredIds.add(message.id)
          ignoredCount += 1
          log(`対応しない返信（この依頼への回答として扱わない）: ${message.id}`)
          log(message.body)
        }
      if (selected.reply) {
        const finalShaResult = await commandResult(spawnImpl, 'git', [
          'rev-parse',
          'HEAD',
        ])
        const finalStatusResult = await commandResult(spawnImpl, 'git', [
          'status',
          '--porcelain',
        ])
        if (
          finalShaResult.code !== 0 ||
          finalStatusResult.code !== 0 ||
          finalShaResult.stdout.trim() !== fullSha ||
          finalStatusResult.stdout.trim()
        )
          throw new Error(
            'Working tree or HEAD changed during review; discard this result and review the current commit again.',
          )
        log(`採用した返信: ${requestId} #r${round}`)
        log(selected.reply.body)
        if (
          !options.dryRun &&
          options.depth === 'gate' &&
          isGateGo(selected.reply.body)
        ) {
          await writeGateReceipt(
            {
              sha: fullSha,
              depth: options.depth,
              risk: options.risk,
              effort: profile.effort,
              reviewer: selectedReviewer,
              requestId,
            },
            spawnImpl,
          )
        }
        return 0
      }
      if (Date.now() >= deadline) break
      await wait(Math.min(pollIntervalMs, deadline - Date.now()))
    }
    reportIgnored()
    return timeoutExitCode
  } catch (error) {
    errorLog(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then((code) => {
    process.exitCode = code
  })
export {
  buildRequestBody,
  defaultTimeoutMs,
  generateRequestId,
  historyLimit,
  killGraceMs,
  main,
  parseArgs,
  parseDeliveryMode,
  parseHistory,
  pollIntervalMs,
  roundNumber,
  selectReply,
  team,
  reviewer,
  requester,
  timeoutExitCode,
  commandResult,
  reviewProfile,
  isGateGo,
}
