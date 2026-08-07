import { DurableObject } from 'cloudflare:workers'

export interface ArtifactLivePresence {
  id: string
  name: string
  image: string | null
  initial: string
}

type ArtifactLiveMessage =
  | { type: 'presence'; users: ArtifactLivePresence[] }
  | {
      type: 'comments-changed'
      originMutationId?: string
      originUserId?: string
    }
  | { type: 'view-count-changed'; viewCount: number }
  | { type: 'version-changed'; currentVersionId: string }

export class ArtifactLiveRoom extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    )
  }

  fetch(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const url = new URL(request.url)
    const user = parsePresence(url.searchParams)
    if (!user) return new Response('Not Found', { status: 404 })

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.serializeAttachment(user)
    this.ctx.acceptWebSocket(server)
    this.broadcastPresence()
    return new Response(null, { status: 101, webSocket: client })
  }

  notifyCommentsChanged(
    originMutationId?: string,
    originUserId?: string,
  ): void {
    const hasOrigin =
      isValidOriginValue(originMutationId) && isValidOriginValue(originUserId)
    this.broadcast({
      type: 'comments-changed',
      ...(hasOrigin ? { originMutationId, originUserId } : {}),
    })
  }

  notifyViewCountChanged(viewCount: number): void {
    this.broadcast({ type: 'view-count-changed', viewCount })
  }

  notifyVersionChanged(currentVersionId: string): void {
    this.broadcast({ type: 'version-changed', currentVersionId })
  }

  webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    this.broadcastPresence()
  }

  webSocketError(ws: WebSocket): void {
    safeClose(ws, 1011, 'WebSocket error')
    this.broadcastPresence()
  }

  private broadcastPresence(): void {
    this.broadcast({
      type: 'presence',
      users: uniquePresence(this.ctx.getWebSockets()),
    })
  }

  private broadcast(message: ArtifactLiveMessage): void {
    const body = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue
      try {
        ws.send(body)
      } catch {
        safeClose(ws, 1011, 'WebSocket send failed')
      }
    }
  }
}

function isValidOriginValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    // Presence is recomputed from open sockets, so close failures are harmless.
  }
}

function parsePresence(params: URLSearchParams): ArtifactLivePresence | null {
  const id = params.get('user_id')
  const name = params.get('name')
  const initial = params.get('initial')
  if (!id || !name || !initial) return null
  return {
    id,
    name,
    initial,
    image: params.get('image') || null,
  }
}

function uniquePresence(sockets: WebSocket[]): ArtifactLivePresence[] {
  const users = new Map<string, ArtifactLivePresence>()
  for (const socket of sockets) {
    if (socket.readyState !== 1) continue
    const user = socket.deserializeAttachment() as
      | ArtifactLivePresence
      | undefined
    if (!user || users.has(user.id)) continue
    users.set(user.id, user)
  }
  return [...users.values()]
}
