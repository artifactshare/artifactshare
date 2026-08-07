import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const port = 4173
const origin = `http://127.0.0.1:${port}`
const server = spawn(
  'pnpm',
  [
    '--filter',
    '@artifactshare/web',
    'exec',
    'vite',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
)

let output = ''
let spawnError
server.on('error', (error) => {
  spawnError = error
})
server.stdout.on('data', (chunk) => {
  output += chunk
})
server.stderr.on('data', (chunk) => {
  output += chunk
})

async function waitForServer() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (server.exitCode !== null)
      throw new Error(`preview exited with ${server.exitCode}\n${output}`)
    try {
      const response = await fetch(origin)
      if (response.status === 200) return response
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`preview did not become healthy\n${output}`)
}

function signalServerGroup(signal) {
  if (!server.pid) return
  try {
    process.kill(-server.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

try {
  const response = await waitForServer()
  assert.match(await response.text(), /Artifact Share/i)
  const scheduled = await fetch(`${origin}/__scheduled`)
  assert.equal(scheduled.status, 200)
  assert.match(await scheduled.text(), /reconcile triggered/)
  const devSignIn = await fetch(`${origin}/dev/sign-in`)
  assert.equal(devSignIn.status, 404)
  console.log(
    `public runtime smoke: ${response.status} ${origin}; scheduled: ${scheduled.status}; dev sign-in: ${devSignIn.status}`,
  )
} finally {
  signalServerGroup('SIGTERM')
  let shutdownTimer
  if (server.exitCode === null)
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => {
        shutdownTimer = setTimeout(resolve, 5_000)
      }),
    ])
  clearTimeout(shutdownTimer)
  if (server.exitCode === null && server.signalCode === null)
    signalServerGroup('SIGKILL')
}
