import { spawn } from 'node:child_process'
import {
  DEV_SERVICES,
  prepareDevEnvironment,
  selectMissingDevServices,
} from '../../scripts/dev-setup.mjs'

const environment = prepareDevEnvironment({ reset: false })
if (!environment.ok) {
  console.error(
    `Local development prerequisites are not ready: ${environment.reason}`,
  )
  console.error(`Run: ${environment.recoveryCommand}`)
  process.exit(1)
}
environment.actions.forEach((action) => console.log(action))

const { missing, reused } = await selectMissingDevServices(DEV_SERVICES)
for (const service of reused) {
  console.log(`Reusing ${service.name} at ${service.origin}`)
}

const children = new Set()
const reuseOnlyHeartbeat =
  missing.length === 0 ? setInterval(() => {}, 60_000) : null
let shuttingDown = false
let exitCode = 0

for (const {
  name,
  command: [command, ...args],
} of missing) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: process.env,
  })
  children.add(child)

  child.on('error', (error) => {
    console.error(`${name} dev server failed to start: ${error.message}`)
    shutdown(child, 1)
  })

  child.on('close', (code, signal) => {
    children.delete(child)
    if (shuttingDown) {
      maybeExit()
      return
    }
    if (signal) {
      console.error(`${name} dev server exited with signal ${signal}`)
      shutdown(child, 1)
      return
    }
    if (code && code !== 0) {
      console.error(`${name} dev server exited with code ${code}`)
    }
    shutdown(child, code ?? 0)
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(undefined, signal === 'SIGINT' ? 130 : 143)
  })
}

function shutdown(except, code) {
  if (!shuttingDown) {
    shuttingDown = true
    exitCode = code
    stopChildren(except)
  }
  maybeExit()
}

function stopChildren(except) {
  for (const child of children) {
    if (child === except || child.killed) continue
    child.kill('SIGTERM')
  }
}

function maybeExit() {
  if (children.size === 0) {
    if (reuseOnlyHeartbeat) clearInterval(reuseOnlyHeartbeat)
    process.exit(exitCode)
  }
}
