import { spawn } from 'node:child_process'

export const PROVIDER_TIMEOUT_MS = 1_800_000

export function runProvider(
  command,
  args,
  {
    cwd,
    input,
    env,
    signal,
    timeoutMs = PROVIDER_TIMEOUT_MS,
    spawnProcess = spawn,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let settled = false
    let terminationError
    const finish = (error, code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
      }
      if (error) reject(Object.assign(error, { result }))
      else resolve(result)
    }
    const terminate = (error) => {
      if (settled) return
      terminationError = error
      child.kill()
    }
    const abort = () =>
      terminate(signal?.reason ?? new Error('Review aborted.'))
    const timer = setTimeout(
      () => terminate(new Error(`${command} timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    )
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) queueMicrotask(abort)
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', (error) => finish(error))
    child.on('close', (code) => finish(terminationError, code))
    if (input === undefined) child.stdin.end()
    else child.stdin.end(input)
  })
}
