#!/usr/bin/env node
import { checkRuntime } from './runtime.js'

if (checkRuntime(process.argv.slice(2))) {
  await (await import('./cursor-acp.js')).runCursorAcp()
}
