import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ArtifactLiveAttachmentV1 } from './artifact-live-room'
import { parseArtifactLiveAdmission } from './artifact-live-room'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: DurableObjectState
    env: Cloudflare.Env

    constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

class TestWebSocketRequestResponsePair {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
}

type TestSocket = WebSocket & {
  attachment: unknown
  sent: string[]
  serializeAttachment: ReturnType<typeof vi.fn>
  deserializeAttachment: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

function attachment(
  id: string,
  authorizationDeadlineMs: number,
): ArtifactLiveAttachmentV1 {
  return {
    version: 1,
    presence: {
      id,
      name: `Viewer ${id}`,
      image: null,
      initial: id[0]?.toUpperCase() ?? 'V',
    },
    authorizationDeadlineMs,
  }
}

function socket(
  value: unknown,
  options: { sendThrows?: boolean; closeThrows?: boolean } = {},
) {
  const sent: string[] = []
  const testSocket = {
    readyState: 1,
    attachment: value,
    sent,
    serializeAttachment: vi.fn((next: unknown) => {
      testSocket.attachment = next
    }),
    deserializeAttachment: vi.fn(() => testSocket.attachment),
    close: vi.fn(() => {
      if (options.closeThrows) throw new Error('close failed')
      testSocket.readyState = 3
    }),
    send: vi.fn((body: string) => {
      if (options.sendThrows) throw new Error('send failed')
      sent.push(body)
    }),
  }
  return testSocket as unknown as TestSocket
}

function context(sockets: TestSocket[] = []) {
  let initialization = Promise.resolve()
  let installedAlarm: number | null = null
  const data = new Map<string, unknown>()
  const storage = {
    get: vi.fn(async (key: string) => structuredClone(data.get(key))),
    put: vi.fn(async (key: string, value: unknown) => {
      data.set(key, structuredClone(value))
    }),
    getAlarm: vi.fn(async (): Promise<number | null> => installedAlarm),
    setAlarm: vi.fn(async (deadline: number) => {
      installedAlarm = deadline
    }),
    deleteAlarm: vi.fn(async () => {
      installedAlarm = null
    }),
  }
  const ctx = {
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn(() => sockets),
    storage,
    acceptWebSocket: vi.fn((accepted: TestSocket) => {
      sockets.push(accepted)
    }),
    blockConcurrencyWhile: vi.fn((callback: () => Promise<void>) => {
      initialization = callback()
      return initialization
    }),
  }
  return {
    ctx: ctx as unknown as DurableObjectState,
    storage,
    data,
    sockets,
    initialized: () => initialization,
  }
}

function messages(testSocket: TestSocket) {
  return testSocket.sent.map(
    (body) => JSON.parse(body) as Record<string, unknown>,
  )
}

const nativeResponse = Response
let allocated: TestSocket[]
let clock: ReturnType<typeof vi.spyOn>
const epoch = 1_800_000_000_000

function admission(id = 'viewer', deadline = Date.now() + 60_000) {
  const url = new URL('https://example.test/live')
  const value = attachment(id, deadline)
  url.search = new URLSearchParams({
    user_id: id,
    name: value.presence.name,
    initial: value.presence.initial,
    authorization_deadline_ms: String(deadline),
  }).toString()
  return new Request(url, { headers: { upgrade: 'websocket' } })
}

async function setup(sockets: TestSocket[] = []) {
  const { ArtifactLiveRoom } = await import('./artifact-live-room')
  const fixture = context(sockets)
  const room = new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
  await fixture.initialized()
  return { ...fixture, room }
}

async function reconstruct(fixture: ReturnType<typeof context>) {
  const { ArtifactLiveRoom } = await import('./artifact-live-room')
  const room = new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
  await fixture.initialized()
  return room
}

function presenceMessages(ws: TestSocket) {
  return messages(ws).filter((message) => message.type === 'presence')
}

function budget(fixture: ReturnType<typeof context>) {
  return fixture.data.get('admission-budget') as {
    tokens: number
    timestamp: number
  }
}

describe('ArtifactLiveRoom bounded admission and delivery', () => {
  beforeEach(() => {
    allocated = []
    clock = vi.spyOn(Date, 'now').mockReturnValue(epoch)
    vi.stubGlobal(
      'WebSocketRequestResponsePair',
      TestWebSocketRequestResponsePair,
    )
    vi.stubGlobal('WebSocket', { OPEN: 1, CLOSING: 2, CLOSED: 3 })
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = socket(null)
        1 = socket(null)
        constructor() {
          allocated.push(this[1])
        }
      },
    )
    // Node cannot construct HTTP 101; only the upgrade response is controlled.
    vi.stubGlobal(
      'Response',
      class extends nativeResponse {
        constructor(body: BodyInit | null, init: ResponseInit) {
          super(body, init.status === 101 ? { status: 200 } : init)
          if (init.status === 101)
            Object.defineProperty(this, 'status', { value: 101 })
        }
      },
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test.each([
    [5_000, true],
    [4_999, false],
    [65_000, true],
    [65_001, false],
  ])(
    'retains the inclusive admission window at %i ms',
    (remaining, allowed) => {
      expect(
        parseArtifactLiveAdmission(
          new URL(admission('viewer', epoch + Number(remaining)).url),
          epoch,
        ) !== null,
      ).toBe(allowed)
    },
  )
  test.each(['1x', '1.5', '-1', 'Infinity', ''])(
    'rejects malformed deadline %j without charging',
    async (value) => {
      const fixture = await setup()
      const url = new URL(admission().url)
      url.searchParams.set('authorization_deadline_ms', value)
      expect(
        (
          await fixture.room.fetch(
            new Request(url, { headers: { upgrade: 'websocket' } }),
          )
        ).status,
      ).toBe(404)
      expect(fixture.data.has('admission-budget')).toBe(false)
      expect(allocated).toHaveLength(0)
    },
  )

  test('reserves eight same-user slots before awaited persistence and rejects only newcomers', async () => {
    const fixture = await setup()
    let release!: () => void
    fixture.storage.put.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const pending = Array.from({ length: 9 }, () =>
      fixture.room.fetch(admission()),
    )
    await Promise.resolve()
    release()
    expect(
      (await Promise.all(pending)).map((response) => response.status),
    ).toEqual([...Array(8).fill(101), 429])
    expect(allocated).toHaveLength(8)
    expect(allocated.every((ws) => ws.close.mock.calls.length === 0)).toBe(true)
    expect((await fixture.room.fetch(admission('other'))).status).toBe(101)
    expect(fixture.ctx.getWebSockets).toHaveBeenCalledTimes(1)
    expect(budget(fixture).tokens).toBe(502)
  })

  test.each(['distinct', 'eight tabs'])(
    'bounds a concurrent 128-socket room (%s) and charges rejection without room work',
    async (distribution) => {
      const fixture = await setup()
      const responses = await Promise.all(
        Array.from({ length: 128 }, (_, i) =>
          fixture.room.fetch(
            admission(
              distribution === 'distinct'
                ? `viewer-${i}`
                : `viewer-${Math.floor(i / 8)}`,
            ),
          ),
        ),
      )
      expect(responses.every((response) => response.status === 101)).toBe(true)
      const sends = allocated.reduce(
        (sum, ws) => sum + ws.send.mock.calls.length,
        0,
      )
      const reads = allocated.reduce(
        (sum, ws) => sum + ws.deserializeAttachment.mock.calls.length,
        0,
      )
      for (let i = 0; i < 400; i++) {
        const response = await fixture.room.fetch(admission(`rejected-${i}`))
        expect(response.status).toBe(429)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
      }
      expect(budget(fixture).tokens).toBe(0)
      expect(fixture.ctx.getWebSockets).toHaveBeenCalledTimes(1)
      expect(allocated).toHaveLength(128)
      expect(
        allocated.reduce((sum, ws) => sum + ws.send.mock.calls.length, 0),
      ).toBe(sends)
      expect(
        allocated.reduce(
          (sum, ws) => sum + ws.deserializeAttachment.mock.calls.length,
          0,
        ),
      ).toBe(reads)
      // Retained state contains live identities only, never rejected-user history.
      expect(
        (fixture.room as unknown as { occupancy: Map<string, number> })
          .occupancy.size,
      ).toBe(distribution === 'distinct' ? 128 : 16)
      expect(fixture.data.size).toBe(2)
    },
  )

  test('persists exhaustion across reconstruction, clamps backward time, and refills conservatively', async () => {
    const fixture = await setup(
      Array.from({ length: 8 }, () =>
        socket(attachment('viewer', epoch + 60_000)),
      ),
    )
    for (let i = 0; i < 512; i++)
      expect((await fixture.room.fetch(admission())).status).toBe(429)
    let room = await reconstruct(fixture)
    expect((await room.fetch(admission('other'))).status).toBe(429)
    clock.mockReturnValue(epoch - 1_000)
    expect((await room.fetch(admission('other'))).status).toBe(429)
    expect(budget(fixture)).toEqual({ tokens: 0, timestamp: epoch })
    clock.mockReturnValue(epoch + 1_000)
    room = await reconstruct(fixture)
    expect((await room.fetch(admission('other'))).status).toBe(101)
    expect(budget(fixture).tokens).toBe(15)
  })

  test('corrupt persisted budget fails closed instead of resetting', async () => {
    const fixture = await setup()
    fixture.data.set('admission-budget', {
      tokens: 'invalid',
      timestamp: epoch,
    })
    const room = await reconstruct(fixture)
    const response = await room.fetch(admission())
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(allocated).toHaveLength(0)
  })

  test.each(['pair', 'serialize', 'accept', 'budget', 'alarm'])(
    'releases setup reservations exactly once after %s failure, without refund',
    async (failure) => {
      const fixture = await setup()
      if (failure === 'pair')
        vi.stubGlobal(
          'WebSocketPair',
          class {
            constructor() {
              throw new Error('pair failure')
            }
          },
        )
      if (failure === 'serialize')
        vi.stubGlobal(
          'WebSocketPair',
          class {
            0 = socket(null)
            1 = socket(null)
            constructor() {
              this[1].serializeAttachment.mockImplementationOnce(() => {
                throw new Error('attachment failure')
              })
              allocated.push(this[1])
            }
          },
        )
      if (failure === 'accept')
        (
          fixture.ctx.acceptWebSocket as ReturnType<typeof vi.fn>
        ).mockImplementationOnce((ws: TestSocket) => {
          fixture.sockets.push(ws)
          throw new Error('accept failure')
        })
      if (failure === 'budget')
        fixture.storage.put.mockRejectedValueOnce(new Error('budget failure'))
      if (failure === 'alarm')
        fixture.storage.setAlarm.mockRejectedValueOnce(
          new Error('alarm failure'),
        )
      const response = await fixture.room.fetch(admission())
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(
        (fixture.room as unknown as { reservations: number }).reservations,
      ).toBe(0)
      expect(
        (fixture.room as unknown as { occupancy: Map<string, number> })
          .occupancy.size,
      ).toBe(0)
      for (const ws of allocated) expect(ws.close).toHaveBeenCalled()
      if (failure !== 'budget') expect(budget(fixture).tokens).toBe(511)
    },
  )

  test('retains failed transports against capacity and retries cleanup in bounded lifecycle work', async () => {
    const sockets = Array.from({ length: 8 }, () =>
      socket(attachment('viewer', epoch + 60_000), {
        sendThrows: true,
        closeThrows: true,
      }),
    )
    const fixture = await setup(sockets)
    await fixture.room.notifyCommentsChanged()
    expect((await fixture.room.fetch(admission())).status).toBe(429)
    for (const ws of sockets) {
      expect(ws.send).toHaveBeenCalledTimes(1)
      expect(ws.attachment).toBeNull()
    }
    const calls = sockets.map((ws) => ws.close.mock.calls.length)
    clock.mockReturnValue(epoch + 1_000)
    await fixture.room.alarm()
    sockets.forEach((ws, i) =>
      expect(ws.close.mock.calls.length - calls[i]!).toBe(1),
    )
    expect(fixture.ctx.getWebSockets).toHaveBeenCalledTimes(2)
    // Runtime removal makes capacity reusable even without a close callback.
    sockets.splice(0)
    clock.mockReturnValue(epoch + 2_000)
    await fixture.room.alarm()
    expect((await fixture.room.fetch(admission())).status).toBe(101)
  })

  test('does not evict legacy over-cap sockets or rewrite deadlines, and permits unrelated users below room cap', async () => {
    const sockets = Array.from({ length: 144 }, (_, i) =>
      socket(
        attachment(
          i < 9 ? 'legacy' : `viewer-${i}`,
          epoch + (i < 20 ? 10_000 : 60_000),
        ),
      ),
    )
    const original = sockets.map((ws) => structuredClone(ws.attachment))
    const fixture = await setup(sockets)
    let room = await reconstruct(fixture)
    room = await reconstruct(fixture)
    expect(sockets.map((ws) => ws.attachment)).toEqual(original)
    expect(sockets.every((ws) => !ws.close.mock.calls.length)).toBe(true)
    expect((await room.fetch(admission('newcomer'))).status).toBe(429)
    await room.notifyViewCountChanged(19)
    expect(
      sockets.reduce((sum, ws) => sum + ws.send.mock.calls.length, 0),
    ).toBe(144)
    // Legacy delivery is L=144, intentionally not a 128-recipient guarantee.
    expect(
      sockets.every(
        (ws) => ws.deserializeAttachment.mock.calls.length <= 4 * 144,
      ),
    ).toBe(true)
    clock.mockReturnValue(epoch + 10_000)
    expect((await room.fetch(admission('newcomer'))).status).toBe(101)
    expect(
      sockets.slice(0, 20).every((ws) => ws.close.mock.calls.length === 1),
    ).toBe(true)
    expect(sockets.slice(20, 144).map((ws) => ws.attachment)).toEqual(
      original.slice(20),
    )
    clock.mockReturnValue(epoch + 60_000)
    await room.alarm()
    expect(
      sockets.slice(0, 144).every((ws) => ws.readyState === WebSocket.CLOSED),
    ).toBe(true)

    const underCap = await setup(
      Array.from({ length: 9 }, () =>
        socket(attachment('legacy', epoch + 65_000)),
      ),
    )
    expect((await underCap.room.fetch(admission('legacy'))).status).toBe(429)
    expect((await underCap.room.fetch(admission('different'))).status).toBe(101)
  })

  test.each([8, 128])(
    'fits isolated %i-connection startup, reconnect waves and repeated renewals',
    async (size) => {
      const fixture = await setup()
      for (const second of [0, 2, 6, 12, 72, 132, 192]) {
        clock.mockReturnValue(epoch + second * 1_000)
        for (const ws of fixture.sockets)
          await fixture.room.webSocketClose(ws, 1000, 'reconnect', true)
        const responses = await Promise.all(
          Array.from({ length: size }, (_, i) =>
            fixture.room.fetch(admission(`viewer-${Math.floor(i / 8)}`)),
          ),
        )
        expect(responses.every((response) => response.status === 101)).toBe(
          true,
        )
        if (size === 128 && second <= 12)
          expect(budget(fixture).tokens).toBe(
            ({ 0: 384, 2: 288, 6: 224, 12: 192 } as Record<number, number>)[
              second
            ],
          )
      }
    },
  )

  test('expires slots before re-admission and never delivers after deadlines, including mid-pass expiry', async () => {
    const sockets = Array.from({ length: 8 }, () =>
      socket(attachment('viewer', epoch + 10_000)),
    )
    const fixture = await setup(sockets)
    clock.mockReturnValue(epoch + 10_000)
    expect((await fixture.room.fetch(admission())).status).toBe(101)
    expect(
      sockets.slice(0, 8).every((ws) => ws.send.mock.calls.length === 0),
    ).toBe(true)
    const first = socket(attachment('first', epoch + 20_000))
    const second = socket(attachment('second', epoch + 20_000), {
      closeThrows: true,
    })
    const crossing = await setup([first, second])
    first.send.mockImplementation(() => {
      clock.mockReturnValue(epoch + 20_000)
    })
    second.serializeAttachment.mockImplementation(() => {
      throw new Error('clear failure')
    })
    await crossing.room.notifyCommentsChanged()
    expect(second.send).not.toHaveBeenCalled()
    await crossing.room.notifyVersionChanged('version-2')
    expect(second.send).not.toHaveBeenCalled()
  })

  test('invalid, malformed and CLOSING retained sockets never receive product events', async () => {
    const invalid = [
      socket(null),
      socket({ version: 0 }),
      socket(attachment('expired', epoch), { closeThrows: true }),
      socket(attachment('closing', epoch + 60_000)),
    ]
    Object.defineProperty(invalid[3], 'readyState', {
      value: 2,
      writable: true,
    })
    const valid = socket(attachment('valid', epoch + 60_000))
    const fixture = await setup([...invalid, valid])
    await fixture.room.notifyCommentsChanged('mutation-1', 'viewer-1')
    await fixture.room.notifyViewCountChanged(7)
    await fixture.room.notifyVersionChanged('version-2')
    expect(messages(valid)).toEqual([
      {
        type: 'comments-changed',
        originMutationId: 'mutation-1',
        originUserId: 'viewer-1',
      },
      { type: 'view-count-changed', viewCount: 7 },
      { type: 'version-changed', currentVersionId: 'version-2' },
    ])
    expect(invalid.every((ws) => ws.send.mock.calls.length === 0)).toBe(true)
    valid.attachment = null
    await fixture.room.notifyCommentsChanged()
    expect(valid.send).toHaveBeenCalledTimes(3)
  })

  test('coalesces membership, suppresses same-user churn, persists pending work and does not postpone it', async () => {
    const fixture = await setup()
    await fixture.room.fetch(admission('first'))
    const first = allocated[0]!
    expect(presenceMessages(first)).toHaveLength(1)
    clock.mockReturnValue(epoch + 500)
    await fixture.room.fetch(admission('second'))
    expect(await fixture.storage.getAlarm()).toBe(epoch + 1_000)
    expect(presenceMessages(first)).toHaveLength(1)
    const room = await reconstruct(fixture)
    clock.mockReturnValue(epoch + 1_000)
    await room.alarm()
    expect(presenceMessages(first)).toHaveLength(2)
    expect(presenceMessages(first).at(-1)?.users).toHaveLength(2)
    await room.fetch(admission('first'))
    await room.webSocketClose(allocated[2]!, 1000, 'closed', true)
    await room.webSocketError(allocated[2]!)
    clock.mockReturnValue(epoch + 2_000)
    await room.alarm()
    expect(presenceMessages(first)).toHaveLength(2)
    await room.webSocketClose(allocated[1]!, 1000, 'closed', true)
    clock.mockReturnValue(epoch + 3_000)
    await room.alarm()
    expect(presenceMessages(first).at(-1)?.users).toHaveLength(1)
    await room.alarm()
    expect(presenceMessages(first)).toHaveLength(3)
  })

  test.each(['expiry-renewal', 'join-leave'] as const)(
    'corrects newcomer presence when %s returns to the published projection',
    async (sequence) => {
      const fixture = await setup()
      await fixture.room.fetch(admission('a'))
      if (sequence === 'expiry-renewal')
        await fixture.room.fetch(admission('b', epoch + 5_000))
      clock.mockReturnValue(epoch + 1_000)
      await fixture.room.alarm()
      clock.mockReturnValue(epoch + 5_000)
      if (sequence === 'join-leave') await fixture.room.fetch(admission('b'))
      // In the expiry case fetch releases B before A's renewal snapshot.
      await fixture.room.fetch(admission('a'))
      const newcomer = allocated.at(-1)!
      expect(presenceMessages(newcomer).at(-1)?.users).toHaveLength(
        sequence === 'expiry-renewal' ? 1 : 2,
      )
      const due = await fixture.storage.getAlarm()
      if (sequence === 'expiry-renewal')
        await fixture.room.fetch(admission('b'))
      else await fixture.room.webSocketClose(allocated[1]!, 1000, 'left', true)
      expect(await fixture.storage.getAlarm()).toBe(due)
      // The correction obligation must also survive hibernation.
      const room = await reconstruct(fixture)
      clock.mockReturnValue(epoch + 6_000)
      await room.alarm()
      expect(presenceMessages(newcomer).at(-1)?.users).toEqual(
        (sequence === 'expiry-renewal' ? ['a', 'b'] : ['a']).map(
          (id) => attachment(id, epoch + 60_000).presence,
        ),
      )
      expect(presenceMessages(newcomer)).toHaveLength(2)
      clock.mockReturnValue(epoch + 7_000)
      await room.alarm()
      expect(presenceMessages(newcomer)).toHaveLength(2)
    },
  )

  test.each([128, 320])(
    'keeps persisted metadata fixed-size for %i maximum-field retained viewers',
    async (size) => {
      const values = Array.from({ length: size }, (_, i) => {
        const value = attachment(String(i), epoch + 60_000)
        value.presence = {
          id: String(i).padEnd(320, '\u0001'),
          name: '\u0001'.repeat(320),
          initial: '\u0001'.repeat(16),
          image: '\u0001'.repeat(500),
        }
        return value
      })
      const sockets = values.map((value) => socket(value))
      const fixture = await setup(sockets)
      clock.mockReturnValue(epoch + 1_000)
      await fixture.room.alarm()
      const body = sockets[0]!.sent[0]!
      expect(JSON.parse(body).users).toEqual(values.map((v) => v.presence))
      const bytes = new TextEncoder().encode(body).byteLength
      if (size === 320) expect(bytes).toBeGreaterThan(2 * 1024 * 1024)
      expect(bytes).toBeLessThanOrEqual(
        32 + size * (6 * (320 + 320 + 16 + 500) + 64),
      )
      for (const [key, value] of fixture.storage.put.mock.calls) {
        if (key === 'presence-schedule')
          expect(
            new TextEncoder().encode(JSON.stringify(value)).byteLength,
          ).toBeLessThanOrEqual(160)
      }
      const writes = fixture.storage.put.mock.calls.length
      const alarmWrites = fixture.storage.setAlarm.mock.calls.length
      const room = await reconstruct(fixture)
      await room.notifyCommentsChanged()
      await room.alarm()
      expect(fixture.storage.put).toHaveBeenCalledTimes(writes)
      expect(fixture.storage.setAlarm).toHaveBeenCalledTimes(alarmWrites)
      expect(sockets.every((ws) => ws.close.mock.calls.length === 0)).toBe(true)
      expect(sockets.map((ws) => ws.attachment)).toEqual(values)
    },
  )

  test('persists newer publication work queued during a delayed metadata write', async () => {
    const fixture = await setup()
    await fixture.room.fetch(admission('a'))
    let finish!: () => void
    const put = fixture.storage.put.getMockImplementation()!
    fixture.storage.put.mockImplementationOnce(
      (key, value) =>
        new Promise<void>((resolve) => {
          finish = () => {
            void put(key, value).then(resolve)
          }
        }),
    )
    clock.mockReturnValue(epoch + 1_000)
    const sweep = fixture.room.alarm()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const joining = fixture.room.fetch(admission('b'))
    await vi.waitFor(() => expect(allocated).toHaveLength(2))
    finish()
    await Promise.all([sweep, joining])
    expect(fixture.data.get('presence-schedule')).toMatchObject({
      due: epoch + 2_000,
      published: null,
    })
    const room = await reconstruct(fixture)
    clock.mockReturnValue(epoch + 2_000)
    await room.alarm()
    expect(presenceMessages(allocated[0]!).at(-1)?.users).toHaveLength(2)
    expect(presenceMessages(allocated[1]!).at(-1)?.users).toHaveLength(2)
  })

  test('configures heartbeat and delivers until one millisecond before expiry', async () => {
    const viewer = socket(attachment('viewer', epoch + 10_000))
    const fixture = await setup([viewer])
    expect(fixture.ctx.setWebSocketAutoResponse).toHaveBeenCalledWith(
      new TestWebSocketRequestResponsePair('ping', 'pong'),
    )
    clock.mockReturnValue(epoch + 9_999)
    await fixture.room.notifyCommentsChanged()
    expect(messages(viewer)).toEqual([{ type: 'comments-changed' }])
    clock.mockReturnValue(epoch + 10_000)
    await fixture.room.notifyCommentsChanged()
    expect(viewer.send).toHaveBeenCalledTimes(1)
    expect(viewer.close).toHaveBeenCalledWith(
      4401,
      'live-authorization-expired',
    )
  })

  test('excludes throwing attachments at reconstruction and at delivery', async () => {
    const invalid = socket(attachment('invalid', epoch + 60_000))
    invalid.deserializeAttachment.mockImplementation(() => {
      throw new Error('unreadable attachment')
    })
    const laterInvalid = socket(attachment('later', epoch + 60_000))
    const fixture = await setup([invalid, laterInvalid])
    laterInvalid.deserializeAttachment.mockImplementation(() => {
      throw new Error('unreadable attachment')
    })
    await fixture.room.notifyCommentsChanged()
    clock.mockReturnValue(epoch + 1_000)
    await fixture.room.alarm()
    for (const ws of [invalid, laterInvalid]) {
      expect(ws.send).not.toHaveBeenCalled()
      expect(ws.close).toHaveBeenCalledWith(4401, 'live-authorization-expired')
    }
  })

  test('bounds staged send failures to one attempt per recipient per sweep and final correction within two seconds', async () => {
    const fixture = await setup()
    for (let i = 0; i < 128; i++)
      await fixture.room.fetch(admission(`viewer-${i}`))
    allocated[0]!.send.mockImplementationOnce(() => {
      throw new Error('first stage')
    })
    clock.mockReturnValue(epoch + 1_000)
    const before = allocated.map((ws) => ws.send.mock.calls.length)
    const reads = allocated.map(
      (ws) => ws.deserializeAttachment.mock.calls.length,
    )
    await fixture.room.alarm()
    allocated.forEach((ws, i) => {
      expect(ws.send.mock.calls.length - before[i]!).toBeLessThanOrEqual(1)
      expect(
        ws.deserializeAttachment.mock.calls.length - reads[i]!,
      ).toBeLessThanOrEqual(4)
    })
    allocated[1]!.send.mockImplementationOnce(() => {
      throw new Error('second stage')
    })
    clock.mockReturnValue(epoch + 2_000)
    await fixture.room.alarm()
    clock.mockReturnValue(epoch + 3_000)
    await fixture.room.alarm()
    expect(presenceMessages(allocated[127]!).at(-1)?.users).toHaveLength(126)
    expect(
      allocated.reduce((sum, ws) => sum + ws.send.mock.calls.length, 0),
    ).toBeLessThanOrEqual(128 + 128 * 3)
    expect(fixture.ctx.getWebSockets).toHaveBeenCalledTimes(1)
  })

  test('bounds UTF-8 presence bytes with maximum escaped and multibyte fields', async () => {
    const fixture = await setup()
    for (let i = 0; i < 128; i++) {
      const request = admission(`viewer-${i}`)
      const url = new URL(request.url)
      url.searchParams.set('user_id', `${i}`.padEnd(320, '\u0001'))
      url.searchParams.set('name', '界'.repeat(320))
      url.searchParams.set('initial', '\u0001'.repeat(16))
      url.searchParams.set('image', '\u0001'.repeat(500))
      expect((await fixture.room.fetch(new Request(url, request))).status).toBe(
        101,
      )
    }
    clock.mockReturnValue(epoch + 1_000)
    await fixture.room.alarm()
    const bodies = allocated.flatMap((ws) => ws.sent)
    const bytes = bodies.map(
      (body) => new TextEncoder().encode(body).byteLength,
    )
    const bound = 32 + 128 * (6 * (320 + 320 + 16 + 500) + 64)
    expect(bound).toBe(896032)
    expect(Math.max(...bytes)).toBeLessThanOrEqual(bound)
    expect(bytes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(
      (128 + 128) * bound,
    )
    expect(bodies).toHaveLength(256)
  })

  test('rechecks deadline after awaited setup and retains the pending alarm obligation', async () => {
    const fixture = await setup()
    fixture.storage.getAlarm.mockImplementationOnce(async () => {
      clock.mockReturnValue(epoch + 60_000)
      return null
    })
    expect((await fixture.room.fetch(admission())).status).toBe(503)
    expect(allocated[0]!.send).not.toHaveBeenCalled()
    expect(allocated[0]!.close).toHaveBeenCalled()
    expect(budget(fixture).tokens).toBe(511)
    expect(await fixture.storage.getAlarm()).toBe(epoch + 1_000)
  })

  test('counts partially accepted setup failures until the runtime releases their transports', async () => {
    const fixture = await setup()
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = socket(null)
        1 = socket(null, { closeThrows: true })
        constructor() {
          allocated.push(this[1])
        }
      },
    )
    const accept = fixture.ctx.acceptWebSocket as ReturnType<typeof vi.fn>
    accept.mockImplementation((ws: TestSocket) => {
      fixture.sockets.push(ws)
      throw new Error('partial acceptance')
    })
    for (let i = 0; i < 8; i++)
      expect((await fixture.room.fetch(admission())).status).toBe(503)
    expect((await fixture.room.fetch(admission())).status).toBe(429)
    expect(allocated).toHaveLength(8)
    expect(budget(fixture).tokens).toBe(503)
    expect(
      (fixture.room as unknown as { users: Map<string, unknown> }).users.size,
    ).toBe(0)
    expect(
      (fixture.room as unknown as { reservations: number }).reservations,
    ).toBe(0)
    for (const ws of allocated) {
      await fixture.room.webSocketClose(ws, 1000, 'closed', true)
      await fixture.room.webSocketClose(ws, 1000, 'duplicate', true)
    }
    expect(
      (fixture.room as unknown as { occupancy: Map<string, number> }).occupancy
        .size,
    ).toBe(0)
  })

  test.each(['eligible', 'expired', 'malformed', 'closing'] as const)(
    'corrects unknown base-version presence with a %s retained peer',
    async (peerState) => {
      const survivorAttachment = attachment('survivor', epoch + 60_000)
      const survivor = socket(survivorAttachment)
      const peer = socket(attachment('peer', epoch + 30_000))
      // Base-version storage has attachments and an expiry alarm, but no
      // publication state. The survivor may still display both identities.
      survivor.sent.push(
        JSON.stringify({
          type: 'presence',
          users: [
            survivorAttachment.presence,
            attachment('peer', epoch + 30_000).presence,
          ],
        }),
      )
      if (peerState === 'expired') peer.attachment = attachment('peer', epoch)
      if (peerState === 'malformed') peer.attachment = null
      if (peerState === 'closing')
        Object.defineProperty(peer, 'readyState', { value: 2, writable: true })
      const fixture = context([survivor, peer])
      await fixture.storage.setAlarm(epoch + 30_000)
      expect(fixture.data.size).toBe(0)
      await reconstruct(fixture)
      expect(await fixture.storage.getAlarm()).toBe(epoch + 1_000)
      expect(survivor.send).not.toHaveBeenCalled()
      expect(survivor.attachment).toEqual(survivorAttachment)
      expect(survivor.close).not.toHaveBeenCalled()

      clock.mockReturnValue(epoch + 500)
      const room = await reconstruct(fixture)
      expect(await fixture.storage.getAlarm()).toBe(epoch + 1_000)
      clock.mockReturnValue(epoch + 1_000)
      await room.alarm()
      expect(presenceMessages(survivor).at(-1)?.users).toEqual([
        survivorAttachment.presence,
        ...(peerState === 'eligible'
          ? [attachment('peer', epoch + 30_000).presence]
          : []),
      ])
      expect(survivor.send).toHaveBeenCalledTimes(1)
      if (peerState !== 'eligible') expect(peer.send).not.toHaveBeenCalled()
      const settled = await reconstruct(fixture)
      clock.mockReturnValue(epoch + 2_000)
      await settled.alarm()
      expect(survivor.send).toHaveBeenCalledTimes(1)
    },
  )

  test('accounts for legacy presence work using actual L and U, preserving pending expiry across reconstruction', async () => {
    const legacy = Array.from({ length: 144 }, (_, i) =>
      socket(attachment(i < 9 ? 'legacy' : `viewer-${i}`, epoch + 60_000)),
    )
    const fixture = await setup(legacy)
    await fixture.room.webSocketClose(legacy[143]!, 1000, 'closed', true)
    const room = await reconstruct(fixture)
    const before = legacy.reduce(
      (sum, ws) => sum + ws.deserializeAttachment.mock.calls.length,
      0,
    )
    clock.mockReturnValue(epoch + 1_000)
    await room.alarm()
    const inspections =
      legacy.reduce(
        (sum, ws) => sum + ws.deserializeAttachment.mock.calls.length,
        0,
      ) - before
    const bodies = legacy.flatMap((ws) => ws.sent)
    const users = 135
    const snapshotBound = 32 + users * (6 * (320 + 320 + 16 + 500) + 64)
    expect(inspections).toBeLessThanOrEqual(4 * 144)
    expect(bodies).toHaveLength(143)
    expect(presenceMessages(legacy[0]!).at(-1)?.users).toHaveLength(users)
    expect(
      bodies.reduce(
        (sum, body) => sum + new TextEncoder().encode(body).byteLength,
        0,
      ),
    ).toBeLessThanOrEqual(144 * snapshotBound)
    expect((await room.fetch(admission('newcomer'))).status).toBe(429)
    expect(
      legacy.slice(0, 143).every((ws) => ws.close.mock.calls.length === 0),
    ).toBe(true)
    expect(await fixture.storage.getAlarm()).toBe(epoch + 60_000)
  })

  test('serializes alarm updates and recomputes expiry after a delayed read', async () => {
    const expiring = socket(attachment('expiring', epoch + 10_000))
    const remaining = socket(attachment('remaining', epoch + 20_000))
    const fixture = await setup([expiring, remaining])
    clock.mockReturnValue(epoch + 1_000)
    await fixture.room.alarm()
    let finish!: (value: number | null) => void
    fixture.storage.getAlarm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = fixture.room.notifyCommentsChanged()
    await Promise.resolve()
    const reads = fixture.storage.getAlarm.mock.calls.length
    const second = fixture.room.notifyVersionChanged('version-2')
    await Promise.resolve()
    expect(fixture.storage.getAlarm).toHaveBeenCalledTimes(reads)
    clock.mockReturnValue(epoch + 10_000)
    finish(epoch + 10_000)
    await Promise.all([first, second])
    expect(expiring.close).toHaveBeenCalledWith(
      4401,
      'live-authorization-expired',
    )
    expect(await fixture.storage.getAlarm()).toBe(epoch + 11_000)
    clock.mockReturnValue(epoch + 11_000)
    await fixture.room.alarm()
    expect(presenceMessages(remaining).at(-1)?.users).toEqual([
      attachment('remaining', epoch + 20_000).presence,
    ])
  })

  test.each(['getAlarm', 'setAlarm', 'deleteAlarm'] as const)(
    'keeps pending work after %s failure',
    async (operation) => {
      const fixture = await setup([
        socket(attachment('viewer', epoch + 10_000)),
      ])
      clock.mockReturnValue(epoch + 1_000)
      await fixture.room.alarm()
      if (operation === 'setAlarm') await fixture.storage.deleteAlarm()
      if (operation === 'deleteAlarm') {
        clock.mockReturnValue(epoch + 10_000)
        await fixture.room.alarm()
        clock.mockReturnValue(epoch + 11_000)
      }
      fixture.storage[operation].mockRejectedValueOnce(
        new Error('storage failed'),
      )
      await expect(fixture.room.alarm()).rejects.toThrow('storage failed')
      await fixture.room.alarm()
      expect(await fixture.storage.getAlarm()).toBe(
        operation === 'deleteAlarm' ? null : epoch + 10_000,
      )
    },
  )

  test('does not rewrite matching alarms and propagates storage failure for retry', async () => {
    const fixture = await setup([socket(attachment('viewer', epoch + 10_000))])
    await fixture.room.notifyCommentsChanged()
    await fixture.room.notifyVersionChanged('version-1')
    expect(fixture.storage.setAlarm).toHaveBeenCalledTimes(1)
    fixture.storage.put.mockRejectedValueOnce(new Error('storage failed'))
    clock.mockReturnValue(epoch + 1_000)
    await expect(fixture.room.alarm()).rejects.toThrow('storage failed')
    await fixture.room.alarm()
    expect(fixture.storage.setAlarm).toHaveBeenCalledTimes(2)
  })
})
