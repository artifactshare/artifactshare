import { spawn } from 'node:child_process'
import { parseStream } from './records.mjs'

// Inspect each completed event in order, even when a provider coalesces the
// terminal event with tool results. Exactly N completed cycles may still answer.
export function turnBudget(agent, maxTurns, cwd) {
  let pending = '',
    checked = '',
    exceeded = false
  function inspect(line) {
    checked += line + '\n'
    exceeded ||= parseStream(agent, checked, cwd).turns > maxTurns
  }
  return {
    push(chunk) {
      pending += chunk
      let newline
      while ((newline = pending.indexOf('\n')) >= 0) {
        inspect(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
      }
      return exceeded
    },
    finish() {
      if (pending) inspect(pending)
      pending = ''
      return exceeded
    },
  }
}

export function runProcess({
  command,
  cwd,
  env,
  prompt = '',
  timeoutMs,
  maxTurns = Infinity,
  agent,
  signal,
  onOutput = () => {},
}) {
  if (signal?.aborted)
    return { status: 'interrupted', stdout: '', stderr: '', exitCode: null }
  return new Promise((resolve) => {
    let stdout = '',
      stderr = '',
      status,
      killTimer,
      done = false
    // Cursor documents the initial prompt as a positional argument.
    const args =
      agent === 'cursor' && prompt
        ? [...command.slice(1), prompt]
        : command.slice(1)
    const child = spawn(command[0], args, {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const kill = (killSignal) => {
      try {
        process.kill(-child.pid, killSignal)
      } catch (error) {
        if (error.code !== 'ESRCH' && child.pid) throw error
      }
    }
    const stop = (reason) => {
      if (status) return
      status = reason
      kill('SIGTERM')
      killTimer = setTimeout(() => kill('SIGKILL'), 500)
    }
    const abort = () => stop('interrupted')
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    const budget = agent ? turnBudget(agent, maxTurns, cwd) : null
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdin.on('error', () => {})
    child.stdin.end(agent === 'cursor' ? '' : prompt)
    child.stdout.on('data', (data) => {
      stdout += data
      onOutput('stdout', stdout)
      if (budget?.push(data)) stop('turn-limit')
    })
    child.stderr.on('data', (data) => {
      stderr += data
      onOutput('stderr', stderr)
    })
    const finish = (code, error) => {
      if (done) return
      done = true
      if (budget?.finish() && !status) status = 'turn-limit'
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', abort)
      // Also terminate descendants left behind by a provider that exited early.
      kill('SIGKILL')
      resolve({
        status:
          status ??
          (error || code !== 0 ? 'infrastructure-error' : 'completed'),
        stdout,
        stderr,
        exitCode: code,
        error: error ? (error.code ?? 'spawn_failed') : undefined,
      })
    }
    child.once('error', (error) => finish(null, error))
    child.once('close', (code) => finish(code))
  })
}
