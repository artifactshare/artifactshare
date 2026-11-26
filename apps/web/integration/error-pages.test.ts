import { createHmac } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Window } from 'happy-dom'
import { buildUsercontentApp } from '../app/test/usercontent-build'
import { integrationWorkerConfig } from '../app/test/integration-worker-config'
import {
  createTestHarness,
  unstable_readConfig,
  unstable_splitSqlQuery,
} from 'wrangler'

test('production document errors render localized root and Settings content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'error-pages-'))
  const webRoot = new URL('..', import.meta.url).pathname
  try {
    await buildUsercontentApp(directory, async (project) => {
      for (const [fault, module] of [
        ['root', 'root.tsx'],
        ['settings', 'routes/_protected/settings/_content/general.tsx'],
      ]) {
        const path = join(project, 'app', module)
        const source = await readFile(path, 'utf8')
        // Read the request from the loader's arguments, so the fault does not
        // depend on which parameters the loader destructures.
        const injected = source.replace(
          /(export async function loader\([\s\S]*?\)[^{]*\{)/,
          '$1\n' +
            `if (arguments[0].request.headers.get('x-test-error') === '${fault}') {const error=new Error('private-message-${fault}'); error.stack='private-stack-${fault}';throw error}`,
        )
        expect(injected).not.toBe(source)
        await writeFile(path, injected)
      }
    })
    const build = join(directory, 'build/server')
    const built = JSON.parse(
      await readFile(join(build, 'wrangler.json'), 'utf8'),
    )
    const config = integrationWorkerConfig(built, {
      ...unstable_readConfig(
        { config: join(webRoot, 'wrangler.jsonc') },
        { hideWarnings: true },
      ),
    })
    const configPath = join(build, 'wrangler.error-pages.json')
    await writeFile(configPath, JSON.stringify(config))
    const secret = 'error-pages-test-only-'.repeat(3)
    const harness = createTestHarness({
      root: webRoot,
      workers: [
        {
          configPath,
          vars: {
            APP_ENV: 'production',
            BETTER_AUTH_URL: 'https://artifactshare.com',
          },
          secrets: { BETTER_AUTH_SECRET: secret },
        },
        {
          configPath: 'wrangler.sandbox.jsonc',
          secrets: { BETTER_AUTH_SECRET: secret },
        },
        { configPath: 'wrangler.og-image.jsonc' },
        { configPath: 'wrangler.alerts.jsonc' },
      ],
    })
    try {
      await harness.listen()
      const worker = harness.getWorker(built.name)
      const { DB } = await worker.getEnv()
      const schema = await readFile(join(webRoot, 'db/schema.sql'), 'utf8')
      await DB.batch(
        unstable_splitSqlQuery(
          schema.replace(/^PRAGMA foreign_keys = ON;$/m, ''),
        ).map((sql) => DB.prepare(sql)),
      )
      const now = '2026-01-01'
      await DB.batch([
        DB.prepare(
          "INSERT INTO workspaces (id,name,created_at,plan,storage_quota_bytes,storage_updated_at) VALUES ('ws','Example',?,'plus',104857600,?)",
        ).bind(now, now),
        DB.prepare(
          "INSERT INTO users (id,email,email_verified,name,created_at,updated_at,workspace_id) VALUES ('owner','owner@example.test',1,'Owner',?,?,'ws')",
        ).bind(now, now),
        DB.prepare(
          "INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at) VALUES ('ws','owner','owner','active',?,?)",
        ).bind(now, now),
        DB.prepare(
          "INSERT INTO sessions (id,user_id,token,expires_at,created_at,updated_at) VALUES ('session','owner','fixture','2099-01-01',?,?)",
        ).bind(now, now),
      ])
      const cookie =
        '__Secure-better-auth.session_token=' +
        encodeURIComponent(
          'fixture.' +
            createHmac('sha256', secret).update('fixture').digest('base64'),
        )
      const window = new Window()
      try {
        for (const fault of ['healthy', 'settings', 'root']) {
          const response = await worker.fetch(
            'https://artifactshare.com/settings/general',
            {
              headers: {
                cookie,
                'Accept-Language': 'ja',
                'x-test-error': fault,
              },
            },
          )
          expect(response.status).toBe(fault === 'healthy' ? 200 : 500)
          const doc = new window.DOMParser().parseFromString(
            await response.text(),
            'text/html',
          )
          const surface = doc.querySelector('[data-screen-capture-error]')
          if (fault === 'healthy') {
            expect(surface).toBeNull()
            continue
          }
          expect(surface?.getAttribute('data-screen-capture-error')).toBe(
            fault === 'root'
              ? 'route-error-boundary'
              : 'settings-error-boundary',
          )
          expect(surface?.textContent).toContain(
            fault === 'root'
              ? 'ページを表示できません'
              : '設定を表示できません',
          )
          expect(surface?.innerHTML).not.toContain('private-message-' + fault)
          expect(surface?.innerHTML).not.toContain('private-stack-' + fault)
        }
      } finally {
        await window.happyDOM.close()
      }
    } finally {
      await harness.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 240_000)
