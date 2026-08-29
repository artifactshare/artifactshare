#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatCursorPermissionRequest } from './preview/cursor-permission.js'
import { previewsDir, processAlive } from './preview/session.js'
import {
  CURSOR_ACP_ACK_TIMEOUT_MS,
  type CursorAcpTarget,
} from './preview/cursor-notification.js'

type Rpc = {
  jsonrpc?: string
  id?: number
  method?: string
  params?: any
  result?: any
  error?: any
}
const input = process.argv[2]
if (!input || input === '--help' || input === '-h') {
  process.stdout.write(
    'Usage: artifactshare-preview-cursor <file> [preview options]\n',
  )
  process.exit(input ? 0 : 1)
}
const cwd = process.cwd()
const stateDir = join(previewsDir(), 'cursor-acp')
const statePath = join(
  stateDir,
  `${createHash('sha256').update(cwd).digest('hex')}.json`,
)
mkdirSync(stateDir, { recursive: true, mode: 0o700 })
const lockPath = `${statePath}.lock`
function acquireWorkspaceLock(): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = openSync(lockPath, 'wx', 0o600)
      writeSync(handle, String(process.pid))
      closeSync(handle)
      return
    } catch {
      let owner = 0
      let initializing = false
      try {
        owner = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
        if (!Number.isInteger(owner) || owner <= 0) {
          const lock = statSync(lockPath, { throwIfNoEntry: false })
          initializing = lock !== undefined && Date.now() - lock.mtimeMs < 5_000
        }
      } catch {
        const lock = statSync(lockPath, { throwIfNoEntry: false })
        initializing = lock !== undefined && Date.now() - lock.mtimeMs < 5_000
      }
      if (
        initializing ||
        (Number.isInteger(owner) && owner > 0 && processAlive(owner))
      ) {
        throw new Error(
          'A managed Cursor preview is already running in this workspace.',
        )
      }
      rmSync(lockPath, { force: true })
    }
  }
  throw new Error('Could not acquire the managed Cursor workspace lock.')
}
function releaseWorkspaceLock(): void {
  try {
    if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) {
      rmSync(lockPath, { force: true })
    }
  } catch {
    /* already released */
  }
}
acquireWorkspaceLock()
process.once('exit', releaseWorkspaceLock)
let prior: { session_id?: string; cwd?: string } = {}
try {
  prior = JSON.parse(readFileSync(statePath, 'utf8'))
} catch {
  /* first run */
}

const agent = spawn('agent', ['acp'], {
  cwd,
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
})
let nextId = 1
let busy = false
let agentAvailable = true
let stopping = false
let fatalAgentFailure = false
let bridge: Server | undefined
let preview: ChildProcess | undefined
let sessionId = ''
let promptAccepted: { resolve(): void; reject(error: Error): void } | undefined
let cancelActivePermission: (() => void) | undefined
const pending = new Map<
  number,
  { resolve(value: any): void; reject(error: Error): void }
