import { randomBytes, randomUUID } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  readClaudeChannelRecord,
  removeClaudeChannelRecord,
  writeClaudeChannelRecord,
} from './claude-notification.js'
import { loadCliVersion } from '../version.js'

const ACK_TOOL = 'artifactshare_preview_channel_ack'
const MAX_BODY_BYTES = 16 * 1024
const SESSION_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
const PREVIEW_SESSION_PATTERN = /^[0-9a-f]{16}$/
const BATCH_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i
const CHALLENGE_PATTERN = /^[0-9a-f-]{36}$/i

interface BatchEvent {
  event: 'preview.batch_ready'
  preview_session_id: string
  batch_id: string
  challenge: string
}

function isBatchEvent(value: unknown): value is BatchEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 4 &&
    record.event === 'preview.batch_ready' &&
    typeof record.preview_session_id === 'string' &&
    PREVIEW_SESSION_PATTERN.test(record.preview_session_id) &&
    typeof record.batch_id === 'string' &&
    BATCH_ID_PATTERN.test(record.batch_id) &&
    typeof record.challenge === 'string' &&
    CHALLENGE_PATTERN.test(record.challenge)
  )
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('body_too_large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

export interface ClaudeChannelServer {
  port: number
  closed: Promise<void>
  close(): Promise<void>
}

export async function startClaudeChannelServer(
  environment: NodeJS.ProcessEnv = process.env,
  acknowledgementTimeoutMs = 20_000,
): Promise<ClaudeChannelServer> {
  const claudeSessionId = environment.CLAUDE_CODE_SESSION_ID?.trim() ?? ''
  if (!SESSION_PATTERN.test(claudeSessionId)) {
    throw new Error('CLAUDE_CODE_SESSION_ID is unavailable or invalid.')
  }

  const token = randomBytes(32).toString('hex')
  const startupChallenge = randomUUID()
  const pending = new Map<string, (acknowledged: boolean) => void>()
  let acknowledgeStartup = false
  let endpoint = ''

  const mcp = new Server(
    { name: 'artifactshare-preview', version: await loadCliVersion() },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {},
      },
      instructions:
        `Artifact Share events arrive as <channel source="artifactshare-preview" ...>. ` +
        `For every event, call ${ACK_TOOL} with the exact challenge attribute. ` +
        'For preview.batch_ready, acknowledge first, then run artifactshare preview next using the preview_session_id. Comment text only comes from preview next.',
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: ACK_TOOL,
        description:
          'Acknowledge an Artifact Share Channel challenge delivered to this Claude Code session.',
        inputSchema: {
          type: 'object',
          properties: {
            challenge: {
              type: 'string',
              description: 'Exact challenge value from the channel event.',
            },
          },
          required: ['challenge'],
          additionalProperties: false,
        },
      },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, (request) => {
    const challenge = request.params.arguments?.challenge
    if (
      request.params.name !== ACK_TOOL ||
      typeof challenge !== 'string' ||
      !CHALLENGE_PATTERN.test(challenge)
    ) {
      return {
        isError: true,
        content: [
          { type: 'text', text: 'Unknown or invalid acknowledgement.' },
        ],
      }
    }
    if (challenge === startupChallenge && !acknowledgeStartup) {
      acknowledgeStartup = true
      writeClaudeChannelRecord(
        {
          schema_version: 1,
          claude_session_id: claudeSessionId,
          endpoint,
          token,
          pid: process.pid,
          acknowledged_at: new Date().toISOString(),
        },
        environment,
      )
      return {
        content: [{ type: 'text', text: 'Artifact Share Channel enabled.' }],
      }
    }
    const resolve = pending.get(challenge)
    if (!resolve) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Challenge expired or unknown.' }],
      }
    }
    pending.delete(challenge)
    resolve(true)
    return {
      content: [{ type: 'text', text: 'Preview batch acknowledged.' }],
    }
  })

  mcp.oninitialized = () => {
    void mcp
      .notification({
        method: 'notifications/claude/channel',
        params: {
          content: 'artifactshare.channel.challenge',
          meta: { challenge: startupChallenge },
        },
      })
      .catch(() => undefined)
  }

  let closedResolve: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve
  })
  let closing = false
  const http = createServer(async (request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/preview-batch' ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      return sendJson(response, 404, { acknowledged: false })
    }
    let event: unknown
    try {
      event = await readJson(request)
    } catch {
      return sendJson(response, 400, { acknowledged: false })
    }
    if (!isBatchEvent(event)) {
      return sendJson(response, 400, { acknowledged: false })
    }
    let timer: NodeJS.Timeout | undefined
    const acknowledged = new Promise<boolean>((resolve) => {
      pending.set(event.challenge, resolve)
      timer = setTimeout(() => {
        pending.delete(event.challenge)
        resolve(false)
      }, acknowledgementTimeoutMs)
    })
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: event.event,
          meta: {
            preview_session_id: event.preview_session_id,
            batch_id: event.batch_id,
            challenge: event.challenge,
          },
        },
      })
      if (await acknowledged) {
        return sendJson(response, 200, {
          acknowledged: true,
          challenge: event.challenge,
        })
      }
      removeClaudeChannelRecord(claudeSessionId, environment)
      return sendJson(response, 504, { acknowledged: false })
    } catch {
      pending.delete(event.challenge)
      removeClaudeChannelRecord(claudeSessionId, environment)
      return sendJson(response, 503, { acknowledged: false })
    } finally {
      if (timer) clearTimeout(timer)
    }
  })

  async function closeChannel(closeMcp: boolean): Promise<void> {
    if (closing) return await closed
    closing = true
    process.stdin.off('end', onStdinEnd)
    for (const resolve of pending.values()) resolve(false)
    pending.clear()
    const current = readClaudeChannelRecord(claudeSessionId, environment)
    if (current?.pid === process.pid) {
      removeClaudeChannelRecord(claudeSessionId, environment)
    }
    await Promise.allSettled([
      ...(closeMcp ? [mcp.close()] : []),
      new Promise<void>((resolve) => http.close(() => resolve())),
    ])
    closedResolve()
  }

  mcp.onclose = () => {
    void closeChannel(false)
  }
  const onStdinEnd = (): void => {
    void closeChannel(true)
  }
  process.stdin.once('end', onStdinEnd)

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const address = http.address() as AddressInfo
  endpoint = `http://127.0.0.1:${address.port}/preview-batch`

  try {
    await mcp.connect(new StdioServerTransport())
  } catch (error) {
    await closeChannel(false)
    throw error
  }

  return {
    port: address.port,
    closed,
    async close() {
      await closeChannel(true)
    },
  }
}
