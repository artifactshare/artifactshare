#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { terminateProcessTree } from './lib/process-tree.mjs'

const defaultModel = 'gpt-5.6-sol'
const defaultBase = 'origin/main'
const defaultTimeoutMs = 1_800_000
const defaultMcpTimeoutMs = 30_000
const namePattern = /^[A-Za-z0-9_-]+$/

const featureArgs = [
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
]

function usage() {
  return `Usage: pnpm review:codex -- [options] [PROMPT]

Options:
  --model <model>       Review model. Default: ${defaultModel}
  --base <ref>          Git base ref. Default: ${defaultBase}
  --timeout-ms <ms>     Review timeout. Default: ${defaultTimeoutMs}
  --dry-run             Print the safe invocation without starting review
  -h, --help            Show this help.`
}

function parseArgs(argv) {
  const options = {
    model: defaultModel,
    base: defaultBase,
    timeoutMs: defaultTimeoutMs,
    dryRun: false,
    prompt: '',
  }
  let parsingOptions = true

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (parsingOptions && arg === '--') {
      if (index > 0) parsingOptions = false
      continue
    }
    if (parsingOptions && (arg === '-h' || arg === '--help')) {
      return { ...options, help: true }
    }
    if (parsingOptions && arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (
      parsingOptions &&
      (arg === '--model' || arg === '--base' || arg === '--timeout-ms')
    ) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`)
      }
      index += 1
      if (arg === '--model') options.model = value
      if (arg === '--base') options.base = value
      if (arg === '--timeout-ms') options.timeoutMs = Number(value)
      continue
    }
    if (parsingOptions && arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`)
    }
    options.prompt = options.prompt ? `${options.prompt} ${arg}` : arg
  }

  if (!options.model || !options.base) {
    throw new Error('Model and base must not be empty.')
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('Invalid --timeout-ms. Use a positive integer.')
  }
  return options
}

function isPluginMcp(entry) {
  if (entry.plugin != null || entry.plugin_name != null) return true
  const source = entry.source
  return (
    typeof source === 'string' &&
    (source === 'plugin' || source.startsWith('plugin:'))
  )
}

function parseMcpNames(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('Could not parse Codex MCP list output.')
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.mcp_servers)
      ? parsed.mcp_servers
      : null
  if (!entries) throw new Error('Unexpected Codex MCP list output.')

  const names = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || isPluginMcp(entry)) continue
    if (typeof entry.name !== 'string' || !namePattern.test(entry.name)) {
      throw new Error('Codex MCP list contained an invalid MCP name.')
    }
    if (names.includes(entry.name)) {
      throw new Error('Codex MCP list contained a duplicate MCP name.')
    }
    names.push(entry.name)
  }
  return names
}

function mcpListArgs() {
  return ['mcp', 'list', '--json', ...featureArgs]
}

function reviewArgs({ model, base, mcpNames, prompt }) {
  const normalizedPrompt = Array.isArray(prompt) ? prompt.join(' ') : prompt
  const targetArgs = normalizedPrompt
    ? [
        `Review the changes against the base ref ${base}. Inspect the diff from that base and report actionable findings only. Additional review instructions: ${normalizedPrompt}`,
      ]
    : ['--base', base]
  const overrides = mcpNames.flatMap((name) => [
    '-c',
    `mcp_servers.${name}.enabled=false`,
  ])
  return ['-m', model, 'review', ...featureArgs, ...overrides, ...targetArgs]
}

function collectChild(child, state = {}) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      state.closed = true
      resolve({ code, signal, stdout, stderr })
    })
  })
}

