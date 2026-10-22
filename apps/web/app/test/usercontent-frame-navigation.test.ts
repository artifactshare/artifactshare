import { setImmediate } from 'node:timers/promises'
import type { Frame, Page } from 'playwright'
import { expect, test, vi } from 'vitest'
import { navigateUsercontentViewer } from './usercontent-frame-navigation'

const origin = 'https://a-abc123def4--v-7631.usercontent.example'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(initialUrl: string) {
  const main = {} as Frame
  const committed = deferred<Frame>()
  let predicate: (frame: Frame) => boolean
  const child = (url: string, parent: Frame | null = main) =>
    ({ url: () => url, parentFrame: () => parent }) as Frame
  const initial = child(initialUrl)
  const attached = {
    ...child(`${origin}/index.html#section`),
    waitForURL: vi.fn(async (matches: (url: URL) => boolean) => {
      expect(matches(new URL('about:blank'))).toBe(false)
      expect(
        matches(new URL('https://a-abc123def4--v-7632.usercontent.example/')),
      ).toBe(false)
      expect(matches(new URL(`${origin}/index.html#section`))).toBe(true)
    }),
  }
  let current = initial
  const element = {
    contentFrame: vi.fn(async () => current),
    dispose: vi.fn(async () => {}),
  }
  const elementHandle = vi.fn(async () => element)
  const liveLocator = {}
  const page = {
    mainFrame: () => main,
    waitForEvent: vi.fn((event: string, accepts: typeof predicate) => {
      expect(event).toBe('framenavigated')
      predicate = accepts
      return committed.promise
    }),
    locator: vi.fn(() => ({ first: () => ({ elementHandle }) })),
    frameLocator: vi.fn(() => ({ first: () => liveLocator })),
  }
  return {
    page: page as unknown as Page,
    element,
    elementHandle,
    attached,
    liveLocator,
    emit(url: string, isMain = false) {
      const frame = child(url, isMain ? null : main)
      if (predicate(frame)) {
        current = attached as unknown as Frame
        committed.resolve(frame)
      }
    },
    subscribed: () => expect(page.waitForEvent).toHaveBeenCalledOnce(),
  }
}

test.each([
  ['first load', 'about:blank'],
  ['public reload', `${origin}/next.html`],
  ['reload after clearing authority', `${origin}/index.html`],
])(
  '%s waits for the new execution commit before resolving the iframe',
  async (_stage, previousUrl) => {
    const f = fixture(previousUrl)
    const navigate = vi.fn(async () => {
      f.subscribed()
      // Parent load and successful asset responses can precede the child commit.
    })
    const pending = navigateUsercontentViewer(f.page, origin, navigate)
    await setImmediate()
    expect(navigate).toHaveBeenCalledOnce()
    expect(f.elementHandle).not.toHaveBeenCalled()

    f.emit('about:blank')
    f.emit(`${origin}/`, true)
    f.emit('https://a-abc123def4--v-7632.usercontent.example/')
    f.emit('https://l-abc123def4--v-7631.usercontent.example/')
    f.emit('https://abc123def4.sandbox.app.example/')
    await setImmediate()
    expect(f.elementHandle).not.toHaveBeenCalled()

    f.emit(`${origin}/index.html#section`)
    expect(await pending).toBe(f.liveLocator)
    expect(f.elementHandle).toHaveBeenCalledOnce()
    expect(f.attached.waitForURL).toHaveBeenCalledOnce()
    expect(f.element.dispose).toHaveBeenCalledOnce()
  },
)

test('observes an execution commit that happens before the shell navigation resolves', async () => {
  const f = fixture('about:blank')
  const navigation = deferred<void>()
  const pending = navigateUsercontentViewer(f.page, origin, () => {
    f.emit(`${origin}/`)
    return navigation.promise
  })
  await setImmediate()
  expect(f.elementHandle).not.toHaveBeenCalled()
  navigation.resolve()
  expect(await pending).toBe(f.liveLocator)
})

test('propagates navigation failures without reading the old iframe', async () => {
  const f = fixture(`${origin}/`)
  await expect(
    navigateUsercontentViewer(f.page, origin, async () => {
      throw new Error('Shell navigation failed')
    }),
  ).rejects.toThrow('Shell navigation failed')
  expect(f.elementHandle).not.toHaveBeenCalled()
})
