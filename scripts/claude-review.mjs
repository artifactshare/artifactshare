#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { terminateProcessTree } from './lib/process-tree.mjs'

const defaultTimeoutMs = 1_800_000
const versionTimeoutMs = 30_000
const maxOutputBytes = 16 * 1024 * 1024
const timeoutExitCode = 124
const killGraceMs = 250
const claudeVersion = '2.1.226 (Claude Code)'
const resultGitPath = 'artifactshare/claude-gate-review.txt'
const receiptGitPath = 'artifactshare/claude-gate-review.json'
const baseGuidance =
  'Read only AGENTS.md, CLAUDE.md, docs/reference/development-constraints.md, and files needed to review the committed Git range supplied to /code-review. Do not read CLAUDE.local.md, anything outside the repository root, uncommitted state, or private-repository context. Do not checkout, edit, test, commit, push, or write to GitHub.'
const allowedTools = ['Bash', 'Read', 'Grep', 'Glob', 'Agent']

function usage() {
  return `Usage: pnpm review:claude -- [options]

Options:
  --target <range>       Loop-only Git range. Default: origin/main...<full HEAD SHA>
  --depth <loop|gate>    Review depth. Default: loop
  --risk <normal|high>   Risk class. Default: normal (high requires gate)
  --note <text>          Specific focus for this review
  --timeout-ms <ms>      Claude review timeout. Default: ${defaultTimeoutMs}
  --dry-run              Print the validated invocation without starting Claude
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
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '--') continue
    if (name === '-h' || name === '--help') return { ...options, help: true }
    if (name === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (
      !['--target', '--depth', '--risk', '--note', '--timeout-ms'].includes(
        name,
      )
    )
      throw new Error(
        name.startsWith('-')
          ? `Unknown option: ${name}`
          : `Unexpected positional argument: ${name}`,
      )
    const value = argv[++index]
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Missing value for ${name}`)
    if (name === '--target') options.target = value
    if (name === '--depth') options.depth = value
    if (name === '--risk') options.risk = value
    if (name === '--note') options.note = value
    if (name === '--timeout-ms') options.timeoutMs = Number(value)
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
  if (
    options.note !== undefined &&
    (options.note.length > 500 || /[\r\n]/u.test(options.note))
  )
    throw new Error(
      '--note must be at most 500 characters and contain no newline.',
    )
  return options
}

function reviewLevel(depth, risk) {
  if (depth === 'loop' && risk === 'normal') return 'low'
  if (depth === 'gate' && risk === 'normal') return 'high'
  if (depth === 'gate' && risk === 'high') return 'xhigh'
  throw new Error('Unsupported review depth/risk combination.')
}

