import assert from 'node:assert/strict'
import type { Cookie } from 'playwright'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { promisify } from 'node:util'
import { acquireUsercontentBuild } from './usercontent-build'
import { assertShellAssets } from './usercontent-shell-assets.js'
import { defineBrowserCommand } from '@vitest/browser-playwright'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import {
  SANDBOX_PROBE_MARKER,
  SANDBOX_PROBE_PATH,
} from '../lib/sandbox-block-report'

const run = promisify(execFile)
const webRoot = new URL('../..', import.meta.url).pathname
const secret = 'usercontent-browser-fixture-only-'.repeat(3)

// A loopback-only reverse proxy maps these reserved test sites one-to-one to
// production origins. Worker URL/Origin inputs and response CSP/CORS/URL text
// are mapped together; signed tokens and cookies are never rewritten. All
// authorization, nonce, manifest, storage, session and upload handlers are real.
const mappings = [
  ['artifactshareusercontent.com', 'usercontent.example'],
  ['artifactshare.link', 'link.example'],
  ['artifactshare.com', 'app.example'],
] as const
function mapText(text: string, toBrowser: boolean): string {
  for (const [worker, browser] of mappings)
    text = text.replaceAll(
      toBrowser ? worker : browser,
      toBrowser ? browser : worker,
    )
  return text
}
function allowedHost(host: string): boolean {
  return (
    host === 'app.example' ||
    host.endsWith('.app.example') ||
    host.endsWith('.link.example') ||
    host.endsWith('.usercontent.example')
  )
}
function localBindings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(localBindings)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'remote' ? false : localBindings(child),
    ]),
  )
}
function sessionCookie(token: string): string {
  const signature = createHmac('sha256', secret).update(token).digest('base64')
  return encodeURIComponent(`${token}.${signature}`)
}

