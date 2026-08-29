#!/usr/bin/env node

import { startClaudeChannelServer } from './preview/claude-channel.js'

async function main(): Promise<void> {
  const channel = await startClaudeChannelServer()
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const handler = (): void => {
      process.exitCode = 130
      void channel.close().catch(() => undefined)
    }
    process.once(signal, handler)
    return [signal, handler] as const
  })
  try {
    await channel.closed
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Artifact Share Channel failed: ${message}\n`)
  process.exitCode = 1
})
