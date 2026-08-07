import { describe, expect, test, vi } from 'vitest'

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
  request: string
  response: string

  constructor(request: string, response: string) {
    this.request = request
    this.response = response
  }
}

function stubWebSocketAutoResponse() {
  vi.stubGlobal(
    'WebSocketRequestResponsePair',
    TestWebSocketRequestResponsePair,
  )
}

describe('ArtifactLiveRoom', () => {
  test('configures hibernation auto-response for heartbeat pings', async () => {
    stubWebSocketAutoResponse()

    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const setWebSocketAutoResponse = vi.fn()

    new ArtifactLiveRoom(
      { setWebSocketAutoResponse } as unknown as DurableObjectState,
      {} as Cloudflare.Env,
    )

    expect(setWebSocketAutoResponse).toHaveBeenCalledWith(
      expect.objectContaining({ request: 'ping', response: 'pong' }),
    )
  })

  test('broadcasts version-changed with the current version id', async () => {
    stubWebSocketAutoResponse()
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const socket = {
      readyState: 1,
      send: vi.fn(),
    }
    const room = new ArtifactLiveRoom(
      {
        setWebSocketAutoResponse: vi.fn(),
        getWebSockets: () => [socket],
      } as unknown as DurableObjectState,
      {} as Cloudflare.Env,
    )

    room.notifyVersionChanged('version-2')

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'version-changed',
        currentVersionId: 'version-2',
      }),
    )
  })

  test('broadcasts comments-changed with scoped origin ids', async () => {
    stubWebSocketAutoResponse()
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const socket = {
      readyState: 1,
      send: vi.fn(),
    }
    const room = new ArtifactLiveRoom(
      {
        setWebSocketAutoResponse: vi.fn(),
        getWebSockets: () => [socket],
      } as unknown as DurableObjectState,
      {} as Cloudflare.Env,
    )

    room.notifyCommentsChanged('mutation-1', 'user-1')

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'comments-changed',
        originMutationId: 'mutation-1',
        originUserId: 'user-1',
      }),
    )
  })

  test('broadcasts comments-changed without an absent origin mutation id', async () => {
    stubWebSocketAutoResponse()
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const socket = {
      readyState: 1,
      send: vi.fn(),
    }
    const room = new ArtifactLiveRoom(
      {
        setWebSocketAutoResponse: vi.fn(),
        getWebSockets: () => [socket],
      } as unknown as DurableObjectState,
      {} as Cloudflare.Env,
    )

    room.notifyCommentsChanged()

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'comments-changed',
      }),
    )
  })

  test('broadcasts comments-changed without a partial origin', async () => {
    stubWebSocketAutoResponse()
    const { ArtifactLiveRoom } = await import('./artifact-live-room')
    const socket = {
      readyState: 1,
      send: vi.fn(),
    }
    const room = new ArtifactLiveRoom(
      {
        setWebSocketAutoResponse: vi.fn(),
        getWebSockets: () => [socket],
      } as unknown as DurableObjectState,
      {} as Cloudflare.Env,
    )

    room.notifyCommentsChanged('mutation-1')

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'comments-changed',
      }),
    )
  })
})
