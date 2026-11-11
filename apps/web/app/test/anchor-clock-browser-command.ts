import { defineBrowserCommand } from '@vitest/browser-playwright'
import type { Browser, Page } from 'playwright'
import { requiredWait } from './browser-waits'

type Scenario = 'persisted-deadline' | 'unload'
type Resolution = {
  kind: string
  generation: number
  results?: { state: string }[]
}
type FixtureWindow = Window & {
  anchorMessages: Resolution[]
  anchorBadge: Element | null
}

function observe(page: Page) {
  return page.evaluate(() => {
    const host = window as unknown as FixtureWindow
    const message = host.anchorMessages.findLast(
      (entry) => entry.kind === 'anchor-resolutions',
    )
    const doc = document.querySelector('iframe')!.contentDocument!
    const registry = (
      doc.defaultView as unknown as {
        CSS: { highlights: Map<string, Set<Range>> }
      }
    ).CSS.highlights
    return {
      generation: message?.generation ?? -1,
      states: message?.results?.map((entry) => entry.state) ?? [],
      verdictCount: host.anchorMessages.filter(
        (entry) => entry.kind === 'anchor-verdicts',
      ).length,
      paintCount: registry.size,
      badgeConnected: host.anchorBadge?.isConnected ?? false,
    }
  })
}

async function send(page: Page, kind: string, fields: object) {
  await page.evaluate(
    ({ kind: messageKind, fields: messageFields }) =>
      document.querySelector('iframe')!.contentWindow!.postMessage(
        {
          source: 'artifactshare-parent',
          kind: messageKind,
          textAnchorsEnabled: true,
          versionId: 'synthetic-v1',
          targetPath: '/index.html',
          ...messageFields,
        },
        '*',
      ),
    { kind, fields },
  )
}

function waitForReport(page: Page, kind: string, states = '') {
  // Protocol events and their Node timeout keep running while the application
  // clock is paused. A browser-side polling timer would share the fake clock.
  return requiredWait(
    'anchor clock report',
    page.waitForEvent('console', {
      predicate: (message) =>
        message.text() === `anchor-clock:${kind}:${states}`,
      timeout: 5000,
    }),
  )
}

async function lifecycle(page: Page, persisted: boolean) {
  await page.evaluate((isPersisted) => {
    const realm = document.querySelector('iframe')!.contentWindow as Window &
      typeof globalThis
    for (const name of ['pagehide', 'pageshow'])
      realm.dispatchEvent(
        new realm.PageTransitionEvent(name, { persisted: isPersisted }),
      )
  }, persisted)
}

