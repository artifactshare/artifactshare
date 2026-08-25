#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises'
import { createBridgePolicy, validateBridgeConfig } from './config.js'
import { ArtifactShareBridgeClient } from './client.js'
import { BridgeValidationError } from './errors.js'
import type { ShareIntent, TrustedHostContext } from './types.js'
import { finalizeSnapshot, snapshotInputs } from './validation.js'

type Command = 'check' | 'health' | 'dry-run'

interface ParsedArgs {
  command: Command
  config: string
  intent?: string
  context?: string
}

class FixtureError extends Error {}

void main(process.argv.slice(2)).catch(() => {
  write(
    {
      schema_version: 1,
      command: 'unknown',
      ok: false,
      error: {
        code: 'internal_error',
        message: 'The bridge failed unexpectedly.',
      },
    },
    1,
  )
})

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) return write(parsed.body, 2)
  const args = parsed.value
  let config
  try {
    config = validateBridgeConfig(await readJson(args.config))
  } catch {
    return cliFailure(args.command, 'invalid_config', 2)
  }
  if (args.command === 'check') {
    return write(
      {
        schema_version: 1,
        command: 'check',
        ok: true,
        data: {
          base_url: config.base_url,
          source: config.source,
          allowed_conversation_count: config.allowed_conversations.length,
          credential: {
            kind: 'environment',
            name: 'ARTIFACTSHARE_BRIDGE_TOKEN',
            present: Boolean(process.env.ARTIFACTSHARE_BRIDGE_TOKEN),
          },
        },
      },
      0,
    )
  }
  if (args.command === 'health') {
    const token = process.env.ARTIFACTSHARE_BRIDGE_TOKEN
    if (!token) return cliFailure('health', 'credential_unavailable', 3)
    const client = new ArtifactShareBridgeClient({
      baseUrl: config.base_url,
      timeoutMs: config.request_timeout_ms,
    })
    const result = await client.health({ bearer_token: token })
    if ('ok' in result && !result.ok) {
      return write(
        {
          schema_version: 1,
          command: 'health',
          ok: false,
          error: result,
        },
        exitFor(result.code),
      )
    }
    return write(
      { schema_version: 1, command: 'health', ok: true, data: result },
      0,
    )
  }
  try {
    const intent = decodeFixtureIntent(await readJson(args.intent as string))
    const context = decodeFixtureContext(await readJson(args.context as string))
    const anchor = context.conversation?.privacy_checked_at
    const now =
      anchor === undefined
        ? new Date('2000-01-01T00:00:00.000Z')
        : new Date(anchor)
    const request = await finalizeSnapshot(
      snapshotInputs(intent, context, createBridgePolicy(config), now),
    )
    return write(
      {
        schema_version: 1,
        command: 'dry-run',
        ok: true,
        data: {
          operation: request.intent.operation,
          requested_audience: request.intent.requested_audience,
          content_kind: request.intent.content_kind ?? null,
          file_count: request.files.length,
          total_bytes: request.files.reduce((sum, file) => sum + file.size, 0),
          freshness:
            request.context.conversation.kind === 'public_channel'
              ? 'fixture_anchor_valid'
              : 'not_applicable',
        },
      },
      0,
    )
  } catch (error) {
    if (error instanceof BridgeValidationError) {
      return cliFailure('dry-run', error.code, 2)
    }
    if (error instanceof FixtureError) {
      return cliFailure('dry-run', 'invalid_fixture', 2)
    }
    return cliFailure('dry-run', 'internal_error', 1)
  }
}

function parseArgs(
  argv: string[],
): { ok: true; value: ParsedArgs } | { ok: false; body: unknown } {
  const command = argv[0]
  const usage = () => ({
    schema_version: 1,
    command: typeof command === 'string' ? command : 'unknown',
    ok: false,
    error: {
      code: 'invalid_cli_usage',
      message:
        'Use check, health, or dry-run with --config and mandatory --json.',
    },
  })
  if (
    !['check', 'health', 'dry-run'].includes(command ?? '') ||
    !argv.includes('--json')
  ) {
    return { ok: false, body: usage() }
  }
  const options = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--json') continue
    if (!['--config', '--intent', '--context'].includes(item ?? '')) {
      return { ok: false, body: usage() }
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--') || options.has(item as string)) {
      return { ok: false, body: usage() }
    }
    options.set(item as string, value)
    index += 1
  }
  const config = options.get('--config')
  if (!config) return { ok: false, body: usage() }
  if (command === 'dry-run') {
    const intent = options.get('--intent')
    const context = options.get('--context')
    if (!intent || !context) return { ok: false, body: usage() }
    return {
      ok: true,
      value: { command, config, intent, context },
    }
  }
  if (options.has('--intent') || options.has('--context')) {
    return { ok: false, body: usage() }
  }
  return { ok: true, value: { command: command as Command, config } }
}

