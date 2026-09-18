import { beforeEach, describe, expect, test, vi } from 'vitest'
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
  const storage = {
    setAlarm: vi.fn(async (_deadline: number) => {}),
    deleteAlarm: vi.fn(async () => {}),
  }
  const ctx = {
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn(() => sockets),
    storage,
    blockConcurrencyWhile: vi.fn((callback: () => Promise<void>) => {
      initialization = callback()
      return initialization
    }),
  }
  return {
    ctx: ctx as unknown as DurableObjectState,
    storage,
    initialized: () => initialization,
  }
}

function messages(testSocket: TestSocket) {
  return testSocket.sent.map(
    (body) => JSON.parse(body) as Record<string, unknown>,
  )
}

describe('ArtifactLiveRoom', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.stubGlobal(
      'WebSocketRequestResponsePair',
      TestWebSocketRequestResponsePair,
    )
    vi.stubGlobal('WebSocket', { OPEN: 1 })
  })

  test('configures heartbeat auto-response and the earliest reconstructed alarm', async () => {
    const now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const sockets = [
      socket(attachment('later', now + 30_000)),
      socket(attachment('earlier', now + 10_000)),
    ]
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const fixture = context(sockets)

    new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await fixture.initialized()

    expect(
      (fixture.ctx.setWebSocketAutoResponse as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0],
    ).toEqual(expect.objectContaining({ request: 'ping', response: 'pong' }))
    expect(fixture.storage.setAlarm).toHaveBeenLastCalledWith(now + 10_000)
  })

  test.each([
    [5_000, true],
    [4_999, false],
    [65_000, true],
    [65_001, false],
  ])(
    'enforces the inclusive room admission window at %i ms',
    (remaining, admitted) => {
      const now = 1_800_000_000_000
      const url = new URL(
        `https://artifactshare.com/live?user_id=u1&name=Alice&initial=A&authorization_deadline_ms=${now + remaining}`,
      )
      expect(parseArtifactLiveAdmission(url, now) !== null).toBe(admitted)
    },
  )

  test.each(['1x', '1.5', '-1', 'Infinity', ''])(
    'rejects malformed deadline parameter %j',
    (value) => {
      const url = new URL('https://artifactshare.com/live')
      url.searchParams.set('user_id', 'u1')
      url.searchParams.set('name', 'Alice')
      url.searchParams.set('initial', 'A')
      url.searchParams.set('authorization_deadline_ms', value)
      expect(parseArtifactLiveAdmission(url, 1)).toBeNull()
    },
  )

  test('filters expired, legacy, malformed, and throwing attachments from every notification', async () => {
    const now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const valid = socket(attachment('valid', now + 10_000))
    const expired = socket(attachment('expired', now), { closeThrows: true })
    const legacy = socket({
      id: 'legacy',
      name: 'Legacy',
      image: null,
      initial: 'L',
    })
    const malformed = socket(null)
    malformed.deserializeAttachment.mockImplementation(() => {
      throw new Error('deserialize failed')
    })
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const fixture = context([valid, expired, legacy, malformed])
    const room = new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await fixture.initialized()

    await room.notifyCommentsChanged('mutation-1', 'user-1')
    await room.notifyViewCountChanged(7)
    await room.notifyVersionChanged('version-2')

    const productTypes = messages(valid)
      .map((message) => message.type)
      .filter((type) => type !== 'presence')
    expect(productTypes).toEqual([
      'comments-changed',
      'view-count-changed',
      'version-changed',
    ])
    expect(expired.send).not.toHaveBeenCalled()
    expect(legacy.send).not.toHaveBeenCalled()
    expect(malformed.send).not.toHaveBeenCalled()
    expect(expired.close).toHaveBeenCalledWith(
      4401,
      'live-authorization-expired',
    )
  })

  test('allows a send one millisecond before expiry and rejects equality on the next event', async () => {
    const deadline = 1_800_000_010_000
    const now = vi.spyOn(Date, 'now').mockReturnValue(deadline - 1)
    const expiring = socket(attachment('expiring', deadline))
    const control = socket(attachment('control', deadline + 20_000))
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const fixture = context([expiring, control])
    const room = new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await fixture.initialized()

    await room.notifyVersionChanged('before')
    expect(messages(expiring)).toContainEqual({
      type: 'version-changed',
      currentVersionId: 'before',
    })

    expiring.sent.length = 0
    control.sent.length = 0
    now.mockReturnValue(deadline)
    await room.notifyVersionChanged('at')

    expect(expiring.send).not.toHaveBeenCalledWith(
      JSON.stringify({ type: 'version-changed', currentVersionId: 'at' }),
    )
    expect(messages(control)).toContainEqual({
      type: 'version-changed',
      currentVersionId: 'at',
    })
    expect(messages(control)).toContainEqual({
      type: 'presence',
      users: [attachment('control', deadline + 20_000).presence],
    })
  })

  test('excludes send failures and follows with corrected identity-deduplicated presence', async () => {
    const now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const failing = socket(attachment('duplicate', now + 10_000), {
      sendThrows: true,
    })
    const first = socket(attachment('duplicate', now + 20_000))
    const second = socket(attachment('second', now + 30_000))
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const fixture = context([failing, first, second])
    const room = new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await fixture.initialized()

    await room.notifyCommentsChanged()

    expect(messages(first).at(-1)).toEqual({
      type: 'presence',
      users: [
        attachment('duplicate', now + 20_000).presence,
        attachment('second', now + 30_000).presence,
      ],
    })
    expect(messages(second).at(-1)).toEqual(messages(first).at(-1))
  })

  test('a delayed alarm cannot restore an expired socket when invalidation and close throw', async () => {
    const deadline = 1_800_000_010_000
    const now = vi.spyOn(Date, 'now').mockReturnValue(deadline + 5_000)
    const expired = socket(attachment('expired', deadline), {
      closeThrows: true,
    })
    expired.serializeAttachment.mockImplementation(() => {
      throw new Error('invalidation failed')
    })
    const control = socket(attachment('control', deadline + 20_000))
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const fixture = context([expired, control])
    const room = new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await fixture.initialized()

    await room.alarm()
    await room.notifyViewCountChanged(9)

    expect(expired.send).not.toHaveBeenCalled()
    expect(messages(control)).toContainEqual({
      type: 'view-count-changed',
      viewCount: 9,
    })
    expect(fixture.storage.setAlarm).toHaveBeenLastCalledWith(deadline + 20_000)
    now.mockReturnValue(deadline + 20_000)
    await room.alarm()
    expect(fixture.storage.deleteAlarm).toHaveBeenCalled()
  })

  test('reschedules for a later-arriving earlier deadline and removes empty alarms', async () => {
    const now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const later = socket(attachment('later', now + 30_000))
    const sockets = [later]
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const fixture = context(sockets)
    const room = new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await fixture.initialized()
    expect(fixture.storage.setAlarm).toHaveBeenLastCalledWith(now + 30_000)

    const earlier = socket(attachment('earlier', now + 10_000))
    sockets.push(earlier)
    await room.notifyVersionChanged('earlier-arrived')
    expect(fixture.storage.setAlarm).toHaveBeenLastCalledWith(now + 10_000)

    earlier.attachment = null
    await room.webSocketClose(earlier, 1000, 'closed', true)
    expect(fixture.storage.setAlarm).toHaveBeenLastCalledWith(now + 30_000)

    later.attachment = null
    await room.webSocketClose(later, 1000, 'closed', true)
    expect(fixture.storage.deleteAlarm).toHaveBeenCalled()
  })

  test('propagates alarm scheduling failure and later ordered updates recover', async () => {
    const now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const valid = socket(attachment('valid', now + 10_000))
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const fixture = context([valid])
    fixture.storage.setAlarm.mockRejectedValueOnce(new Error('alarm failed'))

    new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await expect(fixture.initialized()).rejects.toThrow('alarm failed')

    fixture.storage.setAlarm.mockResolvedValue(undefined)
    const second = new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await fixture.initialized()
    await expect(
      second.notifyVersionChanged('version-2'),
    ).resolves.toBeUndefined()
    expect(fixture.storage.setAlarm).toHaveBeenLastCalledWith(now + 10_000)
  })
})
