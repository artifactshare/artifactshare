#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { reviewReminder } from './codex-review.mjs'

const maxCapturedBytes = 64 * 1024

function usage() {
  return 'Usage: pnpm review:implementation'
}

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  if (args.length === 0) return { help: false }
  if (args.length === 1 && ['-h', '--help'].includes(args[0]))
    return { help: true }
  throw new Error(usage())
}

function commandOutput(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim()
}

function cleanHead(run = commandOutput) {
  const head = run('git', ['rev-parse', 'HEAD'])
  if (run('git', ['status', '--porcelain']))
    throw new Error('Implementation review requires a clean worktree.')
  return head
}

function appendTail(capture, chunk, limit = maxCapturedBytes) {
  const combined = `${capture.text}${chunk}`
  if (Buffer.byteLength(combined) <= limit)
    return { text: combined, truncated: capture.truncated }
  return {
    text: Buffer.from(combined).subarray(-limit).toString(),
    truncated: true,
  }
}

function formatCapture(capture) {
  const value = capture.text.trim()
  return capture.truncated ? `[earlier output omitted]\n${value}` : value
}

function runReviewer(name, { spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      'pnpm',
      [`review:${name}`, '--', '--phase', 'implementation'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = { text: '', truncated: false }
    let stderr = { text: '', truncated: false }
    child.stdout.on('data', (chunk) => (stdout = appendTail(stdout, chunk)))
    child.stderr.on('data', (chunk) => (stderr = appendTail(stderr, chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      const result = {
        name,
        stdout: formatCapture(stdout),
        stderr: formatCapture(stderr),
      }
      if (code === 0) resolve(result)
      else
        reject(
          new Error(
            `${name} review failed (exit ${code}).\n${result.stderr || result.stdout}`,
          ),
        )
    })
  })
}

async function waitForBoth(reviews) {
  const settled = await Promise.allSettled(reviews)
  const failures = settled.filter(({ status }) => status === 'rejected')
  if (failures.length)
    throw new Error(
      failures
        .map(({ reason }) => reason?.message ?? String(reason))
        .join('\n\n'),
    )
  return settled.map(({ value }) => value)
}

function withoutReminder(output) {
  const suffix = `\n${reviewReminder}`
  if (output === reviewReminder) return ''
  return output.endsWith(suffix) ? output.slice(0, -suffix.length) : output
}

async function main({
  argv = process.argv.slice(2),
  readCleanHead = cleanHead,
  review = runReviewer,
  log = console.log,
  timingLog = console.error,
} = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    log(usage())
    return 0
  }
  const head = readCleanHead()
  const results = await waitForBoth([review('codex'), review('claude')])
  if (readCleanHead() !== head)
    throw new Error(
      'HEAD or worktree changed during review; review the current commit again.',
    )
  for (const result of results) {
    log(
      `## ${result.name === 'codex' ? 'Codex' : 'Claude'}\n\n${withoutReminder(result.stdout)}`,
    )
    if (result.stderr) timingLog(result.stderr)
  }
  log(reviewReminder)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })

export {
  appendTail,
  cleanHead,
  formatCapture,
  main,
  parseArgs,
  runReviewer,
  usage,
  waitForBoth,
  withoutReminder,
}