function syncResult(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeout,
    maxBuffer: maxOutputBytes,
  })
  return {
    code: result.status,
    error: result.error,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function requireGit(run, cwd, args, message) {
  const result = run('git', args, { cwd })
  if (result.error || result.code !== 0)
    throw new Error(
      `${message}: ${result.stderr || result.error?.message || 'git failed'}`,
    )
  return result.stdout.trim()
}

function splitRange(target) {
  if (
    target.length > 256 ||
    !/^[@\w][@\w./~^-]*\.\.\.?[@\w][@\w./~^-]*$/u.test(target)
  )
    throw new Error(
      'Target must be one valid Git diff range of at most 256 characters.',
    )
  const separator = target.includes('...') ? '...' : '..'
  const index = target.lastIndexOf(separator)
  const left = target.slice(0, index)
  const right = target.slice(index + separator.length)
  if (
    !left ||
    !right ||
    left.startsWith('-') ||
    right.startsWith('-') ||
    left.includes('..') ||
    right.includes('..')
  )
    throw new Error('Target has invalid Git range endpoints.')
  return { left, right }
}

function resolveGitPath(run, cwd, gitPath) {
  return requireGit(
    run,
    cwd,
    ['rev-parse', '--path-format=absolute', '--git-path', gitPath],
    `Could not resolve ${gitPath}`,
  )
}

function invalidate(paths) {
  rmSync(paths.result, { force: true })
  rmSync(paths.receipt, { force: true })
}

function buildInvocation({ level, target, note }) {
  const prompt = `/code-review ${level} ${target}`
  const systemPrompt = `${baseGuidance}${note ? ` Additional focus: ${note}` : ''}`
  const args = [
    '--safe-mode',
    '--model',
    'opus',
    '--tools',
    'Bash,Read,Grep,Glob,Agent',
    '--allowedTools',
    ...allowedTools,
    '--permission-mode',
    'dontAsk',
    '--append-system-prompt',
    systemPrompt,
    '--no-session-persistence',
    '-p',
    prompt,
    '--output-format',
    'json',
  ]
  return { args, prompt, systemPrompt }
}

async function runClaude({
  args,
  cwd,
  env,
  timeoutMs,
  spawnImpl = spawn,
  killImpl = process.kill,
}) {
  return await new Promise((resolve, reject) => {
    const child = spawnImpl('claude', args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let bytes = 0
    let settled = false
    let stopping = false
    let timer
    const signalCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }
    const signalHandlers = Object.fromEntries(
      Object.entries(signalCodes).map(([signal, code]) => [
        signal,
        () => void stop({ signalExitCode: code }),
      ]),
    )
    const removeSignalHandlers = () => {
      for (const [signal, handler] of Object.entries(signalHandlers))
        process.off(signal, handler)
    }
    const finish = (value, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      removeSignalHandlers()
      if (error) reject(error)
      else resolve(value)
    }
    const stop = async (reason) => {
      if (stopping || settled) return
      stopping = true
      try {
        const force = await terminateProcessTree(child.pid, {
          killImpl,
          spawnImpl,
        })
        await new Promise((done) => setTimeout(done, killGraceMs))
        force()
      } catch {}
      finish(reason)
    }
    const capture = (chunks, chunk) => {
      bytes += chunk.length
      if (bytes > maxOutputBytes) void stop({ overflow: true })
      else chunks.push(chunk)
    }
    child.stdout?.on('data', (chunk) => capture(stdout, chunk))
    child.stderr?.on('data', (chunk) => capture(stderr, chunk))
    child.once('error', (error) => {
      if (!stopping) finish(undefined, error)
    })
    child.once('close', (code, signal) => {
      if (!stopping)
        finish({
          code,
          signal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        })
    })
    for (const [signal, handler] of Object.entries(signalHandlers))
      process.once(signal, handler)
    timer = setTimeout(() => void stop({ timedOut: true }), timeoutMs)
  })
}

function writeArtifacts(paths, resultBytes, receipt) {
  const suffix = `${process.pid}-${randomBytes(8).toString('hex')}`
  const resultTemp = `${paths.result}.${suffix}.tmp`
  const receiptTemp = `${paths.receipt}.${suffix}.tmp`
  mkdirSync(dirname(paths.result), { recursive: true })
  try {
    writeFileSync(resultTemp, resultBytes)
    writeFileSync(receiptTemp, `${JSON.stringify(receipt, null, 2)}\n`)
    renameSync(resultTemp, paths.result)
    renameSync(receiptTemp, paths.receipt)
  } catch (error) {
    rmSync(resultTemp, { force: true })
    rmSync(receiptTemp, { force: true })
    invalidate(paths)
    throw error
  }
}

async function main({
  argv = process.argv.slice(2),
  run = syncResult,
  spawnImpl = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
  now = () => new Date(),
  killImpl = process.kill,
} = {}) {
  let paths
  let gate = false
  try {
    const options = parseArgs(argv)
    if (options.help) {
      stdout.write(`${usage()}\n`)
      return 0
    }
    const root = requireGit(
      run,
      undefined,
      ['rev-parse', '--show-toplevel'],
      'Not in a Git repository',
    )
    paths = {
      result: resolveGitPath(run, root, resultGitPath),
      receipt: resolveGitPath(run, root, receiptGitPath),
    }
    gate = options.depth === 'gate' && !options.dryRun
    if (gate) invalidate(paths)

    const version = run('claude', ['--version'], {
      cwd: root,
      timeout: versionTimeoutMs,
    })
    if (
      version.error ||
      version.signal ||
      version.code !== 0 ||
      version.stdout.trim() !== claudeVersion
    )
      throw new Error(
        `preflight: Claude Code ${claudeVersion} is required; found ${version.stdout.trim() || version.error?.message || version.signal || 'unavailable'}.`,
      )
    const status = requireGit(
      run,
      root,
      ['status', '--porcelain'],
      'Could not inspect worktree',
    )
    if (status) throw new Error('preflight: working tree must be clean.')
    const sha = requireGit(
      run,
      root,
      ['rev-parse', 'HEAD'],
      'Could not resolve HEAD',
    )
    const target = options.target || `origin/main...${sha}`
    const { left, right } = splitRange(target)
    const baseSha = requireGit(
      run,
      root,
      ['rev-parse', '--verify', '--end-of-options', `${left}^{commit}`],
      'Invalid left target endpoint',
    )
    requireGit(
      run,
      root,
      ['rev-parse', '--verify', '--end-of-options', `${right}^{commit}`],
      'Invalid right target endpoint',
    )
    const diff = run(
      'git',
      ['diff', '--quiet', '--end-of-options', target, '--'],
      { cwd: root },
    )
    if (diff.code === 0)
      throw new Error('preflight: review target has an empty diff.')
    if (diff.error || diff.code !== 1)
      throw new Error(
        `preflight: could not inspect review diff: ${diff.stderr || diff.error?.message || 'git failed'}`,
      )

    const level = reviewLevel(options.depth, options.risk)
    const invocation = buildInvocation({ level, target, note: options.note })
    if (options.dryRun) {
      stdout.write(
        `${JSON.stringify({ dryRun: true, sha, target, depth: options.depth, risk: options.risk, requestedLevel: level, timeoutMs: options.timeoutMs, command: 'claude', args: invocation.args, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' }, unsetEnv: ['CLAUDE_CODE_REPORT_FINDINGS', 'CLAUDE_CODE_EFFORT_LEVEL'], cwd: root, prompt: invocation.prompt, systemPrompt: invocation.systemPrompt }, null, 2)}\n`,
      )
      return 0
    }
    const env = { ...process.env, CLAUDE_CODE_SUBAGENT_MODEL: 'opus' }
    delete env.CLAUDE_CODE_REPORT_FINDINGS
    delete env.CLAUDE_CODE_EFFORT_LEVEL
    const startedAt = now().toISOString()
    const review = await runClaude({
      args: invocation.args,
      cwd: root,
      env,
      timeoutMs: options.timeoutMs,
      spawnImpl,
      killImpl,
    })
    if (review.timedOut) return timeoutExitCode
    if (review.signalExitCode) return review.signalExitCode
    if (review.overflow)
      throw new Error(`review: Claude output exceeded ${maxOutputBytes} bytes.`)
    if (review.code !== 0)
      throw new Error(
        `review: Claude exited ${review.code}: ${review.stderr.toString('utf8')}`,
      )
    let envelope
    try {
      envelope = JSON.parse(review.stdout.toString('utf8'))
    } catch {
      throw new Error('review: Claude returned malformed JSON.')
    }
    const result = typeof envelope.result === 'string' ? envelope.result : ''
    const resultBytes = Buffer.from(result, 'utf8')
    const denials = Array.isArray(envelope.permission_denials)
      ? envelope.permission_denials
      : null
    if (
      envelope.is_error !== false ||
      envelope.subtype !== 'success' ||
      !result.trim()
    )
      throw new Error(
        'review: Claude returned an invalid or unsuccessful envelope.',
      )
    if (!denials)
      throw new Error(
        'review: Claude response is missing a permission_denials array.',
      )
    if (denials.length) {
      stdout.write(resultBytes)
      stderr.write(`review: permission denials: ${JSON.stringify(denials)}\n`)
      return 1
    }
    const finalSha = requireGit(
      run,
      root,
      ['rev-parse', 'HEAD'],
      'Could not re-read HEAD',
    )
    const finalStatus = requireGit(
      run,
      root,
      ['status', '--porcelain'],
      'Could not re-read worktree',
    )
    if (finalSha !== sha || finalStatus)
      throw new Error('review: HEAD or worktree changed during review.')
    const finishedAt = now().toISOString()
    if (gate) {
      const digest = createHash('sha256').update(resultBytes).digest('hex')
      writeArtifacts(paths, resultBytes, {
        sha,
        depth: 'gate',
        risk: options.risk,
        requestedLevel: level,
        target,
        baseSha,
        claudeVersion,
        resultSha256: digest,
        resultBytes: resultBytes.length,
        startedAt,
        finishedAt,
      })
    }
    stdout.write(resultBytes)
    return 0
  } catch (error) {
    if (gate && paths) {
      try {
        invalidate(paths)
      } catch {}
    }
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then((code) => {
    process.exitCode = code
  })

export {
  allowedTools,
  baseGuidance,
  buildInvocation,
  claudeVersion,
  defaultTimeoutMs,
  killGraceMs,
  main,
  maxOutputBytes,
  parseArgs,
  receiptGitPath,
  resultGitPath,
  reviewLevel,
  runClaude,
  splitRange,
  timeoutExitCode,
  usage,
  versionTimeoutMs,
}
