import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { defineBrowserCommand } from '@vitest/browser-playwright'
import type { Frame } from 'playwright'

// Execute the native postMessage call in a document script. DevTools evaluation
// is not an authored script entry point and can supply a different incumbent
// origin, which makes a valid opaque-frame observation fail the origin guard.
async function postFromDocument(
  frame: Frame,
  message: Record<string, unknown>,
) {
  const script = await frame.addScriptTag({
    content: `parent.postMessage(${JSON.stringify(message)}, '*')`,
  })
  await script.evaluate((element) => element.parentNode!.removeChild(element))
  await script.dispose()
}

type View = 'theme' | 'header' | 'oversized'
type HeaderMeasurements = {
  width: number
  header: number
  suffixWidth: number
  suffixRight: number
  buttonLeft: number
  watch: string
  accessible: string | null
}[]
type ThemeMeasurements = {
  buttons: {
    colorScheme: string
    surface: string
    selector: string
    state: string
    foreground: string
    background: string
    contrast: number
  }[]
  tokens: { colorScheme: string; surface: string; value: string }[]
  canvases: string[]
  transparent: string
  authored: string
}
type PreviewAnchor = Record<string, unknown>
type OversizedMeasurements = {
  status: number
  stored: PreviewAnchor
  next: PreviewAnchor
}