async function waitForClose(resultPromise, state, timeoutMs) {
  if (state.closed) return true
  let timer
  await Promise.race([
    resultPromise,
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  clearTimeout(timer)
  return state.closed
}

async function listMcpNames({
  spawnImpl = spawn,
  timeoutMs = defaultMcpTimeoutMs,
  platform = process.platform,
  killImpl = process.kill,
  graceMs = 250,
  closeTimeoutMs = 250,
} = {}) {
  const child = spawnImpl('codex', mcpListArgs(), {
    detached: platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { closed: false }
  const resultPromise = collectChild(child, state)
  let timeout
  try {
    const result = await Promise.race([
      resultPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('Codex MCP list timed out.'))
        }, timeoutMs)
      }),
    ])
    if (result.code !== 0) throw new Error('Codex MCP list failed.')
    return parseMcpNames(result.stdout)
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Codex MCP list timed out.'
    ) {
      const forceKill = await terminateProcessTree(child.pid, {
        platform,
        killImpl,
        spawnImpl,
      })
      if (!(await waitForClose(resultPromise, state, graceMs))) {
        const forceExitCode = await forceKill()
        if (!(await waitForClose(resultPromise, state, closeTimeoutMs))) {
          const detail =
            forceExitCode === undefined
              ? ''
              : ` (taskkill exited with code ${forceExitCode})`
          throw new Error(
            `Codex MCP list did not exit after force kill${detail}.`,
          )
        }
      }
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function runReview({
  args,
  timeoutMs,
  spawnImpl = spawn,
  platform = process.platform,
  killImpl = process.kill,
  graceMs = 250,
  closeTimeoutMs = 250,
} = {}) {
  const child = spawnImpl('codex', args, {
    detached: platform !== 'win32',
    stdio: 'inherit',
  })
  const state = { closed: false }
  const resultPromise = collectChild(child, state)
  let timeout
  let result
  try {
    result = await Promise.race([
      resultPromise,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
  if (!result.timedOut) return result.code ?? 1

  const forceKill = await terminateProcessTree(child.pid, {
    platform,
    killImpl,
    spawnImpl,
  })
  if (!(await waitForClose(resultPromise, state, graceMs))) {
    const forceExitCode = await forceKill()
    if (!(await waitForClose(resultPromise, state, closeTimeoutMs))) {
      const detail =
        forceExitCode === undefined
          ? ''
          : ` (taskkill exited with code ${forceExitCode})`
      throw new Error(`Codex review did not exit after force kill${detail}.`)
    }
  }
  return 124
}

async function main({
  argv = process.argv.slice(2),
  spawnImpl = spawn,
  log = console.log,
  errorLog = console.error,
  gitExec = execFileSync,
} = {}) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      log(usage())
      return 0
    }
    const dirty = gitExec('git', ['status', '--porcelain'], {
      encoding: 'utf8',
    }).trim()
    if (dirty) throw new Error('Working tree must be clean before review.')
    const head = gitExec('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    if (!/^[0-9a-f]{40}$/u.test(head))
      throw new Error('Could not resolve the committed review SHA.')
    const mcpNames = await listMcpNames({ spawnImpl })
    const exactPrompt = [
      `The reviewed local commit is exactly ${head}. Do not inspect uncommitted content or another revision.`,
      options.prompt,
    ]
      .filter(Boolean)
      .join(' ')
    const args = reviewArgs({ ...options, prompt: exactPrompt, mcpNames })
    if (options.dryRun) {
      log(
        JSON.stringify({
          executable: 'codex',
          args,
          timeoutMs: options.timeoutMs,
          disabledMcpNames: mcpNames,
        }),
      )
      return 0
    }
    const reviewCode = await runReview({
      args,
      timeoutMs: options.timeoutMs,
      spawnImpl,
    })
    if (reviewCode !== 0) return reviewCode
    const finalHead = gitExec('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const finalStatus = gitExec('git', ['status', '--porcelain'], {
      encoding: 'utf8',
    }).trim()
    if (finalHead !== head || finalStatus)
      throw new Error(
        'Working tree or HEAD changed during review; discard this result and review the current commit again.',
      )
    return 0
  } catch (error) {
    errorLog(error instanceof Error ? error.message : 'Codex review failed.')
    return 1
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then((code) => {
    process.exitCode = code
  })
}

export {
  defaultBase,
  defaultMcpTimeoutMs,
  defaultModel,
  defaultTimeoutMs,
  featureArgs,
  listMcpNames,
  main,
  mcpListArgs,
  parseArgs,
  parseMcpNames,
  reviewArgs,
  runReview,
  terminateProcessTree,
}
