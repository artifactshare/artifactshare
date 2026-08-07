import { spawn } from 'node:child_process'

export type SpawnFileResult = {
  status: number | null
  stdout: string
  stderr: string
}

export type BrowserOpenResult = {
  attempted: boolean
  status: 'started' | 'failed' | 'skipped'
  command?: string
  reason?: string
}

type BrowserOpenSkipReason = 'ci' | 'headless_linux'

type BrowserOpener = {
  command: string
  args: string[]
  label: string
}

export function spawnFile(
  command: string,
  args: string[],
  input?: string,
): Promise<SpawnFileResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      resolve({ status: 127, stdout, stderr: error.message })
    })
    child.on('close', (status) => {
      resolve({ status, stdout, stderr })
    })
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}

export function shouldOpenBrowserForLogin(): boolean {
  return browserOpenSkipReason() === null
}

function browserOpenSkipReason(): BrowserOpenSkipReason | null {
  if (process.env.CI === 'true') return 'ci'
  if (
    process.platform === 'linux' &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    return 'headless_linux'
  }
  return null
}

export function resolveBrowserOpener(url: string): BrowserOpener {
  if (process.platform === 'darwin') {
    return { command: 'open', args: [url], label: 'open' }
  }
  if (process.platform === 'win32') {
    return {
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', url],
      label: 'rundll32',
    }
  }
  return { command: 'xdg-open', args: [url], label: 'xdg-open' }
}

const BROWSER_OPENER_CLOSE_TIMEOUT_MS = 1500

type SpawnDetachedResult =
  | { status: 'started' }
  | { status: 'failed'; reason: string }

function spawnDetached(
  command: string,
  args: string[],
): Promise<SpawnDetachedResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    let settled = false

    const finish = (result: SpawnDetachedResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      resolve(result)
    }

    const timeoutId = setTimeout(() => {
      child.unref()
      finish({ status: 'started' })
    }, BROWSER_OPENER_CLOSE_TIMEOUT_MS)

    child.once('error', (error) => {
      finish({
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      })
    })

    child.once('close', (code, signal) => {
      if (signal) {
        finish({ status: 'failed', reason: `signal_${signal}` })
        return
      }
      if (code === 0) {
        finish({ status: 'started' })
        return
      }
      finish({ status: 'failed', reason: `exit_${code ?? 'null'}` })
    })
  })
}

export async function openDeviceAuthorizationUrl(
  url: string,
): Promise<BrowserOpenResult> {
  const testOpener = process.env.ARTIFACTSHARE_TEST_BROWSER_OPENER?.trim()
  if (testOpener === 'success') {
    return { attempted: true, status: 'started', command: 'test' }
  }
  if (testOpener === 'fail') {
    return {
      attempted: true,
      status: 'failed',
      command: 'test',
      reason: 'spawn_failed',
    }
  }

  const skipReason = browserOpenSkipReason()
  if (skipReason) {
    return {
      attempted: false,
      status: 'skipped',
      reason: skipReason,
    }
  }

  const opener = resolveBrowserOpener(url)
  const spawnResult = await spawnDetached(opener.command, opener.args)
  if (spawnResult.status === 'failed') {
    return {
      attempted: true,
      status: 'failed',
      command: opener.label,
      reason: spawnResult.reason,
    }
  }
  return {
    attempted: true,
    status: 'started',
    command: opener.label,
  }
}
