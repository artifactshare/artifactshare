import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { defineBrowserCommand } from '@vitest/browser-playwright'
import type { Frame, JSHandle, Locator, Page } from 'playwright'
import { openPopup } from './browser-waits'

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

// Composite every ancestor background before measuring translucent text.
function textContrast(
  locator: Locator,
  placeholder = false,
  canvas = [255, 255, 255],
) {
  return locator.evaluate(
    (element, options) => {
      const rgba = (value: string) => {
        const channels = value.match(/[\d.]+/g)!.map(Number)
        return [channels[0], channels[1], channels[2], channels[3] ?? 1]
      }
      const blend = (front: number[], back: number[]) =>
        front
          .slice(0, 3)
          .map((channel, i) => channel * front[3] + back[i] * (1 - front[3]))
      const ancestors: Element[] = []
      for (
        let current: Element | null = element;
        current;
        current = current.parentElement
      )
        ancestors.unshift(current)
      let background = options.canvas
      for (const ancestor of ancestors)
        background = blend(
          rgba(getComputedStyle(ancestor).backgroundColor),
          background,
        )
      const foreground = blend(
        rgba(
          getComputedStyle(
            element,
            options.placeholder ? '::placeholder' : null,
          ).color,
        ),
        background,
      )
      const luminance = (rgb: number[]) =>
        rgb
          .map((value) => value / 255)
          .map((value) =>
            value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
          )
          .reduce(
            (sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i],
            0,
          )
      const a = luminance(foreground),
        b = luminance(background)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    },
    { placeholder, canvas },
  )
}

type View =
  | 'theme'
  | 'header'
  | 'oversized'
  | 'popover'
  | 'markdown-frame'
  | 'share'
  | 'screens'