async function runLifecycle(
  browser: Browser,
  scenario: Scenario,
  reporterBody: string,
) {
  // Playwright clocks cover every page/frame in a context. Own a separate
  // context so Vitest, its RPC, and the remaining real-time tests keep theirs.
  const context = await browser.newContext({ locale: 'en-US' })
  try {
    const page = await context.newPage()
    const start = new Date('2026-01-01T00:00:00Z')
    await page.clock.install({ time: start })
    await page.clock.pauseAt(new Date(start.getTime() + 1000))
    await page.setContent('<!doctype html><body></body>')
    await page.evaluate(
      ({ body, scenario: fixtureScenario }) =>
        new Promise<void>((resolve) => {
          const host = window as unknown as FixtureWindow
          host.anchorMessages = []
          host.anchorBadge = null
          const frame = document.createElement('iframe')
          frame.style.cssText = 'width:800px;height:600px;border:0'
          addEventListener('message', (event) => {
            if (event.source === frame.contentWindow) {
              host.anchorMessages.push(event.data)
              console.debug(
                `anchor-clock:${event.data.kind}:${event.data.results?.map((entry: { state: string }) => entry.state).join(',') ?? ''}`,
              )
            }
          })
          frame.addEventListener('load', () => resolve(), { once: true })
          const html =
            fixtureScenario === 'unload'
              ? '<p>painted words</p><p id="selected">other words</p>'
              : '<p>other words</p>'
          frame.srcdoc = `<!doctype html><main data-comment-content>${html}</main><script>${body}</script>`
          document.body.appendChild(frame)
        }),
      { body: reporterBody, scenario },
    )
    const highlight = {
      threadId: 'thread-1',
      quotedText: 'selected words',
      prefixText: '',
      suffixText: '',
      count: 1,
    }
    await Promise.all([
      waitForReport(
        page,
        'anchor-resolutions',
        scenario === 'unload' ? 'attached,checking' : 'checking',
      ),
      send(page, 'comment-highlights', {
        highlights:
          scenario === 'unload'
            ? [
                {
                  ...highlight,
                  threadId: 'painted',
                  quotedText: 'painted words',
                },
                highlight,
              ]
            : [highlight],
      }),
    ])
    if (scenario === 'persisted-deadline') {
      const initial = await observe(page)
      await page.clock.runFor(1500)
      await lifecycle(page, true)
      await page.clock.runFor(1499)
      const beforeDeadline = await observe(page)
      await Promise.all([
        waitForReport(page, 'anchor-resolutions', 'needs-check'),
        page.clock.runFor(2),
      ])
      return {
        scenario: 'persisted-deadline' as const,
        initial,
        beforeDeadline,
        after: await observe(page),
      }
    }
    await Promise.all([
      waitForReport(page, 'anchor-verdicts'),
      send(page, 'verify-anchors', {
        verificationId: 1,
        anchors: [
          { kind: 'text', thread: 'thread-1', quotedText: 'selected words' },
        ],
      }),
    ])
    // Observe the same pending 300ms mutation debounce as the real-time tests,
    // then unload before it can run. Do not advance past setup work unseen.
    await page.evaluate(async () => {
      const doc = document.querySelector('iframe')!.contentDocument!
      const realm: Window = doc.defaultView!
      const host = window as unknown as FixtureWindow
      host.anchorBadge = doc.querySelector('.ash-comment-highlight-badge')
      const original = realm.setTimeout
      let scheduled!: () => void
      const pending = new Promise<void>((resolve) => {
        scheduled = resolve
      })
      realm.setTimeout = ((
        handler: TimerHandler,
        delay?: number,
        ...args: unknown[]
      ) => {
        const id = original.call(realm, handler, delay, ...args)
        if (delay === 300) scheduled()
        return id
      }) as typeof realm.setTimeout
      try {
        doc.querySelector('#selected')!.textContent = 'selected words'
        await pending
      } finally {
        realm.setTimeout = original
      }
    })
    const initial = await observe(page)
    await lifecycle(page, false)
    const immediate = await observe(page)
    await page.evaluate(() => {
      document
        .querySelector('iframe')!
        .contentDocument!.querySelector('#selected')!.textContent =
        'changed again'
    })
    await page.clock.runFor(3500)
    // Drain earlier reports from this frame before asserting their absence.
    // Advancing timers alone does not acknowledge posted-message delivery.
    await Promise.all([
      waitForReport(page, 'clock-barrier'),
      page
        .frames()[1]!
        .evaluate(() =>
          window.parent.postMessage(
            { kind: 'clock-barrier', generation: 0 },
            '*',
          ),
        ),
    ])
    return {
      scenario: 'unload' as const,
      initial,
      immediate,
      after: await observe(page),
    }
  } finally {
    await context.close()
  }
}

export const anchorLifecycleScenario = defineBrowserCommand(
  ({ page }, scenario: Scenario, reporterBody: string) =>
    runLifecycle(page.context().browser()!, scenario, reporterBody),
)

declare module 'vitest/browser' {
  interface BrowserCommands {
    anchorLifecycleScenario: (
      scenario: Scenario,
      reporterBody: string,
    ) => ReturnType<typeof runLifecycle>
  }
}
