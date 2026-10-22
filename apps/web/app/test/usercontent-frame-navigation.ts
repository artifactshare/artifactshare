import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import type { Frame, Page } from 'playwright'

// The shell sets src during parsing. Hold its first execution response until
// the automation client knows the new child, including on public-page reload.
export function createUsercontentResponseGate() {
  let pending: { origin: string; attached: Promise<void> } | undefined
  return {
    arm(page: Page, origin: string) {
      assert.ok(!pending, 'An execution response gate is already armed')
      let release!: () => void
      const attached = new Promise<void>((resolve) => {
        release = resolve
      })
      const onAttached = (frame: Frame) => {
        if (frame.parentFrame() === page.mainFrame()) release()
      }
      pending = { origin, attached }
      page.on('frameattached', onAttached)
      return () => {
        page.off('frameattached', onAttached)
        pending = undefined
        release()
      }
    },
    async wait(url: URL, destination: string | undefined) {
      if (pending?.origin !== url.origin || destination !== 'iframe') return
      const gate = pending
      await gate.attached
      if (pending === gate) pending = undefined
    },
  }
}

export async function usercontentFrameEvidence(page: Page) {
  return {
    sandboxStates: await page
      .locator('[data-sandbox-state]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-sandbox-state')),
      )
      .catch(() => ['(unavailable)']),
    // Do not include signed query parameters in evidence.
    frameUrls: page.frames().map((frame) => frame.url().split('?')[0]),
  }
}

export async function navigateUsercontentViewer(
  page: Page,
  executionOrigin: string,
  navigate: () => Promise<unknown>,
  responseGate: ReturnType<typeof createUsercontentResponseGate>,
) {
  const dispose = responseGate.arm(page, executionOrigin)
  try {
    await navigate()
    // Product readiness is the handshake from the expected origin/window.
    // A Playwright commit event is neither required nor sufficient for it.
    await page.locator('[data-sandbox-state="ready"]').waitFor()
    const deadline = Date.now() + 30_000
    while (
      !page
        .frames()
        .some(
          (frame) =>
            frame.parentFrame() === page.mainFrame() &&
            URL.canParse(frame.url()) &&
            new URL(frame.url()).origin === executionOrigin,
        )
    ) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Automation frame visibility: product reached ready but no tracked execution frame matches ${executionOrigin}; ${JSON.stringify(await usercontentFrameEvidence(page))}`,
        )
      }
      await setTimeout(50)
    }
    return page.frameLocator('iframe[data-src]').first()
  } finally {
    dispose()
  }
}