>()
function failAgent(error: Error): void {
  if (!agentAvailable) return
  agentAvailable = false
  if (!stopping) fatalAgentFailure = true
  cancelActivePermission?.()
  promptAccepted?.reject(error)
  promptAccepted = undefined
  for (const waiter of pending.values()) waiter.reject(error)
  pending.clear()
  bridge?.close()
  if (!stopping && preview?.exitCode === null) preview.kill('SIGTERM')
}
agent.once('error', failAgent)
agent.stdin.on('error', failAgent)
agent.once('exit', () => {
  // A foreground-group Ctrl-C can report the child's exit before Node runs the
  // wrapper's SIGINT listener. Defer classification so cancellation does not
  // depend on signal delivery order.
  setImmediate(() => failAgent(new Error('Cursor ACP process exited.')))
})
function send(method: string, params: unknown): Promise<any> {
  if (!agentAvailable || !agent.stdin.writable)
    return Promise.reject(new Error('Cursor ACP process is unavailable.'))
  const id = nextId++
  return new Promise((resolveRequest, reject) => {
    pending.set(id, { resolve: resolveRequest, reject })
    agent.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      (error) => {
        if (!error) return
        pending.delete(id)
        reject(error)
      },
    )
  })
}
function respond(id: number, result: unknown): void {
  if (!agentAvailable || !agent.stdin.writable) return
  agent.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
function respondError(id: number, code: number, message: string): void {
  if (!agentAvailable || !agent.stdin.writable) return
  agent.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`,
  )
}
async function answerPermission(message: Rpc): Promise<void> {
  const options = Array.isArray(message.params?.options)
    ? message.params.options
    : []
  const allow = options.find(
    (option: any) =>
      typeof option?.optionId === 'string' &&
      (option.kind === 'allow_once' || option.optionId === 'allow-once'),
  )
  const reject = options.find(
    (option: any) =>
      typeof option?.optionId === 'string' &&
      (option.kind === 'reject_once' || option.optionId === 'reject-once'),
  )
  let approved = false
  if (process.stdin.isTTY && allow) {
    const requestDetails = formatCursorPermissionRequest(
      message.params?.toolCall,
    )
    const terminal = createInterface({
      input: process.stdin,
      output: process.stderr,
    })
    approved = await new Promise<boolean>((resolveAnswer) => {
      let settled = false
      const finish = (answer: boolean): void => {
        if (settled) return
        settled = true
        cancelActivePermission = undefined
        terminal.close()
        resolveAnswer(answer)
      }
      cancelActivePermission = () => finish(false)
      terminal.once('SIGINT', () => finish(false))
      terminal.once('close', () => finish(false))
      terminal.question(
        `\nCursor tool request:\n${requestDetails}\nAllow once? [y/N] `,
        (answer) => {
          finish(answer.trim().toLowerCase() === 'y')
        },
      )
    })
  }
  const selected = approved ? allow : reject
  respond(
    message.id!,
    selected
      ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
      : { outcome: { outcome: 'cancelled' } },
  )
}
let permissionQueue = Promise.resolve()
createInterface({ input: agent.stdout }).on('line', (line) => {
  let message: Rpc
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (
    typeof message.id === 'number' &&
    (message.result !== undefined || message.error !== undefined) &&
    !message.method
  ) {
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) {
      waiter.reject(
        new Error(message.error.message ?? 'Cursor ACP request failed.'),
      )
    } else {
      waiter.resolve(message.result)
    }
    return
  }
  if (
    message.method === 'session/request_permission' &&
    typeof message.id === 'number'
  ) {
    permissionQueue = permissionQueue
      .then(() => answerPermission(message))
      .catch(() => respond(message.id!, { outcome: { outcome: 'cancelled' } }))
  } else if (
    (message.method === 'cursor/ask_question' ||
      message.method === 'cursor/create_plan') &&
    typeof message.id === 'number'
  ) {
    respond(message.id, { outcome: { outcome: 'cancelled' } })
  } else if (
    message.method === 'session/update' &&
    promptAccepted &&
    message.params?.sessionId === sessionId &&
    [
      'agent_message_chunk',
      'agent_thought_chunk',
      'tool_call',
      'tool_call_update',
      'plan',
    ].includes(message.params?.update?.sessionUpdate)
  ) {
    promptAccepted?.resolve()
    promptAccepted = undefined
  } else if (typeof message.id === 'number' && message.method) {
    respondError(
      message.id,
      -32601,
      `Unsupported ACP request: ${message.method}`,
    )
  }
})

async function initializeSession(): Promise<string> {
  await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: 'artifactshare-preview-cursor', version: '1' },
  })
  await send('authenticate', { methodId: 'cursor_login' })
  if (prior.session_id && prior.cwd === cwd) {
    try {
      await send('session/load', {
        sessionId: prior.session_id,
        cwd,
        mcpServers: [],
      })
      return prior.session_id
    } catch {
      const created = await send('session/new', { cwd, mcpServers: [] })
      if (typeof created?.sessionId !== 'string')
        throw new Error('Cursor ACP did not return a session id.')
      return created.sessionId
    }
  }
  const created = await send('session/new', { cwd, mcpServers: [] })
  if (typeof created?.sessionId !== 'string')
    throw new Error('Cursor ACP did not return a session id.')
  return created.sessionId
}
try {
  sessionId = await initializeSession()
} catch (error) {
  agent.kill()
  throw error
}
const temp = `${statePath}.${process.pid}.tmp`
writeFileSync(
  temp,
  JSON.stringify({ schema_version: 1, session_id: sessionId, cwd }, null, 2),
  { mode: 0o600 },
)
renameSync(temp, statePath)

const token = randomBytes(32).toString('hex')
const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/preview-batch') {
    response.writeHead(404).end()
    return
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end()
    return
  }
  if (busy) {
    response.writeHead(409).end()
    return
  }
  // Claim the single managed conversation before reading the body. Otherwise
  // two requests can both pass the guard and overwrite the one active prompt.
  busy = true
  let bodyComplete = false
  request.once('aborted', () => {
    if (!bodyComplete) busy = false
  })
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => {
    body += chunk
    if (body.length > 16_384) request.destroy()
  })
  request.on('end', async () => {
    bodyComplete = true
    let event: any
    try {
      event = JSON.parse(body)
    } catch {
      busy = false
      response.writeHead(400).end()
      return
    }
    if (
      event?.event !== 'preview.batch_ready' ||
      typeof event.preview_session_id !== 'string' ||
      typeof event.batch_id !== 'string'
    ) {
      busy = false
      response.writeHead(400).end()
      return
    }
    if (!agentAvailable) {
      busy = false
      response.writeHead(503).end()
      return
    }
    const filePath = resolve(cwd, input)
    const text = `Artifact Share preview batch ready for ${JSON.stringify(filePath)}. event=preview.batch_ready preview_session_id=${event.preview_session_id} batch_id=${event.batch_id}. Run: npm exec --yes --package=@artifactshare/cli -- artifactshare preview next --session ${event.preview_session_id} --json. Fetch all comment text only with preview next.`
    const accepted = new Promise<void>((resolveAccepted, reject) => {
      promptAccepted = { resolve: resolveAccepted, reject }
    })
    const prompt = send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    })
    const promptTimer = setTimeout(() => {
      failAgent(new Error('Cursor ACP preview prompt timed out.'))
      agent.kill('SIGTERM')
    }, CURSOR_ACP_ACK_TIMEOUT_MS)
    promptTimer.unref()
    void accepted.then(
      () => clearTimeout(promptTimer),
      () => clearTimeout(promptTimer),
    )
    void prompt
      .then((result) => {
        if (result?.stopReason === 'end_turn') promptAccepted?.resolve()
        else
          promptAccepted?.reject(
            new Error('Cursor ACP did not complete the preview prompt.'),
          )
      })
      .catch((error) => promptAccepted?.reject(error))
      .finally(() => {
        busy = false
        promptAccepted = undefined
      })
    try {
      await accepted
      response.writeHead(202).end()
    } catch {
      response.writeHead(agentAvailable ? 502 : 503).end()
    }
  })
})
bridge = server
await new Promise<void>((resolveListen, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolveListen)
})
const address = server.address()
if (!address || typeof address === 'string')
  throw new Error('Cursor ACP bridge did not bind.')
const target: CursorAcpTarget = {
  schema_version: 1,
  endpoint: `http://127.0.0.1:${address.port}/preview-batch`,
  token,
  pid: process.pid,
  session_id: sessionId,
  cwd,
}
preview = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('./index.js', import.meta.url)),
    'preview',
    input,
    ...process.argv.slice(3),
  ],
  {
    cwd,
    env: {
      ...process.env,
      CODEX_THREAD_ID: '',
      CODEX_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      ARTIFACTSHARE_CURSOR_ACP_TARGET: JSON.stringify(target),
    },
    stdio: 'inherit',
  },
)
// Ctrl-C already reaches every process in the terminal foreground group. Keep
// the wrapper alive long enough to observe the preview's graceful exit without
// delivering a second SIGINT. SIGTERM is commonly targeted at the wrapper, so
// it still needs explicit propagation.
process.once('SIGINT', () => {
  stopping = true
  process.exitCode = 130
  cancelActivePermission?.()
  const targetedSignalFallback = setTimeout(() => {
    if (preview?.exitCode === null) preview.kill('SIGTERM')
    if (agent.exitCode === null) agent.kill('SIGTERM')
  }, 2_000)
  targetedSignalFallback.unref()
})
process.once('SIGTERM', () => {
  stopping = true
  cancelActivePermission?.()
  preview?.kill('SIGTERM')
  agent.kill('SIGTERM')
})
const exitCode = await new Promise<number>((resolveExit) =>
  preview!.once('exit', (code) => resolveExit(code ?? 1)),
)
stopping = true
server.close()
agent.stdin.end()
agent.kill()
releaseWorkspaceLock()
process.exitCode = fatalAgentFailure ? 1 : exitCode
