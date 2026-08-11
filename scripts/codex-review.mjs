#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const defaultModel = 'gpt-5.6-sol'
const defaultBase = 'origin/main'
const defaultTimeoutMs = 1_800_000

function usage() {
  return `Usage: pnpm review:codex -- [options]

Options:
  --model <model>       Review model. Default: ${defaultModel}
  --base <ref>          Git base ref. Default: ${defaultBase}
  --timeout-ms <ms>     Review timeout. Default: ${defaultTimeoutMs}
  --dry-run             Print the invocation without starting review
  -h, --help            Show this help.`
}

function parseArgs(argv) {
  const options = {
    model: defaultModel,
    base: defaultBase,
    timeoutMs: defaultTimeoutMs,
    dryRun: false,
  }
  const args = argv[0] === '--' ? argv.slice(1) : argv
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') return { ...options, help: true }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (!['--model', '--base', '--timeout-ms'].includes(arg))
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${arg}`)
    if (arg === '--model') options.model = value
    if (arg === '--base') options.base = value
    if (arg === '--timeout-ms') options.timeoutMs = Number(value)
  }
  if (!options.model || !options.base)
    throw new Error('Model and base must not be empty.')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
    throw new Error('Invalid --timeout-ms. Use a positive integer.')
  return options
}

function reviewArgs({ model, base }) {
  return ['-m', model, 'review', '--base', base]
}

function gitOutput(exec, args) {
  return exec('git', args, { encoding: 'utf8' }).trim()
}

function main({
  argv = process.argv.slice(2),
  exec = execFileSync,
  run = spawnSync,
  log = console.log,
  errorLog = console.error,
} = {}) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      log(usage())
      return 0
    }
    if (gitOutput(exec, ['status', '--porcelain']))
      throw new Error('Working tree must be clean before review.')
    const head = gitOutput(exec, ['rev-parse', 'HEAD'])
    if (!/^[0-9a-f]{40}$/u.test(head))
      throw new Error('Could not resolve the committed review SHA.')
    gitOutput(exec, ['merge-base', options.base, head])
    const args = reviewArgs(options)
    if (options.dryRun) {
      log(
        JSON.stringify({
          executable: 'codex',
          args,
          timeoutMs: options.timeoutMs,
        }),
      )
      return 0
    }
    const result = run('codex', args, {
      stdio: 'inherit',
      timeout: options.timeoutMs,
    })
    if (result.error) throw result.error
    if (result.status !== 0) return result.status ?? 1
    const finalHead = gitOutput(exec, ['rev-parse', 'HEAD'])
    const finalStatus = gitOutput(exec, ['status', '--porcelain'])
    if (finalHead !== head || finalStatus)
      throw new Error(
        'Working tree or HEAD changed during review; review the current commit again.',
      )
    return 0
  } catch (error) {
    errorLog(error instanceof Error ? error.message : 'Codex review failed.')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main()

export {
  defaultBase,
  defaultModel,
  defaultTimeoutMs,
  main,
  parseArgs,
  reviewArgs,
}
