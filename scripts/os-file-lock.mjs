import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const LOCK_ACQUIRE_TIMEOUT_MS = 5_000
export const LOCK_RELEASE_TIMEOUT_MS = 5_000
export const LOCK_TERMINATE_TIMEOUT_MS = 1_000

export function lockInvocation(
  lockPath,
  platform = process.platform,
  wait = false,
) {
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
    return {
      file: 'lockf',
      args: ['-s', ...(wait ? [] : ['-t', '0']), '-k', lockPath, ...holder],
    }
  if (platform === 'linux')
    return {
      file: 'flock',
      args: [...(wait ? [] : ['-n', '-E', '75']), lockPath, ...holder],
    }
  throw new Error('File locking requires lockf on macOS or flock on Linux.')
}

function waitForClose(child, timeoutMs, setTimer = setTimeout) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true)
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

export async function acquireFileLock(lockPath, options = {}) {
  const { wait = false, onContention = () => {}, now = Date.now } = options
  const started = now()
  try {
    return await acquireAttempt(lockPath, { ...options, wait: false })
  } catch (error) {
    if (!wait || error.code !== 'LOCK_BUSY') throw error
  }
  onContention()
  const remaining =
    options.acquireTimeoutMs === undefined
      ? undefined
      : Math.max(0, options.acquireTimeoutMs - (now() - started))
  if (remaining === 0) throw lockTimeout()
  return acquireAttempt(lockPath, {
    ...options,
    wait: true,
    acquireTimeoutMs: remaining,
  })
}

function lockTimeout() {
  return Object.assign(
    new Error('Timed out while acquiring the local file lock.'),
    { code: 'LOCK_TIMEOUT' },
  )
}

export const LANDING_LOCK_TIMEOUT_MS = 600_000

export function landingLockWaitingMessage(path) {
  return `Waiting for another Ready or landing cleanup to release the landing lock: ${path}`
}

export async function acquireLandingLock(
  path,
  {
    acquireLock = acquireFileLock,
    log = (line) => process.stdout.write(`${line}\n`),
  } = {},
) {
  try {
    return await acquireLock(path, {
      wait: true,
      acquireTimeoutMs: LANDING_LOCK_TIMEOUT_MS,
      onContention: () => log(landingLockWaitingMessage(path)),
    })
  } catch (error) {
    if (error.code !== 'LOCK_TIMEOUT') throw error
    throw Object.assign(
      new Error(
        `Timed out after 10 minutes waiting for the landing lock: ${path}. Find the holder with: lsof '${path.replaceAll("'", "'\\''")}'`,
        { cause: error },
      ),
      { code: 'LOCK_TIMEOUT' },
    )
  }
}

function acquireAttempt(
  lockPath,
  {
    wait = false,
    spawnProcess = spawn,
    platform = process.platform,
    // Waiting for another Ready includes its GitHub checks and mutation.
    // Only an explicitly supplied timeout should bound that contention wait.
    acquireTimeoutMs = wait ? undefined : LOCK_ACQUIRE_TIMEOUT_MS,
    releaseTimeoutMs = LOCK_RELEASE_TIMEOUT_MS,
    terminateTimeoutMs = LOCK_TERMINATE_TIMEOUT_MS,
    setTimer = setTimeout,
  } = {},
) {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const invocation = lockInvocation(lockPath, platform, wait)
  return new Promise((resolveLock, reject) => {
    const child = spawnProcess(invocation.file, invocation.args, {
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let settled = false
    let stdout = ''
    let stderr = ''
    const onAcquireTimeout = () => {
      if (settled) return
      settled = true
      const failure = lockTimeout()
      const rejectAfterCleanup = () => reject(failure)
      child.once('close', rejectAfterCleanup)
      try {
        if (child.pid && process.platform !== 'win32')
          process.kill(-child.pid, 'SIGTERM')
        else child.kill()
      } catch (error) {
        if (!['ESRCH', 'EPERM'].includes(error?.code)) {
          reject(error)
          return
        }
      }
      setTimer(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          rejectAfterCleanup()
          return
        }
        try {
          if (child.pid && process.platform !== 'win32')
            process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch (error) {
          if (!['ESRCH', 'EPERM'].includes(error?.code)) {
            reject(error)
            return
          }
        }
        setTimer(rejectAfterCleanup, terminateTimeoutMs)
      }, terminateTimeoutMs)
    }
    const timeout =
      acquireTimeoutMs === undefined
        ? undefined
        : setTimer(onAcquireTimeout, acquireTimeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (settled || !stdout.includes('locked\n')) return
      settled = true
      clearTimeout(timeout)
      let released = false
      resolveLock(async () => {
        if (released) return
        released = true
        if (child.exitCode !== null || child.signalCode !== null) return
        child.stdin.on('error', () => {})
        child.stdin.end()
        if (await waitForClose(child, releaseTimeoutMs, setTimer)) return
        try {
          if (child.pid && process.platform !== 'win32')
            process.kill(-child.pid, 'SIGTERM')
          else child.kill()
        } catch (error) {
          if (!['ESRCH', 'EPERM'].includes(error?.code)) throw error
        }
        if (!(await waitForClose(child, terminateTimeoutMs, setTimer))) {
          try {
            if (child.pid && process.platform !== 'win32')
              process.kill(-child.pid, 'SIGKILL')
            else child.kill('SIGKILL')
          } catch (error) {
            if (!['ESRCH', 'EPERM'].includes(error?.code)) throw error
          }
          await waitForClose(child, terminateTimeoutMs, setTimer)
        }
        throw new Error(
          `Timed out after ${releaseTimeoutMs}ms while releasing the local file lock; terminated the holder with bounded cleanup.`,
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
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(
        Object.assign(
          new Error(
            stderr.trim() || 'Another process already holds the local lock.',
          ),
          { code: code === 75 && !wait ? 'LOCK_BUSY' : 'LOCK_FAILED' },
        ),
      )
    })
  })
}