const delivery = defineBrowserCommand(async ({ page }, blockAll = false) => {
  const directory = await mkdtemp(join(tmpdir(), 'usercontent-browser-'))
  let build: Awaited<ReturnType<typeof acquireUsercontentBuild>> | undefined
  try {
    build = await acquireUsercontentBuild()
    const { createTestHarness, unstable_splitSqlQuery } =
      await import('wrangler')
    const sourceConfig = JSON.parse(
      await readFile(
        join(build.directory, 'build/server/wrangler.json'),
        'utf8',
      ),
    )
    delete sourceConfig.ai
    delete sourceConfig.flagship
    delete sourceConfig.configPath
    delete sourceConfig.userConfigPath
    // This config belongs to one harness; its immutable build can be shared.
    sourceConfig.main = join(build.directory, 'build/server/index.js')
    sourceConfig.base_dir = join(build.directory, 'build/server')
    sourceConfig.assets.directory = join(build.directory, 'build/client')
    const configFile = join(directory, 'wrangler.usercontent-browser.json')
    await writeFile(configFile, JSON.stringify(localBindings(sourceConfig)))
    const harness = createTestHarness({
      root: webRoot,
      workers: [
        {
          configPath: configFile,
          vars: {
            APP_ENV: 'production',
            ARTIFACT_DELIVERY_STAGE: 'usercontent',
            BETTER_AUTH_URL: 'https://artifactshare.com',
            DEFAULT_LOCALE: 'en',
            GA4_MEASUREMENT_ID: '',
          },
          secrets: { BETTER_AUTH_SECRET: secret },
        },
        {
          configPath: 'wrangler.sandbox.jsonc',
          vars: { APP_ENV: 'production' },
          secrets: { BETTER_AUTH_SECRET: secret },
        },
        { configPath: 'wrangler.og-image.jsonc' },
        { configPath: 'wrangler.alerts.jsonc' },
      ],
    })
    const app = harness.getWorker(sourceConfig.name)
    const sandbox = harness.getWorker('artifactshare-sandbox-public-preview')
    const network = setupServer(
      http.get(
        'https://tail.developers.workers.dev/:id',
        () => new HttpResponse(null, { status: 204 }),
      ),
    )
    network.listen({
      onUnhandledRequest(request) {
        if (
          ['127.0.0.1', 'localhost', '[::1]'].includes(
            new URL(request.url).hostname,
          )
        )
          return
        throw new Error(
          `Unexpected Worker network request: ${new URL(request.url).origin}`,
        )
      },
    })
    const restrictedBrowser = blockAll
      ? await (
          await import('playwright')
        ).firefox.launch({
          firefoxUserPrefs: {
            'network.cookie.cookieBehavior': 1,
            'network.cookie.cookieBehavior.pbmode': 1,
          },
        })
      : undefined
    const browser = restrictedBrowser ?? page.context().browser()!
    const sockets = new Set<Duplex>()
    let context: Awaited<ReturnType<typeof browser.newContext>> | undefined
    let httpsServer: ReturnType<typeof createHttpsServer> | undefined
    let proxy: ReturnType<typeof createHttpServer> | undefined
    let stage = 'starting local Workers'
    const responses: string[] = []
    const legacyCookieHosts = new Set<string>()
    try {
      await harness.listen()
      const env = await app.getEnv()
      const schema = await readFile(join(webRoot, 'db/schema.sql'), 'utf8')
      await env.DB.batch(
        unstable_splitSqlQuery(
          schema.replace(/^PRAGMA foreign_keys = ON;$/m, ''),
        ).map((sql) => env.DB.prepare(sql)),
      )
      const now = '2026-01-01T00:00:00.000Z'
      for (const name of ['author', 'victim']) {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO workspaces (id, hd, name, created_at, plan, storage_quota_bytes, self_upload_enabled, link_sharing_enabled, storage_used_bytes, storage_updated_at) VALUES (?, NULL, ?, ?, 'plus', 104857600, 1, 1, 0, ?)",
          ).bind(`ws-${name}`, name, now, now),
          env.DB.prepare(
            'INSERT INTO users (id, email, email_verified, name, created_at, updated_at, workspace_id) VALUES (?, ?, 1, ?, ?, ?, ?)',
          ).bind(name, `${name}@example.test`, name, now, now, `ws-${name}`),
          env.DB.prepare(
            "INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'owner', 'active', ?, ?)",
          ).bind(`ws-${name}`, name, now, now),
          env.DB.prepare(
            "INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)",
          ).bind(`session-${name}`, name, `session-${name}`, now, now),
        ])
      }
      await run(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          join(directory, 'key.pem'),
          '-out',
          join(directory, 'cert.pem'),
          '-subj',
          '/CN=app.example',
          '-days',
          '1',
        ],
        { timeout: 30_000 },
      )
      const errors: Error[] = []
      httpsServer = createHttpsServer(
        {
          key: await readFile(join(directory, 'key.pem')),
          cert: await readFile(join(directory, 'cert.pem')),
        },
        async (request, response) => {
          try {
            const incoming = new URL(
              request.url ?? '/',
              `https://${request.headers.host}`,
            )
            assert.ok(allowedHost(incoming.hostname))
            if (incoming.hostname === 'control.usercontent.example') {
              if (incoming.pathname === '/echo') {
                response.end(
                  request.headers.cookie?.includes('ordinary_control=present')
                    ? 'present'
                    : 'blocked',
                )
              } else {
                response.setHeader('Content-Type', 'text/html')
                response.setHeader(
                  'Set-Cookie',
                  'ordinary_control=present; Secure; Path=/; SameSite=None',
                )
                response.end(
                  '<body>waiting<script>fetch("/echo").then(r=>r.text()).then(t=>document.body.textContent=t)</script>',
                )
              }
              return
            }
            if (
              incoming.pathname === '/__cookie_control' ||
              incoming.pathname === '/__cookie_control_echo'
            ) {
              response.setHeader('Content-Type', 'text/html')
              response.end(
                `<iframe src="https://control.usercontent.example/${incoming.pathname.endsWith('_echo') ? 'echo' : ''}"></iframe>`,
              )
              return
            }
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(Buffer.from(chunk))
            const headers = new Headers()
            for (const [name, value] of Object.entries(request.headers)) {
              if (
                value !== undefined &&
                ![
                  'host',
                  'connection',
                  'content-length',
                  'accept-encoding',
                ].includes(name)
              )
                headers.set(
                  name,
                  mapText(
                    Array.isArray(value) ? value.join(', ') : value,
                    false,
                  ),
                )
            }
            const target = mapText(incoming.href, false)
            if (
              request.headers.cookie
                ?.split(';')
                .some((cookie) => cookie.trim() === 'as_bnd=sibling')
            )
              legacyCookieHosts.add(incoming.hostname)
            // Named Worker fetch bypasses asset routing. App traffic must use
            // the public harness entrypoint so hashed client files are served.
            const worker =
              incoming.hostname.endsWith('.usercontent.example') ||
              incoming.hostname.endsWith('.sandbox.app.example')
                ? sandbox
                : harness
            const result = await worker.fetch(target, {
              method: request.method,
              headers: Object.fromEntries(headers),
              ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
              redirect: 'manual',
            })
            // Never log signed query strings or cookies. Keep enough context to
            // distinguish a Worker refusal from a browser policy or handshake.
            responses.push(
              `${incoming.hostname}${incoming.pathname}: ${result.status}`,
            )
            if (responses.length > 20) responses.shift()
            response.statusCode = result.status
            for (const [name, value] of result.headers) {
              if (
                ![
                  'set-cookie',
                  'content-length',
                  'content-encoding',
                  'transfer-encoding',
                ].includes(name)
              )
                response.setHeader(name, mapText(value, true))
            }
            const cookies = result.headers.getSetCookie()
            if (cookies.length)
              response.setHeader(
                'Set-Cookie',
                cookies.map((cookie) => mapText(cookie, true)),
              )
            const type = result.headers.get('Content-Type') ?? ''
            response.end(
              /text|javascript|json/.test(type)
                ? mapText(await result.text(), true)
                : Buffer.from(await result.arrayBuffer()),
            )
          } catch (error) {
            errors.push(
              error instanceof Error ? error : new Error(String(error)),
            )
            response.statusCode = 500
            response.end('Local fixture failure')
          }
        },
      )
      httpsServer.listen(0, '127.0.0.1')
      await once(httpsServer, 'listening')
      const httpsAddress = httpsServer.address()
      assert.ok(httpsAddress && typeof httpsAddress !== 'string')
      proxy = createHttpServer((_request, response) => {
        response.writeHead(403)
        response.end()
      })
      proxy.on('connect', (request, socket, head) => {
        const hostname = new URL(`https://${request.url}`).hostname
        if (!allowedHost(hostname)) {
          socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
          return
        }
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        const upstream = connect(httpsAddress.port, '127.0.0.1', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) upstream.write(head)
          socket.pipe(upstream).pipe(socket)
        })
        sockets.add(upstream)
        upstream.on('close', () => sockets.delete(upstream))
        upstream.on('error', () => socket.destroy())
        socket.on('error', () => upstream.destroy())
      })
      proxy.listen(0, '127.0.0.1')
      await once(proxy, 'listening')
      const proxyAddress = proxy.address()
      assert.ok(proxyAddress && typeof proxyAddress !== 'string')
      const engine = browser.browserType().name()
      // A first-party visit can establish storage-access heuristics. Prove the
      // control cookie works in its own context, then use a fresh context for
      // third-party blocking and every product flow.
      stage = `${engine}: first-party cookie positive control`
      const firstParty = await browser.newContext({
        ignoreHTTPSErrors: true,
        proxy: { server: `http://127.0.0.1:${proxyAddress.port}` },
      })
      try {
        await firstParty.route('**/*', (route) =>
          allowedHost(new URL(route.request().url()).hostname)
            ? route.continue()
            : route.abort(),
        )
        const controlPage = await firstParty.newPage()
        await controlPage.goto('https://control.usercontent.example/')
        await controlPage.waitForFunction(() =>
          ['present', 'blocked'].includes(document.body.textContent ?? ''),
        )
        assert.equal(await controlPage.locator('body').innerText(), 'present')
      } finally {
        await firstParty.close()
      }
      context = await browser.newContext({
        ignoreHTTPSErrors: true,
        proxy: { server: `http://127.0.0.1:${proxyAddress.port}` },
      })
      await context.route('**/*', (route) =>
        allowedHost(new URL(route.request().url()).hostname)
          ? route.continue()
          : route.abort(),
      )
      const viewer = await context.newPage()
      console.info('usercontent browser under test', {
        engine,
        version: browser.version(),
        thirdPartyBlocking:
          engine === 'firefox'
            ? `network.cookie.cookieBehavior=${blockAll ? 1 : 5}`
            : engine === 'chromium'
              ? 'Network.setCookieControls'
              : 'WebKit default with negative control',
      })
      if (engine === 'chromium') {
        const cdp = await context.newCDPSession(viewer)
        await cdp.send('Network.enable')
        await cdp.send('Network.setCookieControls', {
          enableThirdPartyCookieRestriction: true,
        })
      }
      // Controls distinguish blocked cookies from Firefox TCP partitioning.
      stage = `${engine}: ordinary third-party cookie negative control`
      await viewer.goto('https://app.example/__cookie_control')
      const control = viewer.frameLocator('iframe').locator('body')
      await control.waitFor()
      const controlFrame = viewer
        .frames()
        .find((frame) =>
          frame.url().startsWith('https://control.usercontent.example/'),
        )!
      await controlFrame.waitForFunction(() =>
        ['present', 'blocked'].includes(document.body.textContent ?? ''),
      )
      assert.equal(
        await controlFrame.locator('body').innerText(),
        engine === 'firefox' && !blockAll ? 'present' : 'blocked',
      )
      if (engine === 'firefox' && !blockAll) {
        const partitionControl = await context.newPage()
        await partitionControl.goto('https://control.usercontent.example/echo')
        assert.equal(
          await partitionControl.locator('body').innerText(),
          'blocked',
        )
        await partitionControl.goto(
          'https://other.link.example/__cookie_control_echo',
        )
        await partitionControl.frameLocator('iframe').locator('body').waitFor()
        assert.equal(
          await partitionControl
            .frameLocator('iframe')
            .locator('body')
            .innerText(),
          'blocked',
        )
        await partitionControl.close()
      }
      await context.addCookies([
        {
          name: '__Secure-better-auth.session_token',
          value: sessionCookie('session-victim'),
          domain: 'app.example',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
        },
        {
          name: 'isolation_probe',
          value: 'unchanged',
          domain: 'app.example',
          path: '/',
          secure: true,
          sameSite: 'Lax',
        },
      ])
      const results: string[] = []
      let assetPreflights = 0
      for (const kind of ['authenticated', 'link'] as const) {
        for (const format of ['html', 'md', 'static_site'] as const) {
          stage = `${engine}: ${kind}:${format} upload`
          const form = new FormData()
          const boundaryProbe = `<script>document.cookie='__Secure-better-auth.session_token=${sessionCookie('session-author')}; Domain=app.example; Secure; Path=/; SameSite=None';document.cookie='isolation_probe=changed; Domain=app.example; Secure; Path=/';document.cookie='__Host-as_bnd=invalid; Domain=usercontent.example; Secure; Path=/; SameSite=None; Partitioned';document.cookie='as_bnd=sibling; Domain=usercontent.example; Secure; Path=/; SameSite=None; Partitioned';document.body.dataset.cookieAttack='attempted';</script>`
          const html = `<h1 id="section">Local delivery</h1>${boundaryProbe}<a download="fixture.txt" href="data:text/plain,Local%20download">Download fixture</a>`
          if (format === 'static_site') {
            form.append(
              'file',
              new File(
                [
                  `${html}<link rel="stylesheet" href="style.css"><script src="script.js"></script><a href="next.html">Next</a>`,
                ],
                'index.html',
                { type: 'text/html' },
              ),
            )
            form.append(
              'file',
              new File(['body{--delivery-asset:loaded}'], 'style.css', {
                type: 'text/css',
              }),
            )
            form.append(
              'file',
              new File(['document.body.dataset.asset="loaded"'], 'script.js', {
                type: 'text/javascript',
              }),
            )
            form.append(
              'file',
              new File(
                ['<h1>Next page</h1><a href="/">Back</a>'],
                'next.html',
                {
                  type: 'text/html',
                },
              ),
            )
          } else {
            form.append(
              'file',
              new File(
                [format === 'md' ? '# Local delivery\n\n## Section' : html],
                format === 'md' ? 'index.md' : 'index.html',
                { type: format === 'md' ? 'text/markdown' : 'text/html' },
              ),
            )
          }
          form.append('visibility', kind === 'link' ? 'link' : 'private')
          const uploadBody = new Response(form)
          const upload = await app.fetch(
            `https://artifactshare.com/api/shareables/uploads${format === 'static_site' ? `?artifact_kind=static_site&visibility=${kind === 'link' ? 'link' : 'private'}` : ''}`,
            {
              method: 'POST',
              headers: {
                Cookie: `__Secure-better-auth.session_token=${sessionCookie('session-author')}`,
                'Content-Type': uploadBody.headers.get('Content-Type')!,
              },
              body: new Uint8Array(await uploadBody.arrayBuffer()),
            },
          )
          assert.equal(upload.status, 200, await upload.clone().text())
          const artifact = (await upload.json()) as {
            id: string
            versionId: string
          }
          if (kind === 'authenticated')
            await env.DB.prepare(
              'INSERT INTO shareable_grants (shareable_id, granted_email, granted_by, granted_at) VALUES (?, ?, ?, ?)',
            )
              .bind(artifact.id, 'victim@example.test', 'author', now)
              .run()
          const publicUrl =
            kind === 'link'
              ? `https://${artifact.id}.link.example/`
              : `https://app.example/a/${artifact.id}`
          stage = `${engine}: ${kind}:${format} shell asset preflight`
          await assertShellAssets(mapText(publicUrl, false), (url) =>
            harness.fetch(url, {
              headers: {
                Cookie: `__Secure-better-auth.session_token=${sessionCookie('session-victim')}`,
              },
            }),
          )
          assetPreflights++
          stage = `${engine}: ${kind}:${format} first load`
          await viewer.goto(`${publicUrl}#section`)
          const frameElement = viewer.locator('iframe[data-src]').first()
          await frameElement.waitFor()
          const frame =
            await (await frameElement.elementHandle())!.contentFrame()
          assert.ok(frame)
          if (
            blockAll &&
            kind === 'authenticated' &&
            format === 'static_site'
          ) {
            await frame
              .getByRole('heading', {
                name: 'Private static-site preview unavailable',
                exact: true,
              })
              .waitFor()
            assert.equal(await frame.locator('h1#section').count(), 0)
            assert.equal(
              await frame.evaluate(() => document.body.dataset.asset),
              undefined,
            )
            results.push('authenticated:static_site:cookie-setting-message')
            continue
          }
          await frame
            .getByRole('heading', { name: 'Local delivery', exact: true })
            .waitFor()
          if (format !== 'md') {
            await frame.waitForFunction(
              () => document.body.dataset.cookieAttack === 'attempted',
            )
            assert.deepEqual(
              (await context.cookies('https://app.example'))
                .filter(
                  (cookie) =>
                    cookie.name === '__Secure-better-auth.session_token',
                )
                .map((cookie) => cookie.value),
              [sessionCookie('session-victim')],
            )
          }
          // SSR can display the artifact before the parent has hydrated and
          // accepted the reporter handshake. Exercise hash sync only once the
          // viewer has confirmed that it can receive frame messages.
          stage = `${engine}: ${kind}:${format} viewer handshake`
          await viewer.locator('[data-sandbox-state="ready"]').waitFor()
          assert.match(
            new URL(frame.url()).hostname,
            new RegExp(
              `^${kind === 'link' ? 'l' : 'a'}-${artifact.id}--v-${/[a-f0-9]+/.source}\\.usercontent\\.example$`,
            ),
          )
          stage = `${engine}: ${kind}:${format} initial hash`
          await frame.waitForURL((url) => url.hash === '#section')
          await frame.evaluate(() => {
            location.hash = '#changed'
          })
          stage = `${engine}: ${kind}:${format} hash report`
          await viewer.waitForURL((url) => url.hash === '#changed')
          const executionOrigin = new URL(frame.url()).origin
          const probe = await viewer.evaluate(
            async ({ origin, path }) => {
              const response = await fetch(origin + path, {
                credentials: 'omit',
              })
              return {
                status: response.status,
                marker: response.headers.get('X-ArtifactShare-Sandbox-Probe'),
                body: await response.text(),
              }
            },
            { origin: executionOrigin, path: SANDBOX_PROBE_PATH },
          )
          assert.deepEqual(probe, {
            status: 200,
            marker: SANDBOX_PROBE_MARKER,
            body: SANDBOX_PROBE_MARKER,
          })
          if (format === 'static_site') {
            stage = `${engine}: ${kind}:${format} relative assets`
            await frame.waitForFunction(
              () =>
                document.body.dataset.asset === 'loaded' &&
                getComputedStyle(document.body)
                  .getPropertyValue('--delivery-asset')
                  .trim() === 'loaded',
            )
            const cookies: Cookie[] = (await context.cookies()).filter(
              (cookie) => cookie.name === '__Host-as_bnd',
            )
            assert.equal(
              cookies.some(
                (cookie) => cookie.domain === new URL(executionOrigin).hostname,
              ),
              !blockAll,
            )
            assert.ok(cookies.every((cookie) => !cookie.domain.startsWith('.')))
            assert.ok(cookies.every((cookie) => cookie.value !== 'invalid'))
            // The earlier HTML sibling attempted a parent-domain legacy cookie
            // in this same app partition. If accepted by the browser, prove it
            // reached this host without blocking entrypoint or relative assets.
            if (
              kind === 'authenticated' &&
              (await context.cookies()).some(
                (cookie) =>
                  cookie.name === 'as_bnd' &&
                  cookie.domain === '.usercontent.example',
              )
            ) {
              assert.ok(
                legacyCookieHosts.has(new URL(executionOrigin).hostname),
              )
            }
            await frame.getByRole('link', { name: 'Next', exact: true }).click()
            await viewer
              .frameLocator('iframe[data-src]')
              .first()
              .getByRole('heading', { name: 'Next page' })
              .waitFor()
          }
          stage = `${engine}: ${kind}:${format} public reload`
          await viewer.reload()
          await viewer
            .frameLocator('iframe[data-src]')
            .first()
            .getByRole('heading', { name: 'Local delivery', exact: true })
            .waitFor()
          stage = `${engine}: ${kind}:${format} download and authority control`
          if (kind === 'authenticated') {
            if (format === 'static_site') {
              // A private asset must fail without its bound cookie. This is the
              // positive control against accidentally exercising public fallback.
              const appCookies = await context.cookies('https://app.example')
              await context.clearCookies()
              await context.addCookies(appCookies)
              const current = await (await viewer
                .locator('iframe[data-src]')
                .first()
                .elementHandle())!.contentFrame()
              assert.ok(current)
              assert.equal(
                await current.evaluate(
                  async () => (await fetch('/style.css')).status,
                ),
                401,
              )
              await viewer.reload()
              await viewer
                .frameLocator('iframe[data-src]')
                .first()
                .getByRole('heading', { name: 'Local delivery', exact: true })
                .waitFor()
            }
            await viewer.locator('[data-viewer-more-menu-trigger]').click()
            const downloadReady = viewer.waitForEvent('download')
            await viewer
              .getByRole('menuitem', {
                name: format === 'md' ? 'Download Markdown' : 'Download HTML',
                exact: true,
              })
              .click()
            const download = await downloadReady
            const path = await download.path()
            assert.ok(path)
            assert.ok((await readFile(path)).byteLength > 0)
          } else if (format !== 'md') {
            const downloadReady = viewer.waitForEvent('download')
            await viewer
              .frameLocator('iframe[data-src]')
              .first()
              .getByRole('link', { name: 'Download fixture', exact: true })
              .click()
            const download = await downloadReady
            const path = await download.path()
            assert.ok(path)
            assert.equal(await readFile(path, 'utf8'), 'Local download')
          } else {
            // Anonymous Markdown has no export action in the existing product.
            assert.equal(
              await viewer.locator('[data-viewer-more-menu-trigger]').count(),
              0,
            )
          }
          stage = `${engine}: ${kind}:${format} revocation`
          // Obtain unused authority, then revoke before it reaches the Worker.
          const renewed = (await viewer.evaluate(
            async (id) =>
              (await fetch(`/api/shareables/${id}/sandbox-token`)).json(),
            artifact.id,
          )) as { sandboxUrl: string }
          assert.ok(renewed.sandboxUrl)
          await env.DB.batch([
            env.DB.prepare(
              "UPDATE shareables SET visibility='private' WHERE id=?",
            ).bind(artifact.id),
            env.DB.prepare(
              'DELETE FROM shareable_grants WHERE shareable_id=?',
            ).bind(artifact.id),
          ])
          const renewedFrame = await (await viewer
            .locator('iframe[data-src]')
            .first()
            .elementHandle())!.contentFrame()
          assert.ok(renewedFrame)
          const revoked = await renewedFrame.goto(renewed.sandboxUrl)
          assert.equal(revoked?.status(), 401)
          assert.equal(
            (await context.cookies('https://app.example')).find(
              (cookie) => cookie.name === 'isolation_probe',
            )?.value,
            'unchanged',
          )
          results.push(`${kind}:${format}`)
        }
      }
      // The actual app session and upload service must still select the victim.
      stage = `${engine}: victim identity and upload ownership`
      await viewer.goto('https://app.example/')
      await viewer
        .getByRole('button', { name: /victim@example\.test/ })
        .first()
        .waitFor()
      const identity = (await viewer.evaluate(async () =>
        (await fetch('/api/cli/whoami')).json(),
      )) as { user: { id: string }; workspace: { id: string } }
      assert.equal(identity.user.id, 'victim')
      assert.equal(identity.workspace.id, 'ws-victim')
      const uploaded = await viewer.evaluate(async () => {
        const form = new FormData()
        form.append(
          'file',
          new File(['<h1>Victim upload</h1>'], 'victim.html', {
            type: 'text/html',
          }),
        )
        form.append('visibility', 'private')
        const response = await fetch('/api/shareables/uploads', {
          method: 'POST',
          body: form,
        })
        return {
          status: response.status,
          body: (await response.json()) as { id: string },
        }
      })
      assert.equal(uploaded.status, 200)
      const stored = await env.DB.prepare(
        'SELECT owner_user_id, workspace_id FROM shareables WHERE id=?',
      )
        .bind(uploaded.body.id)
        .first()
      assert.deepEqual(stored, {
        owner_user_id: 'victim',
        workspace_id: 'ws-victim',
      })
      assert.equal(
        errors.length,
        0,
        errors.map((error) => error.message).join('\n'),
      )
      return {
        engine,
        version: browser.version(),
        settings:
          engine === 'chromium'
            ? 'Network.setCookieControls enableThirdPartyCookieRestriction=true'
            : engine === 'firefox'
              ? `network.cookie.cookieBehavior=${blockAll ? 1 : 5}`
              : 'WebKit third-party cookie blocking; enforced by ordinary-cookie control',
        ordinaryThirdPartyCookie:
          engine === 'firefox' && !blockAll ? 'partitioned' : 'blocked',
        assetPreflights,
        results,
        identity: identity.user.id,
        uploadOwner: stored?.owner_user_id,
      }
    } catch (error) {
      const frames = await Promise.all(
        (context?.pages() ?? []).flatMap((current) =>
          current.frames().map(async (frame) => ({
            url: frame.url().split('?')[0],
            text: await frame
              .locator('body')
              .innerText({ timeout: 1_000 })
              .then((text) => text.slice(0, 2_000))
              .catch(() => '(unavailable)'),
          })),
        ),
      )
      throw new Error(
        `Usercontent delivery failed at ${stage}\n${
          error instanceof Error
            ? error.message.replace(
                /([?&](?:t|__as_token)=)[^&\s"')]+/g,
                '$1[redacted]',
              )
            : 'Unknown harness error'
        }\n${JSON.stringify({ responses, frames })}`,
        { cause: error },
      )
    } finally {
      const closed = await Promise.allSettled([context?.close()])
      closed.push(...(await Promise.allSettled([restrictedBrowser?.close()])))
      for (const socket of sockets) socket.destroy()
      closed.push(
        ...(await Promise.allSettled(
          [httpsServer, proxy].map(async (server) => {
            if (!server?.listening) return
            server.closeAllConnections()
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            )
          }),
        )),
      )
      closed.push(...(await Promise.allSettled([harness.close()])))
      network.close()
      await rm(configFile, { force: true })
      await Promise.all(
        closed.map((result) =>
          result.status === 'rejected'
            ? Promise.reject(result.reason)
            : Promise.resolve(),
        ),
      )
    }
  } finally {
    try {
      await build?.release()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

export { delivery as usercontentDelivery }

declare module 'vitest/browser' {
  interface BrowserCommands {
    usercontentDelivery: (blockAll?: boolean) => Promise<{
      engine: string
      version: string
      settings: string
      ordinaryThirdPartyCookie: string
      assetPreflights: number
      results: string[]
      identity: string
      uploadOwner: unknown
    }>
  }
}
