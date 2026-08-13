import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import { expectFailure, expectSuccess, runAsync, withServer } from './test/helpers.js'

let configHome: string

const isolation = () => ({
  ARTIFACTSHARE_CONFIG_HOME: configHome,
  ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  ARTIFACTSHARE_TOKEN: '',
})

beforeEach(async () => {
  configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-cli-import-bot-token-'),
  )
})

afterEach(async () => {
  await rm(configHome, { recursive: true, force: true })
})

function writeJson(response: ServerResponse, body: unknown, status = 200) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

function refreshOkBody() {
  return {
    access_token: 'ass_session-1',
    token_type: 'bearer',
    expires_at: '2099-01-01T00:00:00.000Z',
    refresh_token: 'asr_rotated-1',
    refresh_token_expires_at: '2099-06-01T00:00:00.000Z',
  }
}

test('bot tokens are detected by prefix, rotated, and stored as session credentials', async () => {
  let refreshBody: Record<string, unknown> | null = null
  await withServer(
    (request, response) => {
      if (request.url === '/api/cli/auth/refresh') {
        let raw = ''
        request.on('data', (chunk) => (raw += chunk))
        request.on('end', () => {
          refreshBody = JSON.parse(raw) as Record<string, unknown>
          writeJson(response, refreshOkBody())
        })
        return
      }
      if (request.url === '/api/cli/whoami') {
        writeJson(response, {
          user: { id: 'bot_1', email: 'bot-abc@bots.artifactshare.invalid' },
          workspace: { id: 'wrk_1', hosted_domain: 'example.com' },
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'profiles',
          'import-token',
          '--profile',
          'bot',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        isolation(),
        { input: 'asb_bot-token-1' },
      )
      const payload = expectSuccess(result, 'profiles import-token')
      assert.equal(payload.data.kind, 'bot')
      assert.equal(payload.data.profile, 'bot')
      assert.equal(
        payload.data.user.email,
        'bot-abc@bots.artifactshare.invalid',
      )
      assert.equal(refreshBody?.refresh_token, 'asb_bot-token-1')
      assert.equal(typeof refreshBody?.rotation_request_id, 'string')

      // The ROTATED credential is stored, not the displayed token.
      const tokens = JSON.parse(
        await readFile(join(configHome, 'tokens.json'), 'utf8'),
      )
      const credential = JSON.parse(tokens[`${baseUrl}:bot`]) as Record<
        string,
        unknown
      >
      assert.equal(credential.kind, 'session')
      assert.equal(credential.refresh_token, 'asr_rotated-1')
      assert.equal(credential.session_token, 'ass_session-1')
      assert.ok(!JSON.stringify(tokens).includes('asb_bot-token-1'))

      // kind: 'bot' persists in the profile store.
      const config = JSON.parse(
        await readFile(join(configHome, 'config.json'), 'utf8'),
      )
      assert.equal(config.profiles.bot.kind, 'bot')
      assert.equal(config.profiles.bot.preset, 'agent')

      // profiles list surfaces the bot marker.
      const list = await runAsync(
        ['profiles', 'list', '--json'],
        isolation(),
        {},
      )
      const listPayload = expectSuccess(list, 'profiles list')
      assert.equal(listPayload.data.profiles[0].kind, 'bot')
    },
  )
})

test('a rejected bot token reports bot_token_invalid with a reissue hint', async () => {
  await withServer(
    (request, response) => {
      if (request.url === '/api/cli/auth/refresh') {
        writeJson(response, { error: 'unauthorized' }, 401)
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'profiles',
          'import-token',
          '--profile',
          'bot',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        isolation(),
        { input: 'asb_revoked-token' },
      )
      const payload = expectFailure(result, 'profiles import-token')
      assert.equal(payload.error.code, 'bot_token_invalid')
      assert.match(payload.error.hint ?? '', /reissue/i)
    },
  )
})

test('importing a bot token over an existing credential requires --force and leaves the token unconsumed', async () => {
  let refreshCalls = 0
  await mkdir(configHome, { recursive: true })
  await writeFile(
    join(configHome, 'config.json'),
    JSON.stringify({
      profiles: {
        bot: { base_url: 'http://127.0.0.1:9', token_store: 'plaintext_file' },
      },
    }),
  )
  await withServer(
    (request, response) => {
      if (request.url === '/api/cli/auth/refresh') {
        refreshCalls += 1
        writeJson(response, refreshOkBody())
        return
      }
      if (request.url === '/api/cli/whoami') {
        writeJson(response, {
          user: { id: 'bot_1', email: 'bot-abc@bots.artifactshare.invalid' },
          workspace: { id: 'wrk_1', hosted_domain: null },
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      // Seed an existing credential for the profile.
      await writeFile(
        join(configHome, 'tokens.json'),
        JSON.stringify({
          [`${baseUrl}:bot`]: JSON.stringify({
            kind: 'api_token',
            token: 'old-token',
          }),
        }),
      )
      await writeFile(
        join(configHome, 'config.json'),
        JSON.stringify({
          profiles: {
            bot: { base_url: baseUrl, token_store: 'plaintext_file' },
          },
        }),
      )
      const blocked = await runAsync(
        [
          'profiles',
          'import-token',
          '--profile',
          'bot',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        isolation(),
        { input: 'asb_new-token' },
      )
      const failure = expectFailure(blocked, 'profiles import-token')
      assert.equal(failure.error.code, 'validation_failed')
      assert.match(failure.error.hint ?? '', /--force/)
      // Local rejection happens BEFORE the rotation-consuming refresh, so the
      // server-side credential stays unconsumed.
      assert.equal(refreshCalls, 0)

      const forced = await runAsync(
        [
          'profiles',
          'import-token',
          '--profile',
          'bot',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--force',
          '--json',
        ],
        isolation(),
        { input: 'asb_new-token' },
      )
      expectSuccess(forced, 'profiles import-token')
      assert.equal(refreshCalls, 1)
    },
  )
})

test('non-bot tokens never enter the bot path; --force stays a no-op for API tokens', async () => {
  await withServer(
    (request, response) => {
      if (request.url === '/api/cli/whoami') {
        writeJson(response, {
          user: { id: 'usr_1', email: 'person@example.com' },
          workspace: { id: 'wrk_1', hosted_domain: 'example.com' },
        })
        return
      }
      if (request.url === '/api/cli/auth/refresh') {
        writeJson(response, { error: 'unexpected' }, 500)
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'profiles',
          'import-token',
          '--profile',
          'client-a',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--force',
          '--json',
        ],
        isolation(),
        { input: 'ast_api-token-9' },
      )
      const payload = expectSuccess(result, 'profiles import-token')
      assert.equal(payload.data.kind, undefined)
      const tokens = JSON.parse(
        await readFile(join(configHome, 'tokens.json'), 'utf8'),
      )
      assert.deepEqual(JSON.parse(tokens[`${baseUrl}:client-a`]), {
        kind: 'api_token',
        token: 'ast_api-token-9',
      })
    },
  )
})
