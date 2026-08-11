#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { specReviewPrompt } from './spec-review-input.mjs'

const defaultModel = 'gpt-5.6-sol'
const defaultBase = 'origin/main'

function usage() {
  return `Usage:
  pnpm review:codex -- --phase implementation [options]
  pnpm review:codex -- --phase spec --artifact-url <url> --version-id <id> [options]

Options:
  --phase <phase>       Review phase: implementation or spec
  --artifact-url <url> Artifact Share URL for spec review
  --version-id <id>    Exact Artifact Share version for spec review
  --model <model>       Review model. Default: ${defaultModel}
  --base <ref>          Git base ref. Default: ${defaultBase}
  --dry-run             Print the invocation without starting review
  -h, --help            Show this help.`
}

function parseArgs(argv) {
  const options = {
    model: defaultModel,
    base: defaultBase,
    phase: 'implementation',
    artifactUrl: undefined,
    versionId: undefined,
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
    if (
      ![
        '--model',
        '--base',
        '--phase',
        '--artifact-url',
        '--version-id',
      ].includes(arg)
    )
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${arg}`)
    if (arg === '--model') options.model = value
    if (arg === '--base') options.base = value
    if (arg === '--phase') options.phase = value
    if (arg === '--artifact-url') options.artifactUrl = value
    if (arg === '--version-id') options.versionId = value
  }
  if (!options.model || !options.base)
    throw new Error('Model and base must not be empty.')
  if (!['spec', 'implementation'].includes(options.phase))
    throw new Error('--phase must be spec or implementation.')
  if (options.phase === 'spec') {
    if (!options.artifactUrl || !options.versionId)
      throw new Error('spec review requires --artifact-url and --version-id.')
  } else if (options.artifactUrl || options.versionId) {
    throw new Error('implementation review does not accept spec options.')
  }
  return options
}

function reviewRequest(options, prompt) {
  if (options.phase === 'spec')
    return {
      args: ['exec', '-m', options.model, '--sandbox', 'read-only', '-'],
      input: prompt,
    }
  return { args: ['-m', options.model, 'review', '--base', options.base] }
}

function commandOutput(exec, file, args) {
  return exec(file, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim()
}

function gitOutput(exec, args) {
  return commandOutput(exec, 'git', args)
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
    if (options.phase === 'implementation')
      gitOutput(exec, ['merge-base', options.base, head])
    const prompt =
      options.phase === 'spec' && !options.dryRun
        ? specReviewPrompt({
            ...options,
            run: (file, args) => commandOutput(exec, file, args),
          })
        : undefined
    const request = reviewRequest(options, prompt)
    if (options.dryRun) {
      log(
        JSON.stringify({
          executable: 'codex',
          args: request.args,
          phase: options.phase,
          artifactUrl: options.artifactUrl,
          versionId: options.versionId,
        }),
      )
      return 0
    }
    const result = run('codex', request.args, {
      input: request.input,
      stdio: request.input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
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

export { defaultBase, defaultModel, main, parseArgs, reviewRequest, usage }