/** Exercise the packaged CLI and real loopback shell, with no account credentials. */
export const previewSecurity = defineBrowserCommand(
  async (ctx, view?: View) => {
    const { page } = ctx
    const cli = resolve(
      import.meta.dirname,
      '../../../../packages/cli/dist/index.js',
    )
    if (!existsSync(cli)) {
      execFileSync('pnpm', ['--filter', '@artifactshare/cli', 'build'], {
        cwd: resolve(import.meta.dirname, '../../../..'),
        stdio: 'inherit',
      })
    }
    assert.ok(
      existsSync(cli),
      'Build @artifactshare/cli before running preview browser tests',
    )
    const dir = mkdtempSync(join(tmpdir(), 'preview-security-'))
    const file = join(dir, 'sample.html')
    const fixtureHtml = (
      label: string,
    ) => `<!doctype html><h1>${label}</h1><p id="sample">Select this text</p><script>
    document.body.dataset.scriptRan = 'yes';
    window.addEventListener('message', event => {
      if (event.source === parent && event.data.kind === 'ready-check') window.previewHandshake = event.data;
    });
  </script>`
    writeFileSync(file, fixtureHtml('Initial document'))
    const startCli = () =>
      spawn(process.execPath, [cli, 'preview', file, '--no-open', '--json'], {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          ARTIFACTSHARE_CONFIG_HOME: join(dir, 'config'),
          ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
        } as unknown as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    let child = startCli()
    const waitReady = () =>
      new Promise<{ url: string; share_origin: string }>(
        (resolveReady, reject) => {
          let output = ''
          const timeout = setTimeout(
            () => reject(new Error('Preview startup timed out')),
            15000,
          )
          child.once('error', (error) => {
            clearTimeout(timeout)
            reject(error)
          })
          child.once('exit', () => {
            clearTimeout(timeout)
            reject(new Error('Preview exited before ready'))
          })
          child.stdout.on('data', (chunk) => {
            output += String(chunk)
            try {
              const result = JSON.parse(output)
              clearTimeout(timeout)
              if (!result.ok) reject(new Error('Preview startup failed'))
              else resolveReady(result.data)
            } catch {
              /* Wait for the complete single-line envelope. */
            }
          })
        },
      )
    const shell = await page.context().newPage()
    try {
      const ready = await waitReady()
      // Keep every browser request local; the test never resolves account credentials.
      await shell.route('**/*', (route) => {
        const url = new URL(route.request().url())
        return url.hostname === '127.0.0.1' ? route.continue() : route.abort()
      })
      await shell.addInitScript(() =>
        Object.defineProperty(navigator, 'language', { value: 'en' }),
      )
      await shell.goto(ready.url)
      if (view === 'header') {
        const measurements: HeaderMeasurements = []
        await shell.locator('.file-stem').evaluate((el) => {
          el.textContent =
            'a-very-long-synthetic-sample-file-name-that-overflows'
        })
        for (const width of [390, 860, 861]) {
          await shell.setViewportSize({ width, height: 800 })
          const geometry = await shell.evaluate(() => {
            const header = document
              .querySelector('.topbar')!
              .getBoundingClientRect()
            const suffix = document
              .querySelector('.file-extension')!
              .getBoundingClientRect()
            const button = document
              .querySelector('#shareBtn')!
              .getBoundingClientRect()
            return {
              header: header.height,
              suffixWidth: suffix.width,
              suffixRight: suffix.right,
              buttonLeft: button.left,
              watch: getComputedStyle(document.querySelector('.watch-label')!)
                .display,
              accessible: document
                .querySelector('#watchStatus')!
                .getAttribute('aria-label'),
            }
          })
          measurements.push({ width, ...geometry })
        }
        return measurements
      }
      if (view === 'theme') {
        const measurements: ThemeMeasurements = {
          buttons: [],
          tokens: [],
          canvases: [],
          transparent: '',
          authored: '',
        }
        const dialog = await shell.context().newPage()
        try {
          await dialog.route('**/api/context', (route) =>
            route.fulfill({
              json: { default_visibility: 'private', projects: [] },
            }),
          )
          await dialog.goto(ready.share_origin)
          for (const colorScheme of ['light', 'dark'] as const) {
            await shell.emulateMedia({ colorScheme })
            await dialog.emulateMedia({ colorScheme })
            for (const surface of [shell, dialog]) {
              const token = await surface.evaluate(() =>
                getComputedStyle(document.documentElement)
                  .getPropertyValue('--badge-on-link')
                  .trim(),
              )
              measurements.tokens.push({
                colorScheme,
                surface: surface === shell ? 'shell' : 'dialog',
                value: token,
              })
              for (const selector of surface === shell
                ? ['#shareBtn', '#submitBtn', '#popAdd']
                : ['#shareBtn']) {
                const button = surface.locator(selector)
                await surface.evaluate(() => {
                  const popover =
                    document.querySelector<HTMLElement>('#popover')
                  if (popover) {
                    popover.classList.add('show')
                    popover.style.top = '100px'
                    popover.style.left = '20px'
                  }
                  const bar = document.querySelector<HTMLElement>('#submitBar')
                  if (bar) bar.style.display = 'flex'
                })
                await button.evaluate((el) => {
                  ;(el as HTMLButtonElement).disabled = false
                })
                for (const state of ['default', 'hover', 'focus']) {
                  await surface.mouse.move(0, 0)
                  await button.evaluate((el) => (el as HTMLElement).blur())
                  if (state === 'hover') await button.hover()
                  if (state === 'focus') await button.focus()
                  const colors = await button.evaluate((el) => {
                    const style = getComputedStyle(el)
                    const luminance = (color: string) => {
                      const rgb = color
                        .match(/[\d.]+/g)!
                        .slice(0, 3)
                        .map(Number)
                        .map((n) => n / 255)
                        .map((n) =>
                          n <= 0.04045
                            ? n / 12.92
                            : ((n + 0.055) / 1.055) ** 2.4,
                        )
                      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
                    }
                    const a = luminance(style.color),
                      b = luminance(style.backgroundColor)
                    return {
                      foreground: style.color,
                      background: style.backgroundColor,
                      contrast:
                        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
                    }
                  })
                  measurements.buttons.push({
                    colorScheme,
                    surface: surface === shell ? 'shell' : 'dialog',
                    selector,
                    state,
                    ...colors,
                  })
                }
              }
            }
            measurements.canvases.push(
              await shell
                .locator('#artifactFrame')
                .evaluate((el) => getComputedStyle(el).backgroundColor),
            )
          }
          const artifact = await (await shell
            .locator('#artifactFrame')
            .elementHandle())!.contentFrame()
          assert.ok(artifact)
          measurements.transparent = await artifact.evaluate(
            () => getComputedStyle(document.body).backgroundColor,
          )
          await artifact.evaluate(() => {
            document.body.style.background = 'rgb(240, 230, 220)'
          })
          measurements.authored = await artifact.evaluate(
            () => getComputedStyle(document.body).backgroundColor,
          )
        } finally {
          await dialog.close()
        }
        return measurements
      }
      if (view === 'oversized') {
        const frame = await (await shell
          .locator('#artifactFrame')
          .elementHandle())!.contentFrame()
        assert.ok(frame)
        await frame.waitForFunction(() =>
          Boolean(
            (window as unknown as { previewHandshake: unknown })
              .previewHandshake,
          ),
        )
        await frame.locator('#sample').evaluate((element) => {
          element.textContent = '😀'.repeat(8000) + 'x'
        })
        await frame.locator('#sample').click()
        await shell.locator('#popover.show').waitFor()
        await shell.locator('#popText').fill('Review this oversized element')
        const saved = shell.waitForResponse(
          (response) =>
            response.url() === `${ready.url}api/annotations` &&
            response.request().method() === 'POST',
        )
        await shell.locator('#popAdd').click()
        const status = (await saved).status()
        const submitted = shell.waitForResponse(
          (response) => response.url() === `${ready.url}api/annotations/submit`,
        )
        await shell.locator('#submitBtn').click()
        await submitted
        const previews = join(dir, 'config', 'previews')
        const storedFile = readdirSync(previews).find((name) =>
          name.startsWith('annotations-'),
        )!
        const stored = JSON.parse(
          readFileSync(join(previews, storedFile), 'utf8'),
        ).annotations[0].anchor as PreviewAnchor
        // Restart the production CLI so preview next reads through a reopened store.
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
        child = startCli()
        await waitReady()
        const next = JSON.parse(
          execFileSync(
            process.execPath,
            [cli, 'preview', 'next', file, '--json'],
            {
              cwd: dir,
              env: {
                PATH: process.env.PATH,
                ARTIFACTSHARE_CONFIG_HOME: join(dir, 'config'),
                ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
              } as unknown as NodeJS.ProcessEnv,
              encoding: 'utf8',
            },
          ),
        ).data.items[0].anchor as PreviewAnchor
        return { status, stored, next }
      }
      assert.equal(
        await shell.locator('#artifactFrame').getAttribute('sandbox'),
        'allow-scripts',
      )
      await shell.getByText(/localStorage, IndexedDB/).waitFor()
      const frameElement = await shell.locator('#artifactFrame').elementHandle()
      const frame = await frameElement!.contentFrame()
      assert.ok(frame)
      await frame.waitForFunction(
        () => document.body.dataset.scriptRan === 'yes',
      )
      assert.equal(
        await frame.evaluate(() => {
          try {
            return parent.document.body !== null
          } catch {
            return false
          }
        }),
        false,
      )
      assert.equal(
        await frame.evaluate(() => {
          try {
            localStorage.setItem('probe', 'yes')
            return true
          } catch {
            return false
          }
        }),
        false,
      )
      // Opaque-origin requests cannot perform preview or share mutations.
      for (const url of [
        `${ready.url}api/annotations`,
        `${ready.url}api/agent/stop`,
        `${ready.share_origin}/api/snapshot`,
        `${ready.share_origin}/api/share`,
      ]) {
        assert.equal(
          await frame.evaluate(async (target) => {
            try {
              await fetch(target, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'x-artifactshare-preview': '1',
                },
                body: '{}',
              })
              return true
            } catch {
              return false
            }
          }, url),
          false,
        )
      }
      // A rejected browser response alone does not prove the POST had no effect.
      // Check server liveness before interacting with the reporter.
      assert.equal((await fetch(`${ready.url}__preview/session`)).status, 200)
      assert.equal(await shell.locator('#endedScreen.show').count(), 0)
      await frame.waitForFunction(() =>
        Boolean(
          (window as unknown as { previewHandshake: unknown }).previewHandshake,
        ),
      )
      const handshake = await frame.evaluate(
        () =>
          (window as unknown as { previewHandshake: Record<string, unknown> })
            .previewHandshake,
      )
      const observation = {
        source: 'artifactshare',
        kind: 'element-annotate',
        previewCapability: handshake.previewCapability,
        documentGeneration: handshake.documentGeneration,
        sequence: 10000,
        selector: '#sample',
        label: '<b>Literal text</b>',
        contextText: '',
        ownText: 'Select this text',
        tagName: 'P',
        rect: { top: 20, left: 10, width: 100, height: 20 },
      }
      // Verify the real reporter before the deliberately high test sequence
      // supersedes its observations for the rest of this document.
      await frame.locator('#sample').click()
      await shell.locator('#popover.show').waitFor()
      await shell.locator('#popCancel').click()
      const send = (message: Record<string, unknown>) =>
        postFromDocument(frame, message)
      // Use the same Window message queue to observe delivery before asserting
      // that an invalid message had no effect.
      await shell.evaluate(() => {
        window.addEventListener('message', (event) => {
          if (event.data?.kind === 'element-annotate') {
            const artifact =
              document.querySelector<HTMLIFrameElement>('#artifactFrame')!
            document.body.dataset.observationOrigin = event.origin
            document.body.dataset.observationSource = String(
              event.source === artifact.contentWindow,
            )
          }
          if (event.data?.testBarrier)
            document.body.dataset.testBarrier = event.data.testBarrier
        })
      })
      let barrierId = 0
      const barrier = async () => {
        const id = String(++barrierId)
        await postFromDocument(frame, { testBarrier: id })
        await shell.waitForFunction(
          (value) => document.body.dataset.testBarrier === value,
          id,
        )
      }
      for (const invalid of [
        { ...observation, previewCapability: '0'.repeat(64) },
        { ...observation, documentGeneration: 0 },
        { ...observation, extra: true },
        { ...observation, rect: { ...observation.rect, height: -1 } },
        { ...observation, label: 'x'.repeat(1025) },
      ])
        await send(invalid)
      await barrier()
      assert.equal(await shell.locator('#popover.show').count(), 0)
      await send(observation)
      await barrier()
      assert.equal(
        await shell.locator('body').getAttribute('data-observation-origin'),
        'null',
      )
      assert.equal(
        await shell.locator('body').getAttribute('data-observation-source'),
        'true',
      )
      await shell.locator('#popover.show').waitFor()
      assert.equal(
        await shell.locator('#popTarget').textContent(),
        observation.label,
      )
      assert.equal(await shell.locator('#popTarget b').count(), 0)
      assert.equal(
        (
          (await (await fetch(`${ready.url}api/annotations`)).json()) as {
            annotations: unknown[]
          }
        ).annotations.length,
        0,
      )
      await shell.locator('#popText').fill('Review this sample')
      const annotationResponse = shell.waitForResponse(
        (response) =>
          response.url() === `${ready.url}api/annotations` &&
          response.request().method() === 'POST',
      )
      await shell.locator('#popAdd').click()
      assert.equal((await annotationResponse).status(), 200)
      await shell.locator('.thread').waitFor()
      await send(observation) // duplicate sequence
      await barrier()
      assert.equal(await shell.locator('#popover.show').count(), 0)
      await postFromDocument(shell.mainFrame(), {
        ...observation,
        sequence: 10001,
      })
      await barrier()
      assert.equal(await shell.locator('#popover.show').count(), 0)
      await shell.evaluate(() => {
        const impostor = document.createElement('iframe')
        impostor.id = 'impostor'
        impostor.sandbox.add('allow-scripts')
        impostor.srcdoc = '<!doctype html><p>Other frame</p>'
        document.body.appendChild(impostor)
      })
      const impostorElement = await shell.locator('#impostor').elementHandle()
      const impostor = await impostorElement!.contentFrame()
      assert.ok(impostor)
      await postFromDocument(impostor, {
        ...observation,
        sequence: 10002,
      })
      await barrier()
      assert.equal(await shell.locator('#popover.show').count(), 0)
      await shell.locator('#impostor').evaluate((element) => element.remove())
      await shell.setViewportSize({ width: 390, height: 844 })
      assert.ok(await shell.getByText(/localStorage, IndexedDB/).isVisible())
      await shell.setViewportSize({ width: 1280, height: 900 })
      writeFileSync(file, fixtureHtml('Reloaded document'))
      await frame.getByRole('heading', { name: 'Reloaded document' }).waitFor()
      await frame.waitForFunction(() =>
        Boolean(
          (window as unknown as { previewHandshake: unknown }).previewHandshake,
        ),
      )
      const nextHandshake = await frame.evaluate(
        () =>
          (window as unknown as { previewHandshake: Record<string, unknown> })
            .previewHandshake,
      )
      assert.notEqual(
        nextHandshake.previewCapability,
        handshake.previewCapability,
      )
      await send({ ...observation, sequence: 10002 })
      await barrier()
      assert.equal(await shell.locator('#popover.show').count(), 0)
      assert.equal(
        (
          (await (await fetch(`${ready.url}api/annotations`)).json()) as {
            annotations: unknown[]
          }
        ).annotations.length,
        1,
      )
      await shell.reload()
      await shell.locator('.thread').waitFor()
      await shell.getByText(/localStorage, IndexedDB/).waitFor()
      return true
    } finally {
      await shell.close()
      if (child.exitCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

declare module 'vitest/browser' {
  interface BrowserCommands {
    previewSecurity: {
      (): Promise<boolean>
      (scenario: 'theme'): Promise<ThemeMeasurements>
      (scenario: 'header'): Promise<HeaderMeasurements>
      (scenario: 'oversized'): Promise<OversizedMeasurements>
    }
  }
}
