import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, test } from 'vitest'

const entry = join(import.meta.dirname, '..', 'dist', 'cursor-acp-entry.js')
const roots: string[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function start(
  root: string,
  fixture: string,
  log: string,
): Promise<{ child: ChildProcess; ready: any }> {
  const child = spawn(
    process.execPath,
    [entry, fixture, '--no-open', '--json'],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
        ARTIFACTSHARE_CONFIG_HOME: join(root, 'config'),
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
        FAKE_ACP_LOG: log,
        CODEX_THREAD_ID: '',
        CODEX_SESSION_ID: '',
        CLAUDE_CODE_SESSION_ID: '',
        CURSOR_AGENT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  const ready = await new Promise<any>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error('Cursor preview did not start.')),
      10_000,
    )
    child.stdout!.on('data', (chunk) => {
      buffer += String(chunk)
      const line = buffer
        .split('\n')
        .find((candidate) => candidate.trim().startsWith('{'))
      if (!line) return
      clearTimeout(timer)
      resolve(JSON.parse(line).data)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Cursor preview exited ${code}.`))
    })
  })
  return { child, ready }
}

test('managed Cursor launcher creates then loads the workspace ACP session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'as-cursor-acp-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const log = join(root, 'acp.log')
  const agent = join(bin, 'agent')
  writeFileSync(
    agent,
    `#!/usr/bin/env node
const fs = require('node:fs'); const readline = require('node:readline');
const log = process.env.FAKE_ACP_LOG; const rl = readline.createInterface({input:process.stdin});
rl.on('line', line => { const m=JSON.parse(line); if(m.method) fs.appendFileSync(log,m.method+'\\n');
if(!m.id)return; let result={}; if(m.method==='initialize') result={protocolVersion:1};
if(m.method==='authenticate') result={}; if(m.method==='session/new'||m.method==='session/load') result={sessionId:'cursor-session-1'};
if(m.method==='session/prompt') result={stopReason:'end_turn'};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); });
`,
    { mode: 0o755 },
  )
  chmodSync(agent, 0o755)
  const fixture = join(root, 'report.html')
  writeFileSync(fixture, '<h1>Cursor preview</h1>')

  const first = await start(root, fixture, log)
  assert.equal(first.ready.agent.transport, 'acp_managed')
  first.child.kill('SIGTERM')
  await new Promise((resolve) => first.child.once('exit', resolve))

  const second = await start(root, fixture, log)
  assert.equal(second.ready.agent.transport, 'acp_managed')
  const methods = readFileSync(log, 'utf8')
  assert.match(methods, /session\/new/)
  assert.match(methods, /session\/load/)
})
