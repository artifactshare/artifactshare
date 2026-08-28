import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  annotationsFilePath,
  previewRealpath,
  previewsDir,
  readSessionFile,
  removeSessionFile,
  resolveLiveSession,
  sessionFilePath,
  sessionIdForPath,
  writeSessionFile,
} from './session.js'
import type { PreviewSessionFile } from './session.js'

function tempEnv(): NodeJS.ProcessEnv {
  return {
    ARTIFACTSHARE_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'preview-session-')),
  }
}

function tempTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), 'preview-target-'))
  const file = join(dir, 'report.html')
  writeFileSync(file, '<h1>hi</h1>')
  return file
}

function sessionFor(
  file: string,
  overrides: Partial<PreviewSessionFile> = {},
): Omit<PreviewSessionFile, 'schema_version'> {
  const realpath = previewRealpath(file)
  assert.ok(realpath.ok)
  const resolved = realpath.ok ? realpath.realpath : ''
  return {
    session_id: sessionIdForPath(resolved),
    realpath: resolved,
    port: 4600,
    share_port: 4601,
    pid: 1234,
    started_at: new Date().toISOString(),
    ...overrides,
  }
}

function identityResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('previewsDir honors ARTIFACTSHARE_CONFIG_HOME', () => {
  const env = tempEnv()
  assert.equal(
    previewsDir(env),
    join(env.ARTIFACTSHARE_CONFIG_HOME ?? '', 'previews'),
  )
})

test('sessionIdForPath is a stable 16-char sha256 prefix', () => {
  const id = sessionIdForPath('/some/real/path')
  assert.match(id, /^[0-9a-f]{16}$/)
  assert.equal(id, sessionIdForPath('/some/real/path'))
  assert.notEqual(id, sessionIdForPath('/some/other/path'))
})

test('session files round trip and unparseable ones read as null', () => {
  const env = tempEnv()
  const file = tempTarget()
  const session = sessionFor(file)
  writeSessionFile(session, env)
  const read = readSessionFile(session.session_id, env)
  assert.deepEqual(read, { schema_version: 1, ...session })

  writeFileSync(sessionFilePath(session.session_id, env), 'not json')
  assert.equal(readSessionFile(session.session_id, env), null)

  removeSessionFile(session.session_id, env)
  assert.equal(readSessionFile(session.session_id, env), null)
  // removing again is fine
  removeSessionFile(session.session_id, env)
})

test('previewRealpath reports missing files as an error value', () => {
  const missing = previewRealpath('/no/such/file/exists.html')
  assert.deepEqual(missing, { ok: false, reason: 'not_found' })
  assert.ok(previewRealpath(tempTarget()).ok)
})

test('resolveLiveSession returns none without a session file', async () => {
  const env = tempEnv()
  const file = tempTarget()
  const fetchStub: typeof fetch = () => {
    throw new Error('must not fetch')
  }
  assert.deepEqual(await resolveLiveSession(file, fetchStub, env), {
    state: 'none',
  })
})

test('resolveLiveSession returns live when the identity matches', async () => {
  const env = tempEnv()
  const file = tempTarget()
  const session = sessionFor(file)
  writeSessionFile(session, env)
  const requested: string[] = []
  const fetchStub: typeof fetch = async (input) => {
    requested.push(String(input))
    return identityResponse({
      service: 'artifactshare-preview',
      session_id: session.session_id,
      realpath: session.realpath,
      share_port: session.share_port,
    })
  }
  const result = await resolveLiveSession(file, fetchStub, env)
  assert.equal(result.state, 'live')
  if (result.state === 'live') {
    assert.equal(result.session.session_id, session.session_id)
  }
  assert.deepEqual(requested, ['http://127.0.0.1:4600/__preview/session'])
})

test('an identity mismatch reclaims the session file but keeps annotations', async () => {
  const env = tempEnv()
  const file = tempTarget()
  const session = sessionFor(file)
  writeSessionFile(session, env)
  const annotations = annotationsFilePath(session.session_id, env)
  writeFileSync(
    annotations,
    JSON.stringify({ schema_version: 1, annotations: [] }),
  )
  const fetchStub: typeof fetch = async () =>
    identityResponse({
      service: 'artifactshare-preview',
      session_id: 'someone-else',
      realpath: session.realpath,
      share_port: session.share_port,
    })
  const result = await resolveLiveSession(file, fetchStub, env)
  assert.deepEqual(result, { state: 'none', reclaimed: true })
  assert.equal(readSessionFile(session.session_id, env), null)
  assert.ok(previewRealpath(annotations).ok)
})

test('a refused connection or a non-identity server reclaims the session file', async () => {
  const env = tempEnv()
  const file = tempTarget()
  const session = sessionFor(file)
  writeSessionFile(session, env)
  const refusing: typeof fetch = async () => {
    throw Object.assign(new Error('connect ECONNREFUSED'), {
      cause: { code: 'ECONNREFUSED' },
    })
  }
  assert.deepEqual(await resolveLiveSession(file, refusing, env), {
    state: 'none',
    reclaimed: true,
  })

  writeSessionFile(session, env)
  const wrongService: typeof fetch = async () =>
    identityResponse({ service: 'something-else' })
  assert.deepEqual(await resolveLiveSession(file, wrongService, env), {
    state: 'none',
    reclaimed: true,
  })
})

test('an inconclusive probe leaves a possibly live session alone', async () => {
  const env = tempEnv()
  const file = tempTarget()
  const session = sessionFor(file)
  writeSessionFile(session, env)
  // A busy preview can miss the probe deadline while still serving, so a
  // timeout must not be read as proof that the session is gone.
  const timingOut: typeof fetch = async () => {
    throw Object.assign(new Error('The operation was aborted'), {
      name: 'TimeoutError',
    })
  }
  assert.deepEqual(await resolveLiveSession(file, timingOut, env), {
    state: 'none',
  })
  assert.ok(readSessionFile(session.session_id, env))
})