type PopoverMeasurements = {
  width: number
  height: number
  selector: string
  hit: boolean
}[]
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
  textContrast: number[]
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
  frameSchemes: string[]
  canvases: string[]
  transparent: string
  darkMedia: boolean
  recoveryContrast: number
  authored: string
}
type ShareMeasurements = {
  locale: string
  colorScheme: string
  width: number
  states: string[]
  contrast: number[]
}[]
type PreviewAnchor = Record<string, unknown>
type OversizedMeasurements = {
  ambiguous: { stored: PreviewAnchor; next: PreviewAnchor }[]
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
    const file = join(
      dir,
      view === 'markdown-frame' ? 'sample.md' : 'sample.html',
    )
    const fixtureHtml = (
      label: string,
    ) => `<!doctype html><h1>${label}</h1><p id="sample">Select this text</p><input aria-label="Authored input"><script>
    document.body.dataset.scriptRan = 'yes';
    window.addEventListener('message', event => {
      if (event.source === parent && event.data.kind === 'ready-check') window.previewHandshake = event.data;
    });
  </script>`
    // Interactive fixture: hash slides, a History API route, an in-page
    // fragment, and a screen the document refuses to show again.
    const screensHtml = (
      label: string,
    ) => `<!doctype html><title>${label}</title>
<nav><button id="next">Next</button> <button id="lock">Lock</button> <button id="route">Route</button> <a id="toIntro" href="#intro">Intro</a> <a id="away" href="elsewhere.html">Away</a> <a id="routerLink" href="settings">Settings link</a> <a id="badHash" href="#/q%zz">Odd route</a></nav>
<div><input type="checkbox" id="chk" aria-label="Check"><button id="proxy">Proxy</button><button id="counted">Counted</button><x-host id="host"></x-host></div>
<main id="stage"></main><p>This constant paragraph keeps the quoted context identical on every slide of the deck.</p><p id="intro">Intro text</p><p>This closing paragraph is also identical on every slide of the deck.</p>
<script>
  let lockedLeft = false;
  const home = location.pathname;
  const render = () => {
    if (location.hash === '#/locked' && lockedLeft) history.replaceState(null, '', home + location.search + '#/1');
    if (location.hash !== '#/locked' && document.querySelector('#stage h2')?.textContent === 'Locked') lockedLeft = true;
    const slide = (/^#\\/(\\d+)$/.exec(location.hash) || [])[1] || '1';
    const title = location.pathname.endsWith('/settings') ? 'Settings'
      : location.hash === '#/locked' ? 'Locked' : 'Slide ' + slide;
    document.getElementById('stage').innerHTML = '<h2>' + title + '</h2>';
  };
  addEventListener('hashchange', render);
  addEventListener('popstate', render);
  document.getElementById('next').onclick = () => {
    const slide = Number((/^#\\/(\\d+)$/.exec(location.hash) || [])[1] || 1);
    location.hash = '#/' + (slide + 1);
  };
  document.getElementById('lock').onclick = () => { location.hash = '#/locked'; };
  // A router link handles its own click, as single-page apps do.
  document.getElementById('routerLink').onclick = (event) => {
    event.preventDefault();
    history.pushState(null, '', home.replace(/[^/]*$/, 'settings') + location.search);
    render();
  };
  document.getElementById('route').onclick = () => {
    history.pushState(null, '', home.replace(/[^/]*$/, 'settings') + location.search);
    render();
  };
  render();
  window.clicks = { counted: 0, shadow: 0 };
  window.addEventListener('click', (event) => { if (event.target.id === 'counted') clicks.counted++; }, true);
  document.getElementById('proxy').onclick = () => document.getElementById('chk').click();
  customElements.define('x-host', class extends HTMLElement {
    connectedCallback() {
      const button = document.createElement('button');
      button.textContent = 'Shadow';
      button.onclick = () => clicks.shadow++;
      this.attachShadow({ mode: 'open' }).append(button);
    }
  });
  window.addEventListener('message', event => {
    if (event.source === parent && event.data.kind === 'ready-check') window.previewHandshake = event.data;
  });
</script>`
    writeFileSync(
      file,
      view === 'screens'
        ? screensHtml('Interactive document')
        : fixtureHtml('Initial document'),
    )
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
      if (view === 'screens') {
        await shell.setViewportSize({ width: 1280, height: 800 })
        const frameHandle = async () => {
          const handle = await (await shell
            .locator('#artifactFrame')
            .elementHandle())!.contentFrame()
          assert.ok(handle)
          await handle.waitForFunction(() =>
            Boolean(
              (window as unknown as { previewHandshake: unknown })
                .previewHandshake,
            ),
          )
          return handle
        }
        let frame = await frameHandle()
        const heading = () => frame.locator('#stage h2')
        const stored = async () =>
          (
            (await (await fetch(`${ready.url}api/annotations`)).json()) as {
              annotations: {
                comment: string
                anchor: { screen?: string }
              }[]
            }
          ).annotations
        const addComment = async (comment: string) => {
          await shell.locator('#popover.show').waitFor()
          await shell.locator('#popText').fill(comment)
          const saved = shell.waitForResponse(
            (response) =>
              response.url().endsWith('/api/annotations') &&
              response.request().method() === 'POST',
          )
          await shell.locator('#popAdd').click()
          assert.equal((await saved).status(), 200)
          await shell.locator('#popover.show').waitFor({ state: 'hidden' })
        }
        const otherScreen = (comment: string) =>
          shell
            .locator('.thread')
            .filter({ hasText: comment })
            .locator('button.screen-link')
        const result = { checks: [] as string[] }

        // Comment mode shows how to use the page; Alt+click operates it.
        await shell.locator('#modeHint').waitFor()
        assert.equal(
          await shell.locator('#modeHint').textContent(),
          'Alt/Option+click uses the page',
        )
        await frame.locator('#next').click({ modifiers: ['Alt'] })
        await heading().filter({ hasText: 'Slide 2' }).waitFor()
        assert.equal(await shell.locator('#popover.show').count(), 0)
        // A link to another document is routed like a plain click, never by
        // navigating the preview frame away from the file.
        await frame.locator('#away').click({ modifiers: ['Alt'] })
        // test-wait: elapsed-time — observe the absence of a frame navigation, which nothing signals.
        await shell.waitForTimeout(300)
        assert.equal(
          await frame.evaluate(() => document.title),
          'Interactive document',
        )
        await heading().filter({ hasText: 'Slide 2' }).waitFor()
        // Controls run exactly once and nothing they trigger becomes a pick.
        await frame.locator('#chk').click({ modifiers: ['Alt'] })
        assert.equal(await frame.locator('#chk').isChecked(), true)
        await frame.locator('#proxy').click({ modifiers: ['Alt'] })
        assert.equal(await frame.locator('#chk').isChecked(), false)
        await frame.locator('#counted').click({ modifiers: ['Alt'] })
        await frame.locator('#host').click({ modifiers: ['Alt'] })
        assert.deepEqual(
          await frame.evaluate(
            () => (window as unknown as { clicks: unknown }).clicks,
          ),
          { counted: 1, shadow: 1 },
        )
        assert.equal(await shell.locator('#popover.show').count(), 0)
        result.checks.push('alt-click-operates')

        // A plain click still annotates, and the comment keeps its screen.
        await heading().click()
        await addComment('Slide two note')
        await frame.locator('#next').click({ modifiers: ['Alt'] })
        await heading().filter({ hasText: 'Slide 3' }).waitFor()
        await otherScreen('Slide two note').waitFor()
        assert.equal(await shell.locator('.thread.orphaned').count(), 0)
        assert.equal(await shell.locator('#orphanNotice.show').count(), 0)
        await heading().click()
        await addComment('Slide three note')
        const screens = Object.fromEntries(
          (await stored()).map((entry) => [entry.comment, entry.anchor.screen]),
        )
        assert.deepEqual(screens, {
          'Slide two note': '#/2',
          'Slide three note': '#/3',
        })
        result.checks.push('same-selector-separate-screens')

        // The keyboard reaches the other-screen action, which restores the
        // comment's screen and shows its element.
        await otherScreen('Slide two note').focus()
        await shell.keyboard.press('Enter')
        await heading().filter({ hasText: 'Slide 2' }).waitFor()
        await otherScreen('Slide three note').waitFor()
        await otherScreen('Slide two note').waitFor({ state: 'detached' })
        // Unsent comments survive moving between screens.
        assert.equal(await shell.locator('.thread').count(), 2)
        // A route with a malformed escape is still its own screen.
        await frame.locator('#badHash').click({ modifiers: ['Alt'] })
        await frame.waitForFunction(() => location.hash === '#/q%zz')
        await heading().click()
        await addComment('Odd route note')
        assert.equal(
          (await stored()).find((entry) => entry.comment === 'Odd route note')!
            .anchor.screen,
          '#/q%zz',
        )
        await otherScreen('Slide two note').waitFor()
        result.checks.push('restore-hash-screen')

        // An in-page fragment is not a screen.
        await frame.locator('#toIntro').click({ modifiers: ['Alt'] })
        await frame.waitForFunction(() => location.hash === '#intro')
        await frame.locator('#intro').click()
        await addComment('Intro note')
        assert.equal(
          (await stored()).find((entry) => entry.comment === 'Intro note')!
            .anchor.screen,
          undefined,
        )
        result.checks.push('in-page-fragment')

        // A History API route is a screen and is restored with popstate.
        // WebKit rejects the History API inside an opaque-origin sandbox, so
        // such documents cannot route there at all; record the difference.
        const historyApi = await frame.evaluate(() => {
          try {
            const current = location.href
            history.replaceState(history.state, '', location.pathname + 'probe')
            history.replaceState(history.state, '', current)
            return true
          } catch {
            return false
          }
        })
        if (historyApi) {
          // The router link's own handler runs; the frame never leaves the file.
          await frame.locator('#routerLink').click({ modifiers: ['Alt'] })
          await heading().filter({ hasText: 'Settings' }).waitFor()
          await heading().click()
          await addComment('Settings note')
          assert.equal(
            (await stored()).find((entry) => entry.comment === 'Settings note')!
              .anchor.screen,
            '/settings',
          )
          await shell
            .locator('.thread')
            .filter({ hasText: 'Slide two note' })
            .click()
          await heading().filter({ hasText: 'Slide 2' }).waitFor()
          assert.equal(
            await frame.evaluate(() => location.pathname.endsWith('/settings')),
            false,
          )
          result.checks.push('restore-history-route')
        } else result.checks.push('history-api-unavailable')

        // A screen the document no longer shows is never attached elsewhere.
        await frame.locator('#lock').click({ modifiers: ['Alt'] })
        await heading().filter({ hasText: 'Locked' }).waitFor()
        await heading().click()
        await addComment('Locked note')
        await frame.locator('#next').click({ modifiers: ['Alt'] })
        await heading().filter({ hasText: 'Slide 2' }).waitFor()
        await shell
          .locator('.thread')
          .filter({ hasText: 'Locked note' })
          .click()
        await shell
          .locator('.thread.orphaned')
          .filter({ hasText: 'Locked note' })
          .waitFor()
        await shell.locator('#orphanNotice.show').waitFor()
        assert.equal(await shell.locator('.thread.orphaned').count(), 1)
        await shell.locator('#orphanKeep').click()
        result.checks.push('unrestorable-orphaned')

        // After a file update, the reader returns to the screen they were on.
        await shell
          .locator('.thread')
          .filter({ hasText: 'Slide three note' })
          .click()
        await heading().filter({ hasText: 'Slide 3' }).waitFor()
        const reloaded = shell.waitForEvent('framenavigated', {
          predicate: (navigated) => navigated.url().includes('/artifact?rev='),
        })
        writeFileSync(file, screensHtml('Updated interactive document'))
        await reloaded
        frame = await frameHandle()
        await frame.waitForFunction(
          () => document.title === 'Updated interactive document',
        )
        await heading().filter({ hasText: 'Slide 3' }).waitFor()
        await otherScreen('Slide two note').waitFor()
        result.checks.push('reload-keeps-screen')

        // A quote repeated on every screen is highlighted only on its own.
        // Select the quote directly; a pointer gesture would also pick the
        // paragraph element in comment mode.
        await frame.evaluate(() => {
          const range = document.createRange()
          range.selectNodeContents(document.getElementById('intro')!)
          getSelection()!.removeAllRanges()
          getSelection()!.addRange(range)
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        })
        await addComment('Intro quote')
        await frame.evaluate(() => getSelection()!.removeAllRanges())
        // Painted as CSS custom highlights where supported, else as marks.
        await frame.waitForFunction(
          () =>
            document.querySelectorAll('.ash-comment-highlight-badge').length +
              ((globalThis as { CSS?: { highlights?: { size: number } } }).CSS
                ?.highlights?.size ?? 0) >
            0,
        )
        await frame.locator('#next').click({ modifiers: ['Alt'] })
        await heading().filter({ hasText: 'Slide 4' }).waitFor()
        await otherScreen('Intro quote').waitFor()
        await frame.waitForFunction(
          () =>
            document.querySelectorAll('.ash-comment-highlight-badge').length +
              ((globalThis as { CSS?: { highlights?: { size: number } } }).CSS
                ?.highlights?.size ?? 0) ===
            0,
        )
        result.checks.push('highlights-per-screen')

        // The default screen can be restored too (fragment only, no History API).
        await otherScreen('Intro note').focus()
        await shell.keyboard.press('Enter')
        await frame.waitForFunction(() => ['', '#'].includes(location.hash))
        await otherScreen('Intro note').waitFor({ state: 'detached' })
        result.checks.push('restore-default-screen')

        // Moving on while a screen is being restored is not a failed restore.
        await otherScreen('Slide two note').click()
        await frame.locator('#next').click({ modifiers: ['Alt'] })
        await frame.waitForFunction(() => location.hash === '#/3')
        await otherScreen('Slide two note').waitFor()
        assert.equal(
          await shell
            .locator('.thread.orphaned')
            .filter({ hasText: 'Slide two note' })
            .count(),
          0,
        )
        result.checks.push('restore-superseded')
        return result
      }
      if (view === 'popover') {
        const measurements: PopoverMeasurements = []
        await shell.setViewportSize({ width: 1280, height: 800 })
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
          element.style.position = 'absolute'
          element.style.top = 'calc(100vh - 80px)'
          element.style.left = 'min(780px, 30vw)'
        })
        await frame.locator('#sample').click()
        await shell.locator('#popover.show').waitFor()
        const draft = 'Keep this exact draft\nthrough resizing and shutdown'
        await shell.locator('#popText').fill(draft)
        const target = await shell.locator('#popTarget').textContent()
        // Pick a different target before intercepting Add: this is the original
        // focus-loss order, not a frame interaction after the failure.
        await frame.locator('h1').click()
        await shell
          .locator('#popStatus')
          .filter({ hasText: 'Finish or cancel' })
          .waitFor()
        await shell.route('**/api/annotations', (route) =>
          route.request().method() === 'POST'
            ? route.fulfill({ status: 503, json: {} })
            : route.continue(),
        )
        for (const size of [
          { width: 1280, height: 800 },
          { width: 390, height: 600 },
          { width: 390, height: 844 },
          { width: 600, height: 390 },
          { width: 844, height: 390 },
          { width: 844, height: 390, nearTop: true },
        ]) {
          await shell.setViewportSize({
            width: size.width,
            height: size.height,
          })
          if ('nearTop' in size) {
            // Keep the same selected node and draft, but move it where the
            // editor cannot fit above it, as in the reported landscape case.
            await frame.locator('#sample').evaluate((element) => {
              element.style.top = '80px'
            })
          }
          // Compare with the actual responsive authored target, not the opening
          // rectangle or merely the outer viewport. Browser/subprocess execution
          // is necessary for native frame layout and hit testing.
          const currentTarget = await frame.locator('#sample').boundingBox()
          assert.ok(currentTarget)
          await shell.waitForFunction((targetBounds) => {
            const pop = document
              .querySelector('#popover')!
              .getBoundingClientRect()
            const above = targetBounds.y - pop.height - 8
            const expected =
              above >= 8
                ? above
                : Math.max(
                    8,
                    Math.min(
                      targetBounds.y + targetBounds.height + 8,
                      innerHeight - 8 - pop.height,
                    ),
                  )
            return Math.abs(pop.top - expected) <= 1
          }, currentTarget)
          // Native viewport changes also generate visualViewport resize events.
          const failed = shell.waitForResponse(
            (response) =>
              response.url().endsWith('/api/annotations') &&
              response.status() === 503,
          )
          await Promise.all([failed, shell.locator('#popAdd').click()])
          await shell.waitForFunction(
            () =>
              !(document.querySelector('#popAdd') as HTMLButtonElement)
                .disabled,
          )
          assert.equal(
            await shell.evaluate(() => document.activeElement?.id),
            'popText',
            'failed Add restores editor focus',
          )
          const popBounds = await shell.locator('#popover').boundingBox()
          assert.ok(popBounds)
          if (currentTarget.y - popBounds.height - 8 >= 8)
            assert.ok(
              Math.abs(popBounds.y + popBounds.height + 8 - currentTarget.y) <=
                1,
              'popover prefers above the current responsive target',
            )
          if ('nearTop' in size) {
            assert.ok(
              currentTarget.y - popBounds.height - 8 < 8,
              'landscape fixture must leave insufficient room above the target',
            )
            const fallbackTop = Math.max(
              8,
              Math.min(
                currentTarget.y + currentTarget.height + 8,
                size.height - 8 - popBounds.height,
              ),
            )
            assert.ok(
              Math.abs(popBounds.y - fallbackTop) <= 1,
              'no-room fallback is below the real target, clamped to the viewport',
            )
          }
          assert.equal(await shell.locator('#popText').inputValue(), draft)
          assert.equal(await shell.locator('#popTarget').textContent(), target)
          for (const selector of ['#popAdd', '#popCancel']) {
            measurements.push({
              ...size,
              selector,
              hit: await shell.locator(selector).evaluate((element) => {
                const rect = element.getBoundingClientRect()
                return (
                  rect.left >= 0 &&
                  rect.top >= 0 &&
                  rect.right <= innerWidth &&
                  rect.bottom <= innerHeight &&
                  document.elementFromPoint(
                    rect.x + rect.width / 2,
                    rect.y + rect.height / 2,
                  ) === element
                )
              }),
            })
          }
        }
        await shell.unroute('**/api/annotations')
        // Hold the POST so moves from the editor to a control, frame, or
        // other window happen before the failure. The already-focused frame
        // message path is covered separately by the happy-dom shell test.
        for (const destination of [
          'canvas',
          'frame',
          'frame-keyboard',
          'window',
        ]) {
          let release!: () => void
          const held = new Promise<void>((resolveHeld) => {
            release = resolveHeld
          })
          await shell.route('**/api/annotations', async (route) => {
            if (route.request().method() !== 'POST') return route.continue()
            await held
            await route.fulfill({ status: 503, json: {} })
          })
          let other: Page | null = null
          let focusObservation: JSHandle<{
            calls: string[]
            restore(): void
          }> | null = null
          try {
            await shell.locator('#popText').fill(draft)
            // Preserve the original frame pick -> Add order; the test must not
            // activate the parent to compensate for the product.
            await frame.locator('h1').click()
            const started = shell.waitForRequest(
              (request) =>
                request.url().endsWith('/api/annotations') &&
                request.method() === 'POST',
            )
            await Promise.all([started, shell.locator('#popAdd').click()])
            assert.equal(await shell.locator('#popCancel').isDisabled(), true)
            assert.equal(
              await shell.locator('#popText').getAttribute('aria-busy'),
              'true',
            )
            assert.equal(
              await shell.locator('#popStatus').textContent(),
              'Confirming save…',
            )
            await shell.keyboard.type('must not replace submitted text')
            assert.equal(await shell.locator('#popText').inputValue(), draft)
            if (destination === 'canvas')
              await shell.locator('#canvasBackground').focus()
            if (destination === 'frame') await frame.locator('h1').click()
            if (destination === 'frame-keyboard') {
              // Establish frame ownership after Add, then Tab into authored
              // content without a reporter pick/selection. Firefox otherwise
              // cycles in the shell before ever reaching the authored input.
              await shell.locator('#artifactFrame').focus()
              for (let count = 0; count < 12; count++) {
                await shell.keyboard.press('Tab')
                if (
                  await frame
                    .locator('input')
                    .evaluate((element) => document.activeElement === element)
                )
                  break
              }
              assert.equal(
                await frame
                  .locator('input')
                  .evaluate((element) => document.activeElement === element),
                true,
              )
              await shell.keyboard.type('authored input retained')
            }
            if (destination === 'window') {
              // Headless pages can both report hasFocus=true. Observe an explicit
              // platform blur after Add activation, not an alleged OS switch.
              focusObservation = await shell.evaluateHandle(() => {
                const calls: string[] = []
                const editor =
                  document.querySelector<HTMLTextAreaElement>('#popText')!
                const windowFocus = window.focus
                const editorFocus = editor.focus
                window.focus = () => {
                  calls.push('window')
                  windowFocus.call(window)
                }
                editor.focus = () => {
                  calls.push('editor')
                  editorFocus.call(editor)
                }
                window.dispatchEvent(new Event('blur'))
                return {
                  calls,
                  restore() {
                    window.focus = windowFocus
                    editor.focus = editorFocus
                  },
                }
              })
              other = await shell.context().newPage()
              await other.setContent('<input aria-label="Other window">')
              await other.bringToFront()
              await other.locator('input').click()
              await other.locator('input').fill('other input retained')
            }
            release()
            await shell.waitForFunction(
              () =>
                !(document.querySelector('#popAdd') as HTMLButtonElement)
                  .disabled,
            )
            assert.equal(await shell.locator('#popText').inputValue(), draft)
            assert.equal(
              await shell.locator('#popTarget').textContent(),
              target,
            )
            if (destination !== 'window') {
              assert.equal(
                await shell.evaluate(() => document.activeElement?.id),
                destination === 'canvas' ? 'canvasBackground' : 'artifactFrame',
                'failed Add preserves deliberate focus movement',
              )
            } else {
              assert.deepEqual(
                await focusObservation!.evaluate(
                  (observation) => observation.calls,
                ),
                [],
                'failed Add makes no focus calls after observed window blur',
              )
              assert.equal(
                await other!.locator('input').inputValue(),
                'other input retained',
              )
            }
            if (destination === 'frame-keyboard')
              assert.equal(
                await frame.locator('input').inputValue(),
                'authored input retained',
              )
          } finally {
            release()
            if (focusObservation) {
              await focusObservation.evaluate((observation) =>
                observation.restore(),
              )
              await focusObservation.dispose()
            }
            if (other) await other.close()
            await shell.unroute('**/api/annotations')
          }
        }
        // Block the real persistence parent, then verify actual failure keeps the
        // same draft. No mocked server result can stand in for this boundary.
        const previews = join(dir, 'config', 'previews')
        renameSync(previews, previews + '-saved')
        writeFileSync(previews, 'blocked')
        try {
          await frame.locator('h1').click()
          const failed = shell.waitForResponse(
            (response) =>
              response.url().endsWith('/api/annotations') &&
              response.status() === 500,
          )
          await Promise.all([failed, shell.locator('#popAdd').click()])
          await shell.waitForFunction(
            () =>
              !(document.querySelector('#popAdd') as HTMLButtonElement)
                .disabled,
          )
          assert.equal(await shell.locator('#popText').inputValue(), draft)
          assert.equal(
            await shell.evaluate(() => document.activeElement?.id),
            'popText',
            'failed Add restores editor focus',
          )
        } finally {
          rmSync(previews)
          renameSync(previews + '-saved', previews)
        }
        const exited = once(child, 'exit')
        child.kill('SIGTERM')
        await exited
        await shell.locator('#endedScreen.show').waitFor()
        assert.equal(await shell.locator('#popText').inputValue(), draft)
        assert.equal(
          await shell
            .locator('#popText')
            .evaluate((element) => (element as HTMLTextAreaElement).readOnly),
          true,
        )
        assert.ok(
          (await shell.locator('#endedBody').textContent())!.includes(
            'Copy it before closing',
          ),
        )
        assert.ok(
          (await shell.locator('#endedBody code').textContent())!.includes(
            'artifactshare preview',
          ),
        )
        await shell.locator('#popText').focus()
        await shell.locator('#popText').press('ControlOrMeta+A')
        assert.equal(
          await shell.locator('#popText').evaluate((element) => {
            const input = element as HTMLTextAreaElement
            return input.value.slice(input.selectionStart, input.selectionEnd)
          }),
          draft,
          'ended draft remains selectable for copying',
        )
        return measurements
      }
      if (view === 'share') {
        const measurements: ShareMeasurements = []
        for (const locale of ['en', 'ja'])
          for (const colorScheme of ['light', 'dark'] as const)
            for (const width of [440, 390]) {
              await shell.context().addInitScript(
                (language) =>
                  Object.defineProperty(navigator, 'language', {
                    configurable: true,
                    value: language,
                  }),
                locale,
              )
              let shareState = 'error'
              let snapshotFails = false
              let snapshots = 0
              let contextHeld: Promise<void> | null = null
              const pattern = ready.share_origin + '/api/**'
              await shell.context().route(pattern, async (route) => {
                const path = new URL(route.request().url()).pathname
                if (path === '/api/context' && contextHeld) await contextHeld
                if (path === '/api/context')
                  return route.fulfill({
                    json: {
                      authenticated: true,
                      default_visibility: 'private',
                      projects: [
                        { id: 'synthetic-project', name: 'Review project' },
                      ],
                    },
                  })
                if (path === '/api/snapshot') {
                  snapshots++
                  return route.fulfill(
                    snapshotFails
                      ? { status: 500, json: {} }
                      : {
                          json: {
                            snapshot_id: 'synthetic-snapshot',
                            taken_at: new Date().toISOString(),
                          },
                        },
                  )
                }
                if (path === '/api/auth-status')
                  return route.fulfill({ json: { status: 'authenticated' } })
                if (path === '/api/share') {
                  if (shareState === 'error')
                    return route.fulfill({
                      status: 503,
                      json: { error: { code: 'network_failed' } },
                    })
                  if (shareState === 'auth')
                    return route.fulfill({
                      json: {
                        auth_required: true,
                        auth_id: 'synthetic-auth',
                        user_code: 'CODE',
                        verification_uri: ready.share_origin + '/authorize',
                        interval_seconds: 1,
                      },
                    })
                  return route.fulfill({
                    json: {
                      url: 'https://example.com/shared',
                      visibility: 'link',
                      warnings: [],
                    },
                  })
                }
                return route.abort()
              })
              const dialog = await openPopup(shell.context(), () =>
                shell.locator('#shareBtn').click(),
              )
              try {
                await dialog.waitForLoadState('domcontentloaded')
                await dialog.setViewportSize({ width, height: 560 })
                await dialog.emulateMedia({ colorScheme })
                await dialog.waitForFunction(
                  () =>
                    !(document.querySelector('#shareBtn') as HTMLButtonElement)
                      .disabled,
                )
                const result = {
                  locale,
                  colorScheme,
                  width,
                  states: ['form'],
                  contrast: [
                    await textContrast(dialog.locator('#destLabel')),
                    await textContrast(dialog.locator('#visLabel')),
                  ],
                }
                // Activate the page that owns the controls, including after a
                // shell-triggered refresh. macOS WebKit's native Tab preference
                // skips buttons; Option+Tab traverses all keyboard controls.
                const tabKey =
                  process.platform === 'darwin' &&
                  dialog.context().browser()!.browserType().name() === 'webkit'
                    ? 'Alt+Tab'
                    : 'Tab'
                const focusByKeyboard = async (id: string) => {
                  await dialog.bringToFront()
                  if (tabKey === 'Alt+Tab')
                    await dialog.evaluate(() => window.focus())
                  for (let count = 0; count < 10; count++) {
                    if (
                      await dialog.evaluate(
                        (targetId) => document.activeElement?.id === targetId,
                        id,
                      )
                    )
                      break
                    await dialog.keyboard.press(tabKey)
                  }
                  assert.equal(
                    await dialog.evaluate(() => document.activeElement?.id),
                    id,
                  )
                  assert.equal(
                    await dialog.locator('#' + id).evaluate((element) => {
                      const rect = element.getBoundingClientRect()
                      return (
                        rect.top >= 0 &&
                        rect.bottom <= innerHeight &&
                        document.elementFromPoint(
                          rect.x + rect.width / 2,
                          rect.y + rect.height / 2,
                        ) === element
                      )
                    }),
                    true,
                  )
                }
                await focusByKeyboard('destination')
                assert.ok(await dialog.locator('#destLabel').textContent())
                await focusByKeyboard('visibility')
                if (locale === 'en') {
                  // Native closed-select typeahead for "Anyone with the link".
                  await dialog.keyboard.press('a')
                } else {
                  // Japanese text insertion is not a native picker key action.
                  // This locale covers selection retention and recovery; only
                  // the English flow witnesses OS-picker keyboard selection.
                  await dialog.locator('#visibility').selectOption('link')
                }
                assert.equal(
                  await dialog.locator('#visibility').inputValue(),
                  'link',
                )
                await focusByKeyboard('shareBtn')
                await dialog.keyboard.press('Enter')
                await dialog
                  .locator('#shareError')
                  .waitFor({ state: 'visible' })
                await dialog.waitForFunction(
                  () =>
                    !(document.querySelector('#shareBtn') as HTMLButtonElement)
                      .disabled,
                )
                assert.equal(
                  await dialog.evaluate(() => document.activeElement?.id),
                  'shareBtn',
                )
                result.states.push('upload-error')
                result.contrast.push(
                  await textContrast(dialog.locator('#shareError')),
                )
                snapshotFails = true
                await shell.locator('#shareBtn').click()
                await dialog
                  .locator('#snapshotRetry')
                  .waitFor({ state: 'visible' })
                assert.equal(
                  await dialog.locator('#shareBtn').isDisabled(),
                  true,
                )
                // An earlier capture time must not remain as an empty or stale note.
                assert.equal(
                  await dialog.locator('#snapshotNote').isVisible(),
                  false,
                )
                result.states.push('snapshot-failed')
                await dialog.waitForFunction(
                  () =>
                    !(
                      document.querySelector(
                        '#snapshotRetry',
                      ) as HTMLButtonElement
                    ).disabled,
                )
                assert.equal(
                  await dialog.evaluate(() => document.activeElement?.id),
                  'snapshotRetry',
                  'failed refresh transfers disabled Share focus to retry',
                )
                await focusByKeyboard('snapshotRetry')
                await dialog.keyboard.press('Enter')
                await dialog.waitForFunction(
                  () =>
                    !(
                      document.querySelector(
                        '#snapshotRetry',
                      ) as HTMLButtonElement
                    ).disabled,
                )
                assert.equal(
                  await dialog.evaluate(() => document.activeElement?.id),
                  'snapshotRetry',
                  'failed snapshot retry restores keyboard focus',
                )
                snapshotFails = false
                await dialog.keyboard.press('Enter')
                await dialog.waitForFunction(
                  () =>
                    !(document.querySelector('#shareBtn') as HTMLButtonElement)
                      .disabled,
                )
                assert.equal(
                  await dialog.evaluate(() => document.activeElement?.id),
                  'destination',
                )
                // Passive refresh preserves the selected audience and current focus.
                await focusByKeyboard('visibility')
                const previousSnapshots = snapshots
                const refreshed = dialog.waitForResponse((response) =>
                  response.url().endsWith('/api/snapshot'),
                )
                await Promise.all([
                  refreshed,
                  shell.locator('#shareBtn').click(),
                ])
                assert.ok(snapshots > previousSnapshots)
                assert.equal(
                  await dialog.evaluate(() => document.activeElement?.id),
                  'visibility',
                )
                assert.equal(
                  await dialog.locator('#visibility').inputValue(),
                  'link',
                )
                shareState = 'auth'
                await focusByKeyboard('shareBtn')
                await dialog.keyboard.press('Enter')
                await dialog.locator('.dialog.auth').waitFor()
                assert.equal(
                  await dialog.evaluate(() => document.activeElement?.id),
                  'authLink',
                )
                result.states.push('auth')
                await dialog.waitForFunction(
                  () =>
                    document.querySelector('#dialog')!.className === 'dialog' &&
                    document.activeElement?.id === 'destination',
                )
                assert.equal(
                  await dialog.locator('#visibility').inputValue(),
                  'link',
                )
                assert.ok(await dialog.locator('#shareError').isVisible())
                const confirmGuidance = await dialog
                  .locator('#shareError')
                  .textContent()
                // A failed passive refresh must not drop the request to confirm
                // the newly loaded destination once the retry succeeds.
                snapshotFails = true
                await shell.locator('#shareBtn').click()
                await dialog
                  .locator('#snapshotRetry')
                  .waitFor({ state: 'visible' })
                snapshotFails = false
                await dialog.locator('#snapshotRetry').click()
                await dialog.waitForFunction(
                  () =>
                    !(document.querySelector('#shareBtn') as HTMLButtonElement)
                      .disabled,
                )
                assert.ok(await dialog.locator('#shareError').isVisible())
                assert.equal(
                  await dialog.locator('#shareError').textContent(),
                  confirmGuidance,
                )
                // A control chosen while projects load after sign-in keeps focus.
                let releaseContext!: () => void
                contextHeld = new Promise((release) => {
                  releaseContext = release
                })
                const contextRequested = dialog.waitForRequest((request) =>
                  request.url().endsWith('/api/context'),
                )
                await focusByKeyboard('shareBtn')
                await dialog.keyboard.press('Enter')
                await contextRequested
                await dialog.waitForFunction(
                  () =>
                    document.querySelector('#dialog')!.className === 'dialog',
                )
                // The deliberate move itself is not under test; WebKit's
                // headless Tab order is covered elsewhere.
                await dialog.locator('#cancelBtn').focus()
                const contextLoaded = dialog.waitForResponse((response) =>
                  response.url().endsWith('/api/context'),
                )
                contextHeld = null
                releaseContext()
                await contextLoaded
                await dialog.waitForFunction(
                  (expected) =>
                    document.querySelector('#shareError')!.textContent ===
                    expected,
                  confirmGuidance,
                )
                assert.equal(
                  await dialog.evaluate(() => document.activeElement?.id),
                  'cancelBtn',
                  'sign-in return keeps a deliberately chosen control',
                )
                shareState = 'done'
                await focusByKeyboard('shareBtn')
                await dialog.keyboard.press('Enter')
                await dialog.locator('.dialog.shared').waitFor()
                assert.equal(
                  await dialog.evaluate(() => document.activeElement?.id),
                  'shareUrl',
                )
                assert.equal(
                  await dialog.locator('#shareUrl').inputValue(),
                  'https://example.com/shared',
                )
                result.states.push('done')
                await focusByKeyboard('continueBtn')
                if (
                  locale === 'ja' &&
                  colorScheme === 'dark' &&
                  width === 390
                ) {
                  // Finish must stop the real loopback process and release its
                  // agent poll, not merely paint an ended screen.
                  const pending = Promise.allSettled([
                    fetch(ready.url + 'api/agent/next', {
                      method: 'POST',
                      headers: {
                        'content-type': 'application/json',
                        'x-artifactshare-preview': '1',
                      },
                      body: JSON.stringify({ wait: 10 }),
                      signal: AbortSignal.timeout(15000),
                    }).then((response) => response.json()),
                  ])
                  await shell.waitForFunction(async () => {
                    const response = await fetch('/api/agent/next', {
                      method: 'POST',
                      headers: {
                        'content-type': 'application/json',
                        'x-artifactshare-preview': '1',
                      },
                      body: JSON.stringify({ wait: 0 }),
                    })
                    return response.status === 409
                  })
                  await focusByKeyboard('finishBtn')
                  const stopped = Promise.allSettled([
                    once(child, 'exit', {
                      signal: AbortSignal.timeout(15000),
                    }),
                  ])
                  const stopResponse = shell.waitForResponse((response) =>
                    response.url().endsWith('/api/agent/stop'),
                  )
                  // Finish owns this popup's closure; a closing target can reject
                  // the key acknowledgement even after its handler ran.
                  const closed = dialog.waitForEvent('close')
                  const key = dialog.keyboard.press('Enter').then(
                    () => null,
                    (error: unknown) => error,
                  )
                  const [stoppedResponse, , keyError] = await Promise.all([
                    stopResponse,
                    closed,
                    key,
                  ])
                  if (keyError !== null) {
                    assert.ok(keyError instanceof Error)
                    assert.match(
                      keyError.message,
                      /Target page, context or browser has been closed|Target page\/context\/browser has been closed|(?:Input\.dispatchKeyEvent|Protocol error \(Input\.dispatchKeyEvent\)): Page closed/,
                    )
                    assert.equal(dialog.isClosed(), true)
                  }
                  assert.equal(stoppedResponse.status(), 200)
                  const [pollResult] = await pending
                  assert.equal(pollResult.status, 'fulfilled')
                  if (pollResult.status === 'fulfilled')
                    assert.equal(
                      (pollResult.value as { session_ended?: boolean })
                        .session_ended,
                      true,
                    )
                  const [exitResult] = await stopped
                  assert.equal(exitResult.status, 'fulfilled')
                  if (exitResult.status === 'fulfilled')
                    assert.deepEqual(exitResult.value, [0, null])
                  await shell.locator('#endedScreen.show').waitFor()
                }
                measurements.push(result)
              } finally {
                await dialog.close()
                await shell.context().unroute(pattern)
              }
            }
        return measurements
      }
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
      if (view === 'markdown-frame') {
        const frames = []
        for (const colorScheme of ['light', 'dark'] as const) {
          await shell.emulateMedia({ colorScheme })
          frames.push(
            await shell.locator('#artifactFrame').evaluate((el) => ({
              scheme: getComputedStyle(el).colorScheme,
              background: getComputedStyle(el).backgroundColor,
            })),
          )
        }
        return frames
      }
      if (view === 'theme') {
        const measurements: ThemeMeasurements = {
          textContrast: [],
          buttons: [],
          tokens: [],
          frameSchemes: [],
          canvases: [],
          transparent: '',
          darkMedia: false,
          recoveryContrast: 0,
          authored: '',
        }
        await shell
          .context()
          .route(ready.share_origin + '/api/context', (route) =>
            route.fulfill({
              json: { default_visibility: 'private', projects: [] },
            }),
          )
        const dialog = await openPopup(shell.context(), () =>
          shell.locator('#shareBtn').click(),
        )
        try {
          await dialog.waitForLoadState('domcontentloaded')
          await dialog.setViewportSize({ width: 440, height: 560 })
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
                for (const state of [
                  'default',
                  'hover',
                  'focus',
                  'disabled-hover',
                ]) {
                  await surface.mouse.move(0, 0)
                  await button.evaluate((el) => (el as HTMLElement).blur())
                  await button.evaluate((el, disabled) => {
                    ;(el as HTMLButtonElement).disabled = disabled
                  }, state === 'disabled-hover')
                  if (state === 'hover' || state === 'disabled-hover')
                    await button.hover()
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
            measurements.textContrast.push(
              await textContrast(shell.locator('#popText'), true),
              await textContrast(dialog.locator('#destLabel')),
              await textContrast(dialog.locator('#visLabel')),
            )
            measurements.frameSchemes.push(
              await shell
                .locator('#artifactFrame')
                .evaluate((el) => getComputedStyle(el).colorScheme),
            )
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
          await artifact.addStyleTag({
            content:
              '@media (prefers-color-scheme: dark) { body { color: #eee; } }',
          })
          const authoredColor = await artifact.evaluate(
            () => getComputedStyle(document.body).color,
          )
          await shell
            .locator('#popover')
            .evaluate((el) => el.classList.remove('show'))
          measurements.darkMedia = await artifact.evaluate(
            () => matchMedia('(prefers-color-scheme: dark)').matches,
          )
          const recovery = measurements.darkMedia ? 'dark' : 'light'
          await shell.locator('#canvasBackground').selectOption(recovery)
          measurements.recoveryContrast = await textContrast(
            artifact.locator('body'),
            false,
            measurements.darkMedia ? [17, 19, 21] : [255, 255, 255],
          )
          assert.equal(
            await shell
              .locator('#artifactFrame')
              .evaluate((el) => getComputedStyle(el).backgroundColor),
            measurements.darkMedia ? 'rgb(17, 19, 21)' : 'rgb(255, 255, 255)',
          )
          assert.equal(
            await artifact.evaluate(
              () => getComputedStyle(document.body).color,
            ),
            authoredColor,
          )
          assert.equal(
            await artifact.evaluate(
              () => getComputedStyle(document.body).backgroundColor,
            ),
            'rgba(0, 0, 0, 0)',
          )
          assert.equal(
            await shell.locator('#artifactFrame').getAttribute('sandbox'),
            'allow-scripts',
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
        const [savedResponse] = await Promise.all([
          saved,
          shell.locator('#popAdd').click(),
        ])
        const status = savedResponse.status()
        await shell.locator('#popover.show').waitFor({ state: 'hidden' })
        for (const [index, suffix] of [
          '\ud800',
          '\ud801',
          '\udc00',
          '\ufffd',
        ].entries()) {
          await frame.locator('#sample').evaluate((element, ending) => {
            element.textContent = 'x'.repeat(16_001) + ending
          }, suffix)
          await shell.waitForFunction(
            (count) =>
              document.querySelectorAll('.thread.orphaned').length === count,
            index + 1,
          )
          // Dismiss the real notice before picking the next target underneath it.
          if (await shell.locator('#orphanKeep').isVisible())
            await shell.locator('#orphanKeep').click()
          await frame.locator('#sample').click()
          await shell.locator('#popover.show').waitFor()
          await shell
            .locator('#popText')
            .fill('Keep ambiguous anchor for review')
          const savedAmbiguous = shell.waitForResponse(
            (response) =>
              response.url().endsWith('/api/annotations') &&
              response.request().method() === 'POST',
          )
          const [ambiguousResponse] = await Promise.all([
            savedAmbiguous,
            shell.locator('#popAdd').click(),
          ])
          assert.equal(ambiguousResponse.status(), 200)
          await shell.locator('#popover.show').waitFor({ state: 'hidden' })
        }
        await shell.waitForFunction(
          () => document.querySelectorAll('.thread.orphaned').length === 5,
        )
        const submitted = shell.waitForResponse(
          (response) => response.url() === `${ready.url}api/annotations/submit`,
        )
        await Promise.all([submitted, shell.locator('#submitBtn').click()])
        const previews = join(dir, 'config', 'previews')
        const storedFile = readdirSync(previews).find((name) =>
          name.startsWith('annotations-'),
        )!
        const storedAnchors = JSON.parse(
          readFileSync(join(previews, storedFile), 'utf8'),
        ).annotations.map(
          (entry: { anchor: PreviewAnchor }) => entry.anchor,
        ) as PreviewAnchor[]
        const stored = storedAnchors[0]
        // Restart the production CLI so preview next reads through a reopened store.
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
        // Reopen against a real DOM candidate with the legacy replacement
        // character digest, so missing selectors cannot explain orphaning.
        writeFileSync(
          file,
          fixtureHtml('Reopened document') +
            '<script>document.getElementById("sample").textContent = "x".repeat(16001) + "\\ufffd"</script>',
        )
        child = startCli()
        const reopened = await waitReady()
        await shell.goto(reopened.url)
        await shell.waitForFunction(
          () => document.querySelectorAll('.thread.orphaned').length === 5,
        )
        const nextAnchors = JSON.parse(
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
        ).data.items.map(
          (item: { anchor: PreviewAnchor }) => item.anchor,
        ) as PreviewAnchor[]
        return {
          status,
          stored,
          next: nextAnchors[0],
          ambiguous: storedAnchors.slice(1).map((anchor, index) => ({
            stored: anchor,
            next: nextAnchors[index + 1],
          })),
        }
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
      const [savedResponse] = await Promise.all([
        annotationResponse,
        shell.locator('#popAdd').click(),
      ])
      assert.equal(savedResponse.status(), 200)
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
      (scenario: 'popover'): Promise<PopoverMeasurements>
      (scenario: 'share'): Promise<ShareMeasurements>
      (scenario: 'theme'): Promise<ThemeMeasurements>
      (
        scenario: 'markdown-frame',
      ): Promise<{ scheme: string; background: string }[]>
      (scenario: 'header'): Promise<HeaderMeasurements>
      (scenario: 'oversized'): Promise<OversizedMeasurements>
      (scenario: 'screens'): Promise<{ checks: string[] }>
    }
  }
}
