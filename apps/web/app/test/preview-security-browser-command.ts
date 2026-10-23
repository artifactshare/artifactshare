import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/** Exercise the packaged CLI and real loopback shell, with no account credentials. */
export const previewSecurity = defineBrowserCommand(async ({ page }) => {
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
  const child = spawn(
    process.execPath,
    [cli, 'preview', file, '--no-open', '--json'],
    {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        ARTIFACTSHARE_CONFIG_HOME: join(dir, 'config'),
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const shell = await page.context().newPage()
  try {
    const ready = await new Promise<{ url: string; share_origin: string }>(
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
    // Keep every browser request local; the test never resolves account credentials.
    await shell.route('**/*', (route) => {
      const url = new URL(route.request().url())
      return url.hostname === '127.0.0.1' ? route.continue() : route.abort()
    })
    await shell.goto(ready.url)
    assert.equal(
      await shell.locator('#artifactFrame').getAttribute('sandbox'),
      'allow-scripts',
    )
    await shell.getByText(/localStorage, IndexedDB/).waitFor()
    const frameElement = await shell.locator('#artifactFrame').elementHandle()
    const frame = await frameElement!.contentFrame()
    assert.ok(frame)
    await frame.waitForFunction(() => document.body.dataset.scriptRan === 'yes')
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
})

declare module 'vitest/browser' {
  interface BrowserCommands {
    previewSecurity: () => Promise<boolean>
  }
}
