#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { reviewReminder } from './codex-review.mjs'
import {
  readRounds,
  recordRound,
  roundsPath,
  writeRounds,
} from './review-rounds.mjs'

const maxCapturedBytes = 8 * 1024

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
  const combined = Buffer.concat([capture.buffer, Buffer.from(chunk)])
  if (combined.byteLength <= limit)
    return { buffer: combined, truncated: capture.truncated }
  let start = combined.byteLength - limit
  while (start < combined.byteLength && (combined[start] & 0xc0) === 0x80)
    start += 1
  return {
    buffer: combined.subarray(start),
    truncated: true,
  }
}

function formatCapture(capture) {
  const value = capture.buffer.toString('utf8').trim()
  return capture.truncated ? `[earlier output omitted]\n${value}` : value
}

function runReviewer(name, { spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      'pnpm',
      [
        `review:${name}`,
        '--',
        '--phase',
        'implementation',
        '--defer-round-record',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const stdout = []
    let stderr = { buffer: Buffer.alloc(0), truncated: false }
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => (stderr = appendTail(stderr, chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      const result = {
        name,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
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

function recordCompletedRounds(head, run = commandOutput) {
  const branch = run('git', ['branch', '--show-current'])
  if (!branch) return
  for (const reviewer of ['codex', 'claude']) {
    const path = roundsPath(branch, reviewer, run)
    writeRounds(path, recordRound(readRounds(path), { head, reviewer }))
  }
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
  recordRounds = recordCompletedRounds,
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
  recordRounds(head)
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
  recordCompletedRounds,
  runReviewer,
  usage,
  waitForBoth,
  withoutReminder,
}