async function readJson(path: string): Promise<unknown> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 37_748_736) throw new FixtureError()
    const bytes = await readFile(path)
    if (bytes.byteLength > 37_748_736) throw new FixtureError()
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    if (error instanceof FixtureError) throw error
    throw new FixtureError()
  }
}

function decodeFixtureIntent(value: unknown): ShareIntent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FixtureError()
  }
  const record = value as Record<string, unknown>
  if (
    record.schema_version !== 1 ||
    Object.keys(record).some(
      (key) =>
        ![
          'schema_version',
          'operation',
          'requested_audience',
          'title',
          'target_artifact_id',
          'content',
        ].includes(key),
    )
  ) {
    throw new FixtureError()
  }
  const content = record.content
  return {
    operation: record.operation as ShareIntent['operation'],
    requested_audience:
      record.requested_audience as ShareIntent['requested_audience'],
    ...(record.title === undefined ? {} : { title: record.title as string }),
    ...(record.target_artifact_id === undefined
      ? {}
      : { target_artifact_id: record.target_artifact_id as string }),
    ...(content === undefined ? {} : { content: decodeContent(content) }),
  }
}

function decodeContent(value: unknown): NonNullable<ShareIntent['content']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FixtureError()
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'file') {
    if (Object.keys(record).some((key) => !['kind', 'file'].includes(key))) {
      throw new FixtureError()
    }
    return { kind: 'file', file: decodeFile(record.file) }
  }
  if (record.kind === 'static_site' && Array.isArray(record.files)) {
    if (Object.keys(record).some((key) => !['kind', 'files'].includes(key))) {
      throw new FixtureError()
    }
    return { kind: 'static_site', files: record.files.map(decodeFile) }
  }
  throw new FixtureError()
}

function decodeFixtureContext(value: unknown): TrustedHostContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FixtureError()
  }
  const record = value as Record<string, unknown>
  if (
    record.schema_version !== 1 ||
    Object.keys(record).some(
      (key) =>
        ![
          'schema_version',
          'source',
          'conversation',
          'requester',
          'request_id',
        ].includes(key),
    )
  ) {
    throw new FixtureError()
  }
  return {
    source: record.source as TrustedHostContext['source'],
    conversation: record.conversation as TrustedHostContext['conversation'],
    requester: record.requester as TrustedHostContext['requester'],
    request_id: record.request_id as string,
  }
}

function decodeFile(value: unknown): {
  path: string
  media_type: string
  bytes: Uint8Array<ArrayBuffer>
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FixtureError()
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (
    keys.some((key) => !['path', 'media_type', 'bytes_base64'].includes(key)) ||
    typeof record.path !== 'string' ||
    typeof record.media_type !== 'string' ||
    typeof record.bytes_base64 !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      record.bytes_base64,
    )
  ) {
    throw new FixtureError()
  }
  const bytes = Uint8Array.from(Buffer.from(record.bytes_base64, 'base64'))
  if (Buffer.from(bytes).toString('base64') !== record.bytes_base64) {
    throw new FixtureError()
  }
  return { path: record.path, media_type: record.media_type, bytes }
}

function cliFailure(command: string, code: string, exit: number): void {
  write(
    {
      schema_version: 1,
      command,
      ok: false,
      error: { code, message: 'The requested bridge check failed.' },
    },
    exit,
  )
}

function exitFor(code: string): number {
  if (
    code === 'credential_unavailable' ||
    code === 'transport_error' ||
    code === 'timeout'
  ) {
    return 3
  }
  if (code === 'invalid_server_response' || code === 'internal_error') return 1
  return 2
}

function write(value: unknown, exitCode: number): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
  process.exitCode = exitCode
}
