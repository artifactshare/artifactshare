import { setImmediate } from 'node:timers/promises'
import type { Frame, Page } from 'playwright'
import { afterEach, expect, test, vi } from 'vitest'
import {
  createUsercontentResponseGate,
  navigateUsercontentViewer,
  usercontentFrameEvidence,
} from './usercontent-frame-navigation'

const origin = 'https://l-abc123def4--v-7631.usercontent.example'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(initialUrl = 'about:blank') {
  const main = {
    url: () => 'https://abc123def4.link.example/',
    parentFrame: () => null,
  } as Frame
  const child = (url: string, parent: Frame | null = main) =>
    ({ url: () => url, parentFrame: () => parent }) as Frame
  const ready = deferred()
  let frames = [main, child(initialUrl)]
  const listeners = new Set<(frame: Frame) => void>()
  const locator = {}
  const scan = vi.fn(() => frames)
  const readStates = vi.fn(async () => ['ready'])
  const page = {
    mainFrame: () => main,
    frames: scan,
    on: vi.fn((event, listener) => {
      expect(event).toBe('frameattached')
      listeners.add(listener)
    }),
    off: vi.fn((event, listener) => {
      expect(event).toBe('frameattached')
      listeners.delete(listener)
    }),
    locator: vi.fn((selector) => ({
      waitFor: () => {
        expect(selector).toBe('[data-sandbox-state="ready"]')
        return ready.promise
      },
      evaluateAll: readStates,
    })),
    frameLocator: () => ({ first: () => locator }),
  } as unknown as Page
  return {
    page,
    ready,
    locator,
    scan,
    readStates,
    child,
    listeners,
    frames: (next: Frame[]) => {
      frames = next
    },
    attach: () => {
      const attached = child('about:blank')
      frames = [main, attached]
      for (const listener of listeners) listener(attached)
    },
  }
}
afterEach(() => vi.useRealTimers())

test.each([
  ['first load', 'about:blank'],
  ['public reload', `${origin}/next.html`],
  ['authority reload', `${origin}/index.html`],
])(
  '%s gates the response on attachment, then scans only after product readiness without navigation events',
  async (_stage, previousUrl) => {
    const f = fixture(previousUrl)
    const gate = createUsercontentResponseGate()
    let delivered = false
    const pending = navigateUsercontentViewer(
      f.page,
      origin,
      async () => {
        await gate.wait(new URL(origin), 'iframe')
        delivered = true
      },
      gate,
    )
    await setImmediate()
    expect(delivered).toBe(false)
    f.attach()
    await setImmediate()
    expect(delivered).toBe(true)
    expect(f.scan).not.toHaveBeenCalled()
    f.frames([f.child(`${origin}/index.html?t=secret`)])
    f.ready.resolve()
    expect(await pending).toBe(f.locator)
    expect(f.listeners.size).toBe(0)
    expect(await usercontentFrameEvidence(f.page)).toEqual({
      sandboxStates: ['ready'],
      frameUrls: [`${origin}/index.html`],
    })
  },
)

test('polls frame visibility after ready and rejects main, sibling, old and blank frames', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const pending = navigateUsercontentViewer(
    f.page,
    origin,
    async () => {},
    createUsercontentResponseGate(),
  )
  f.frames([
    f.child(origin, null),
    f.child('about:blank'),
    f.child(''),
    f.child('not a URL'),
    f.child('https://a-abc123def4--v-7631.usercontent.example/'),
    f.child('https://abc123def4.sandbox.app.example/'),
  ])
  f.ready.resolve()
  let completed = false
  void pending.then(() => {
    completed = true
  })
  await vi.advanceTimersByTimeAsync(100)
  expect(completed).toBe(false)
  f.frames([f.child(origin)])
  await vi.advanceTimersByTimeAsync(50)
  expect(await pending).toBe(f.locator)
})

test.each(['about:blank', ''])(
  'labels automation visibility failure with unavailable diagnostics and frame URL %j',
  async (frameUrl) => {
    vi.useFakeTimers()
    const f = fixture()
    const pending = navigateUsercontentViewer(
      f.page,
      origin,
      async () => {},
      createUsercontentResponseGate(),
    )
    f.frames([f.child(frameUrl)])
    f.readStates.mockRejectedValue(new Error('Execution context was destroyed'))
    const failure = expect(pending).rejects.toThrow(
      /Automation frame visibility: product reached ready.*unavailable.*frameUrls/,
    )
    f.ready.resolve()
    await vi.advanceTimersByTimeAsync(30_050)
    await failure
    expect(f.listeners.size).toBe(0)
  },
)

test('navigation failure cleans up and releases any held response', async () => {
  const f = fixture()
  const gate = createUsercontentResponseGate()
  let held!: Promise<void>
  await expect(
    navigateUsercontentViewer(
      f.page,
      origin,
      async () => {
        held = gate.wait(new URL(origin), 'iframe')
        throw new Error('Shell navigation failed')
      },
      gate,
    ),
  ).rejects.toThrow('Shell navigation failed')
  await held
  expect(f.scan).not.toHaveBeenCalled()
  expect(f.listeners.size).toBe(0)
})

test('gate ignores other origins and assets, and rearms for reload', async () => {
  const f = fixture()
  const gate = createUsercontentResponseGate()
  for (let navigation = 0; navigation < 2; navigation++) {
    const dispose = gate.arm(f.page, origin)
    await gate.wait(new URL('https://other.usercontent.example/'), 'iframe')
    await gate.wait(new URL(origin), 'script')
    let delivered = false
    const held = gate.wait(new URL(origin), 'iframe').then(() => {
      delivered = true
    })
    await setImmediate()
    expect(delivered).toBe(false)
    f.attach()
    await held
    expect(delivered).toBe(true)
    dispose()
  }
})

test('evidence preserves frame URLs when the viewer execution context is unavailable', async () => {
  const f = fixture(`${origin}/index.html?t=secret`)
  f.readStates.mockRejectedValue(new Error('Execution context was destroyed'))
  expect(await usercontentFrameEvidence(f.page)).toEqual({
    sandboxStates: ['(unavailable)'],
    frameUrls: ['https://abc123def4.link.example/', `${origin}/index.html`],
  })
})
