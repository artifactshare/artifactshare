import { spawn } from 'node:child_process'

export const PROVIDER_TIMEOUT_MS = 1_800_000
export const PROVIDER_TERMINATE_TIMEOUT_MS = 1_000
const MAX_STDOUT_BYTES = 16 * 1024 * 1024
const MAX_STDERR_BYTES = 8 * 1024

function appendTail(buffer, chunk, limit) {
  const combined = Buffer.concat([buffer, Buffer.from(chunk)])
  if (combined.byteLength <= limit) return combined
  let start = combined.byteLength - limit
  while (start < combined.byteLength && (combined[start] & 0xc0) === 0x80)
    start += 1
  return combined.subarray(start)
}

function terminateGroup(child, signal) {
  try {
    if (child.pid && process.platform !== 'win32')
      process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch (error) {
    if (!['ESRCH', 'EPERM'].includes(error?.code)) throw error
  }
}

export function runProvider(
  command,
  args,
  {
    cwd,
    input,
    env,
    signal,
    timeoutMs = PROVIDER_TIMEOUT_MS,
    terminateTimeoutMs = PROVIDER_TERMINATE_TIMEOUT_MS,
    spawnProcess = spawn,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    let stdoutBytes = 0
    let stderr = Buffer.alloc(0)
    let stderrTruncated = false
    let settled = false
    let terminationError
    let terminateTimer
    let forceTimer
    const result = (code) => ({
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: `${stderrTruncated ? '[earlier output omitted]\n' : ''}${stderr.toString('utf8')}`,
      code,
    })
    const finish = (error, code) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(terminateTimer)
      clearTimeout(forceTimer)
      signal?.removeEventListener('abort', abort)
      if (!error) {
        resolve(result(code))
        return
      }
      const failure = new Error(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      )
      failure.result = result(code)
      reject(failure)
    }
    const terminate = (error) => {
      if (settled || terminationError) return
      terminationError = error
      try {
        terminateGroup(child, 'SIGTERM')
      } catch (killError) {
        finish(killError)
        return
      }
      terminateTimer = setTimeout(() => {
        try {
          terminateGroup(child, 'SIGKILL')
        } catch (killError) {
          finish(killError)
          return
        }
        forceTimer = setTimeout(
          () => finish(terminationError),
          terminateTimeoutMs,
        )
      }, terminateTimeoutMs)
    }
    const abort = () =>
      terminate(signal?.reason ?? new Error('Review aborted.'))
    const timeoutTimer = setTimeout(
      () => terminate(new Error(`${command} timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    )
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) queueMicrotask(abort)
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        terminate(
          new Error(`${command} output exceeded ${MAX_STDOUT_BYTES} bytes.`),
        )
        return
      }
      stdout.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.byteLength + chunk.length > MAX_STDERR_BYTES)
        stderrTruncated = true
      stderr = appendTail(stderr, chunk, MAX_STDERR_BYTES)
    })
    child.stdin.on('error', (error) => terminate(error))
    child.on('error', (error) => finish(error))
    child.on('close', (code) => finish(terminationError, code))
    if (input === undefined) child.stdin.end()
    else child.stdin.end(input)
  })
}
