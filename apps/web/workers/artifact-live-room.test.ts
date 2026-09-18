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
  let installedAlarm: number | null = null
  const storage = {
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

  test('corrects presence immediately when expiry crosses a delayed alarm read', async () => {
    const deadline = 1_800_000_010_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline - 1)
    const expiring = socket(attachment('expiring', deadline), {
      closeThrows: true,
    })
    expiring.serializeAttachment.mockImplementation(() => {
      throw new Error('invalidation failed')
    })
    const control = socket(attachment('control', deadline + 20_000))
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const fixture = context([expiring, control])
    const room = new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await fixture.initialized()
    await room.alarm()
    expect(messages(control).at(-1)).toEqual({
      type: 'presence',
      users: [expiring.attachment, control.attachment].map(
        (value) => (value as ArtifactLiveAttachmentV1).presence,
      ),
    })
    let finishRead!: (value: number | null) => void
    fixture.storage.getAlarm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        }),
    )
    const pending = room.notifyCommentsChanged()
    await Promise.resolve()
    control.sent.length = 0
    expiring.sent.length = 0
    clock.mockClear()
    // Any extra clock read would expire the control too.
    clock.mockReturnValueOnce(deadline).mockReturnValue(deadline + 20_000)
    finishRead(deadline)
    await pending

    expect(clock).toHaveBeenCalledTimes(1)
    expect(expiring.readyState).toBe(WebSocket.OPEN)
    expect(expiring.attachment).toEqual(attachment('expiring', deadline))
    expect(expiring.sent).toEqual([])
    expect(messages(control)).toEqual([
      {
        type: 'presence',
        users: [attachment('control', deadline + 20_000).presence],
      },
    ])
    expect(fixture.storage.getAlarm).toHaveBeenCalledTimes(3)
    expect(fixture.storage.setAlarm).toHaveBeenLastCalledWith(deadline + 20_000)
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

  test('does not rewrite matching alarms or delete an already absent alarm', async () => {
    const now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const valid = socket(attachment('valid', now + 10_000))
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const fixture = context([valid])
    const room = new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await fixture.initialized()
    await room.notifyCommentsChanged()
    await room.notifyVersionChanged('unchanged')
    await room.alarm()
    expect(fixture.storage.setAlarm).toHaveBeenCalledTimes(1)
    expect(fixture.storage.deleteAlarm).not.toHaveBeenCalled()

    await room.webSocketError(valid)
    await room.alarm()
    await room.notifyViewCountChanged(1)
    expect(fixture.storage.deleteAlarm).toHaveBeenCalledTimes(1)
    expect(fixture.storage.setAlarm).toHaveBeenCalledTimes(1)

    new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await fixture.initialized()
    expect(fixture.storage.deleteAlarm).toHaveBeenCalledTimes(1)
  })

  test('reconstructs without replacing an already installed matching alarm', async () => {
    const now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const fixture = context([socket(attachment('valid', now + 10_000))])
    await fixture.storage.setAlarm(now + 10_000)
    fixture.storage.setAlarm.mockClear()
    new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await fixture.initialized()
    expect(fixture.storage.setAlarm).not.toHaveBeenCalled()
  })

  test('recomputes after an awaited alarm read and serializes subsequent updates', async () => {
    const now = 1_800_000_000_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const sockets = [socket(attachment('expiring', now + 10_000))]
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const fixture = context(sockets)
    const room = new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await fixture.initialized()
    let finishRead!: (value: number | null) => void
    fixture.storage.getAlarm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        }),
    )
    const first = room.notifyVersionChanged('first')
    await Promise.resolve()
    const reads = fixture.storage.getAlarm.mock.calls.length
    const second = room.notifyCommentsChanged()
    await Promise.resolve()
    expect(fixture.storage.getAlarm).toHaveBeenCalledTimes(reads)
    clock.mockReturnValue(now + 10_000)
    sockets.push(socket(attachment('remaining', now + 20_000)))
    finishRead(now + 10_000)
    await Promise.all([first, second])
    expect(fixture.storage.setAlarm.mock.calls).toEqual([
      [now + 10_000],
      [now + 20_000],
    ])
    expect(sockets[0]!.close).toHaveBeenCalled()
  })

  test.each(['getAlarm', 'setAlarm', 'deleteAlarm'] as const)(
    'propagates %s failure from an alarm and permits a later update',
    async (operation) => {
      const now = 1_800_000_000_000
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
      const { ArtifactLiveRoom } = await import('./artifact-live-room')
      const fixture = context([socket(attachment('valid', now + 10_000))])
      const room = new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
      await fixture.initialized()
      if (operation === 'setAlarm') {
        await fixture.storage.deleteAlarm()
      } else if (operation === 'deleteAlarm') {
        clock.mockReturnValue(now + 10_000)
      }
      fixture.storage[operation].mockRejectedValueOnce(
        new Error('storage failed'),
      )
      await expect(room.alarm()).rejects.toThrow('storage failed')
      await expect(room.alarm()).resolves.toBeUndefined()
      expect(await fixture.storage.getAlarm()).toBe(
        operation === 'deleteAlarm' ? null : now + 10_000,
      )
    },
  )

  test('propagates alarm scheduling failure and later ordered updates recover', async () => {
    const now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const valid = socket(attachment('valid', now + 10_000))
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const fixture = context([valid])
    fixture.storage.setAlarm.mockRejectedValueOnce(new Error('alarm failed'))

    new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await expect(fixture.initialized()).rejects.toThrow('alarm failed')

    const second = new ArtifactLiveRoom(fixture.ctx, {} as Cloudflare.Env)
    await fixture.initialized()
    await expect(
      second.notifyVersionChanged('version-2'),
    ).resolves.toBeUndefined()
    expect(fixture.storage.setAlarm).toHaveBeenLastCalledWith(now + 10_000)
  })
})
