import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const LOCK_ACQUIRE_TIMEOUT_MS = 5_000
export const LOCK_RELEASE_TIMEOUT_MS = 5_000
export const LOCK_TERMINATE_TIMEOUT_MS = 1_000

export function lockInvocation(lockPath, platform = process.platform) {
  const holderSource = `
const parent = Number(process.argv[1])
const timer = setInterval(() => {
  try { process.kill(parent, 0) } catch { process.exit(0) }
}, 250)
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
`
  const holder = [
    process.execPath,
    '-e',
    `process.stdout.write('locked\\n'); ${holderSource}`,
    String(process.pid),
  ]
  if (platform === 'darwin')
    return { file: 'lockf', args: ['-s', '-t', '0', '-k', lockPath, ...holder] }
  if (platform === 'linux')
    return { file: 'flock', args: ['-n', lockPath, ...holder] }
  throw new Error('File locking requires lockf on macOS or flock on Linux.')
}

function waitForClose(child, timeoutMs, setTimer = setTimeout) {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let done = false
    let timer
    const finish = (closed) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.off('close', onClose)
      resolve(closed)
    }
    const onClose = () => finish(true)
    child.once('close', onClose)
    timer = setTimer(() => finish(false), timeoutMs)
  })
}

export function acquireFileLock(
  lockPath,
  {
    spawnProcess = spawn,
    platform = process.platform,
    acquireTimeoutMs = LOCK_ACQUIRE_TIMEOUT_MS,
    releaseTimeoutMs = LOCK_RELEASE_TIMEOUT_MS,
    terminateTimeoutMs = LOCK_TERMINATE_TIMEOUT_MS,
    setTimer = setTimeout,
  } = {},
) {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const invocation = lockInvocation(lockPath, platform)
  return new Promise((resolveLock, reject) => {
    const child = spawnProcess(invocation.file, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let settled = false
    let stdout = ''
    let stderr = ''
    const timeout = setTimer(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('Timed out while acquiring the local file lock.'))
    }, acquireTimeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (settled || !stdout.includes('locked\n')) return
      settled = true
      clearTimeout(timeout)
      let released = false
      resolveLock(async () => {
        if (released) return
        released = true
        if (child.exitCode !== null) return
        child.stdin.end()
        if (await waitForClose(child, releaseTimeoutMs, setTimer)) return
        child.kill()
        await waitForClose(child, terminateTimeoutMs, setTimer)
        throw new Error(
          `Timed out after ${releaseTimeoutMs}ms while releasing the local file lock; terminated the holder and waited ${terminateTimeoutMs}ms for cleanup.`,
        )
      })
    })
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(
        new Error(
          stderr.trim() || 'Another process already holds the local lock.',
        ),
      )
    })
  })
}
