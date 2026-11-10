import type { BrowserContext, Page } from 'playwright'

// Phase names must be static descriptions, never URLs or credential-bearing data.
export async function requiredWait<T>(
  phase: string,
  pending: Promise<T>,
): Promise<T> {
  try {
    return await pending
  } catch {
    throw new Error(`Browser wait failed: ${phase}`)
  }
}

// The waiter is registered before the trigger. Promise.all observes both
// rejections immediately; abort releases the listener if the trigger fails.
export async function openPopup(
  context: BrowserContext,
  trigger: () => Promise<unknown>,
): Promise<Page> {
  const controller = new AbortController()
  const pending = requiredWait(
    'popup event',
    context.waitForEvent('page', {
      timeout: 30000,
      signal: controller.signal,
    }),
  )
  try {
    const [popup] = await Promise.all([
      pending,
      requiredWait('popup trigger', Promise.resolve().then(trigger)),
    ])
    return popup
  } finally {
    controller.abort()
    await Promise.allSettled([pending])
  }
}
