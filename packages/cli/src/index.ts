#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { checkRuntime } from './runtime.js'

export async function generateCliHelp(path: string[]): Promise<string> {
  return (await import('./cli.js')).generateCliHelp(path)
}

const cliArgv = process.argv.slice(2)
let isDirectExecution = false
if (process.argv[1]) {
  try {
    isDirectExecution =
      realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    isDirectExecution = import.meta.url === pathToFileURL(process.argv[1]).href
  }
}
if (isDirectExecution && checkRuntime(cliArgv)) {
  await (await import('./cli.js')).runCli(cliArgv)
}
