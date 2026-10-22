import assert from 'node:assert/strict'
import type { Page } from 'playwright'

// Arm the child-navigation wait before loading the shell: its inline bootstrap
// can start cross-site navigation before goto/reload completes. A shell load (or
// a 200 document/asset response) does not establish an attached execution frame.
export async function navigateUsercontentViewer(
  page: Page,
  executionOrigin: string,
  navigate: () => Promise<unknown>,
) {
  const committed = page.waitForEvent('framenavigated', (frame) => {
    return (
      frame.parentFrame() === page.mainFrame() &&
      new URL(frame.url()).origin === executionOrigin
    )
  })
  await Promise.all([committed, navigate()])

  // Resolve the element after the commit, not the initial about:blank frame or
  // the previous document's frame on public-page reload. Keep the returned
  // locator live for later operations, including static-site navigation.
  const element = await page.locator('iframe[data-src]').first().elementHandle()
  assert.ok(element, 'Viewer iframe is missing after execution navigation')
  try {
    const frame = await element.contentFrame()
    assert.ok(frame, 'Viewer iframe has no attached execution frame')
    await frame.waitForURL((url) => url.origin === executionOrigin)
  } finally {
    await element.dispose()
  }
  return page.frameLocator('iframe[data-src]').first()
}
