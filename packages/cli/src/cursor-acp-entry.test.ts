import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
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
  extraEnv: NodeJS.ProcessEnv = {},
  detached = false,
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
        ...extraEnv,
      },
      detached,
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
const log = process.env.FAKE_ACP_LOG; const rl = readline.createInterface({input:process.stdin}); let promptId;
rl.on('line', line => { const m=JSON.parse(line); fs.appendFileSync(log,line+'\\n');
if(m.id===998&&!m.method){ process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:999,method:'session/request_permission',params:{toolCall:{title:'Edit report'},options:[{optionId:'allow-always',kind:'allow_always'},{optionId:'allow-once',kind:'allow_once'},{optionId:'reject-once',kind:'reject_once'}]}})+'\\n'); return; }
if(m.id===999&&!m.method){ process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'cursor-session-1'}})+'\\n'); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}})+'\\n'); return; }
if(!m.id)return; let result={}; if(m.method==='initialize') result={protocolVersion:1};
if(m.method==='authenticate') result={}; if(m.method==='session/new') result={sessionId:'cursor-session-1'};
if(m.method==='session/load'&&process.env.FAKE_FAIL_LOAD==='1'){ process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{message:'missing session'}})+'\\n'); return; }
if(m.method==='session/load') result={};
if(m.method==='session/prompt'&&process.env.FAKE_PROMPT_ERROR==='1'){ if(process.env.FAKE_UNRELATED_UPDATE==='1') process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'cursor-session-1',update:{sessionUpdate:'available_commands_update',availableCommands:[]}}})+'\\n'); setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{message:'prompt failed'}})+'\\n'),50); return; }
if(m.method==='session/prompt'){ promptId=m.id; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:998,method:'cursor/ask_question',params:{questions:[{prompt:'Choose unseen option'}]}})+'\\n'); return; }
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); if((m.method==='session/new'||m.method==='session/load')&&process.env.FAKE_EXIT==='1') setTimeout(()=>process.exit(7),500); });
`,
    { mode: 0o755 },
  )
  chmodSync(agent, 0o755)
  const fixture = join(root, 'report.html')
  writeFileSync(fixture, '<h1>Cursor preview</h1>')

  const first = await start(root, fixture, log)
  assert.equal(first.ready.agent.transport, 'acp_managed')
  const concurrentFixture = join(root, 'concurrent.html')
  writeFileSync(concurrentFixture, '<h1>Concurrent preview</h1>')
  await assert.rejects(
    start(root, concurrentFixture, log),
    /Cursor preview exited 1/,
  )
  const headers = {
    'content-type': 'application/json',
    'x-artifactshare-preview': '1',
  }
  await fetch(`${first.ready.url}api/annotations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      anchor: { kind: 'artifact' },
      comment: 'Only preview next may fetch this comment.',
    }),
  })
  const submitted = await fetch(`${first.ready.url}api/annotations/submit`, {
    method: 'POST',
    headers,
    body: '{}',
  })
  assert.equal(submitted.status, 200)
  assert.equal((await submitted.json()).agent.state, 'queued')
  const afterPrompt = readFileSync(log, 'utf8')
  assert.equal(afterPrompt.includes(fixture), true)
  assert.equal(
    afterPrompt.includes('Only preview next may fetch this comment.'),
    false,
  )
  const permission = afterPrompt
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((message) => message.id === 999 && !message.method)
  assert.equal(permission.result.outcome.optionId, 'reject-once')
  const question = afterPrompt
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((message) => message.id === 998 && !message.method)
  assert.equal(question.result.outcome.outcome, 'cancelled')
  first.child.kill('SIGTERM')
  await new Promise((resolve) => first.child.once('exit', resolve))

  const second = await start(root, fixture, log)
  assert.equal(second.ready.agent.transport, 'acp_managed')
  const methods = readFileSync(log, 'utf8')
  assert.match(methods, /session\/new/)
  assert.match(methods, /session\/load/)

  second.child.kill('SIGTERM')
  await new Promise((resolve) => second.child.once('exit', resolve))
  const recovered = await start(root, fixture, log, { FAKE_FAIL_LOAD: '1' })
  assert.equal(recovered.ready.agent.transport, 'acp_managed')
  const recoveredMethods = readFileSync(log, 'utf8')
  assert.equal(
    (recoveredMethods.match(/"method":"session\/new"/g) ?? []).length,
    2,
  )

  recovered.child.kill('SIGTERM')
  await new Promise((resolve) => recovered.child.once('exit', resolve))
  const failedFixture = join(root, 'failed.html')
  writeFileSync(failedFixture, '<h1>Failed prompt</h1>')
  const failed = await start(root, failedFixture, log, {
    FAKE_PROMPT_ERROR: '1',
    FAKE_UNRELATED_UPDATE: '1',
  })
  await fetch(`${failed.ready.url}api/annotations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ anchor: { kind: 'artifact' }, comment: 'saved' }),
  })
  const failedSubmit = await fetch(
    `${failed.ready.url}api/annotations/submit`,
    { method: 'POST', headers, body: '{}' },
  )
  assert.equal((await failedSubmit.json()).agent.state, 'failed')

  failed.child.kill('SIGTERM')
  await new Promise((resolve) => failed.child.once('exit', resolve))
  const interruptedFixture = join(root, 'interrupted.html')
  writeFileSync(interruptedFixture, '<h1>Interrupted preview</h1>')
  const interrupted = await start(root, interruptedFixture, log, {}, true)
  process.kill(-interrupted.child.pid!, 'SIGINT')
  const interruptedCode = await new Promise((resolve) =>
    interrupted.child.once('exit', resolve),
  )
  assert.equal(interruptedCode, 130)
  assert.equal(
    existsSync(
      join(root, 'config', 'previews', `${interrupted.ready.session}.json`),
    ),
    false,
  )

  const targetedFixture = join(root, 'targeted-interrupt.html')
  writeFileSync(targetedFixture, '<h1>Targeted interrupt</h1>')
  const targeted = await start(root, targetedFixture, log)
  targeted.child.kill('SIGINT')
  const targetedCode = await new Promise((resolve) =>
    targeted.child.once('exit', resolve),
  )
  assert.equal(targetedCode, 130)
  assert.equal(
    existsSync(
      join(root, 'config', 'previews', `${targeted.ready.session}.json`),
    ),
    false,
  )

  const crashedFixture = join(root, 'crashed.html')
  writeFileSync(crashedFixture, '<h1>Crashed ACP</h1>')
  const crashed = await start(root, crashedFixture, log, { FAKE_EXIT: '1' })
  const crashCode = await new Promise((resolve) =>
    crashed.child.once('exit', resolve),
  )
  assert.equal(crashCode, 1)
})
