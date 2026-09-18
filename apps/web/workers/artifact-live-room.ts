import { DurableObject } from 'cloudflare:workers'

export interface ArtifactLivePresence {
  id: string
  name: string
  image: string | null
  initial: string
}

export type ArtifactLiveAttachmentV1 = {
  version: 1
  presence: ArtifactLivePresence
  authorizationDeadlineMs: number
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

const AUTHORIZATION_EXPIRED_CODE = 4401
const AUTHORIZATION_EXPIRED_REASON = 'live-authorization-expired'
const MIN_ADMISSION_REMAINING_MS = 5_000
const MAX_ADMISSION_REMAINING_MS = 65_000

type SocketSnapshot = {
  eligible: Array<{ socket: WebSocket; attachment: ArtifactLiveAttachmentV1 }>
  rejected: WebSocket[]
}

export class ArtifactLiveRoom extends DurableObject<Cloudflare.Env> {
  private alarmUpdate: Promise<void> = Promise.resolve()

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    )
    this.ctx.blockConcurrencyWhile(async () => {
      await this.queueAlarmUpdate()
    })
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const now = Date.now()
    const attachment = parseArtifactLiveAdmission(new URL(request.url), now)
    if (!attachment) return new Response('Not Found', { status: 404 })

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    try {
      server.serializeAttachment(attachment)
      this.ctx.acceptWebSocket(server)
      await this.queueAlarmUpdate()
    } catch {
      invalidateSocket(server)
      this.broadcastPresence(new Set([server]))
      return new Response('Live connection unavailable', { status: 503 })
    }

    this.broadcastPresence()
    return new Response(null, { status: 101, webSocket: client })
  }

  async notifyCommentsChanged(
    originMutationId?: string,
    originUserId?: string,
  ): Promise<void> {
    const hasOrigin =
      isValidOriginValue(originMutationId) && isValidOriginValue(originUserId)
    this.broadcastProduct({
      type: 'comments-changed',
      ...(hasOrigin ? { originMutationId, originUserId } : {}),
    })
    await this.queueAlarmUpdate()
  }

  async notifyViewCountChanged(viewCount: number): Promise<void> {
    this.broadcastProduct({ type: 'view-count-changed', viewCount })
    await this.queueAlarmUpdate()
  }

  async notifyVersionChanged(currentVersionId: string): Promise<void> {
    this.broadcastProduct({ type: 'version-changed', currentVersionId })
    await this.queueAlarmUpdate()
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    invalidateAttachment(ws)
    this.broadcastPresence(new Set([ws]))
    await this.queueAlarmUpdate()
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    invalidateSocket(ws, 1011, 'WebSocket error')
    this.broadcastPresence(new Set([ws]))
    await this.queueAlarmUpdate()
  }

  async alarm(): Promise<void> {
    this.broadcastPresence()
    await this.queueAlarmUpdate()
  }

  private snapshot(
    now: number,
    excluded: ReadonlySet<WebSocket>,
  ): SocketSnapshot {
    const eligible: SocketSnapshot['eligible'] = []
    const rejected: WebSocket[] = []
    for (const socket of this.ctx.getWebSockets()) {
      if (excluded.has(socket)) continue
      const attachment = readValidAttachment(socket, now)
      if (socket.readyState === WebSocket.OPEN && attachment) {
        eligible.push({ socket, attachment })
      } else if (!attachment) {
        rejected.push(socket)
      }
    }
    for (const socket of rejected) invalidateSocket(socket)
    return { eligible, rejected }
  }

  private broadcastProduct(
    message: Exclude<ArtifactLiveMessage, { type: 'presence' }>,
  ): void {
    const excluded = new Set<WebSocket>()
    const snapshot = this.snapshot(Date.now(), excluded)
    for (const rejected of snapshot.rejected) excluded.add(rejected)
    const body = JSON.stringify(message)
    for (const { socket } of snapshot.eligible) {
      try {
        socket.send(body)
      } catch {
        excluded.add(socket)
        invalidateSocket(socket, 1011, 'WebSocket send failed')
      }
    }
    if (excluded.size > 0) this.broadcastPresence(excluded)
  }

  private broadcastPresence(
    initialExcluded: ReadonlySet<WebSocket> = new Set(),
  ): void {
    const excluded = new Set(initialExcluded)
    while (true) {
      const snapshot = this.snapshot(Date.now(), excluded)
      for (const rejected of snapshot.rejected) excluded.add(rejected)
      const users = uniquePresence(snapshot.eligible)
      const body = JSON.stringify({
        type: 'presence',
        users,
      } satisfies ArtifactLiveMessage)
      let failed = false
      for (const { socket } of snapshot.eligible) {
        try {
          socket.send(body)
        } catch {
          failed = true
          excluded.add(socket)
          invalidateSocket(socket, 1011, 'WebSocket send failed')
        }
      }
      if (!failed) return
    }
  }

  private queueAlarmUpdate(): Promise<void> {
    const update = this.alarmUpdate.then(() => this.updateAlarm())
    this.alarmUpdate = update.catch(() => {})
    return update
  }

  private async updateAlarm(): Promise<void> {
    const snapshot = this.snapshot(Date.now(), new Set())
    let earliest: number | null = null
    for (const { attachment } of snapshot.eligible) {
      earliest =
        earliest === null
          ? attachment.authorizationDeadlineMs
          : Math.min(earliest, attachment.authorizationDeadlineMs)
    }
    if (earliest === null) {
      await this.ctx.storage.deleteAlarm()
    } else {
      await this.ctx.storage.setAlarm(earliest)
    }
  }
}

function isValidOriginValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function invalidateAttachment(ws: WebSocket): void {
  try {
    ws.serializeAttachment(null)
  } catch {
    // Exclusion is determined from this operation's set and fresh validation.
  }
}

function invalidateSocket(
  ws: WebSocket,
  code = AUTHORIZATION_EXPIRED_CODE,
  reason = AUTHORIZATION_EXPIRED_REASON,
): void {
  invalidateAttachment(ws)
  try {
    ws.close(code, reason)
  } catch {
    // Send-time validation remains authoritative when closure fails.
  }
}

export function parseArtifactLiveAdmission(
  url: URL,
  now: number,
): ArtifactLiveAttachmentV1 | null {
  const deadlineValue = url.searchParams.get('authorization_deadline_ms')
  if (!deadlineValue || !/^\d+$/.test(deadlineValue)) return null
  const authorizationDeadlineMs = Number(deadlineValue)
  const remaining = authorizationDeadlineMs - now
  if (
    !Number.isSafeInteger(authorizationDeadlineMs) ||
    authorizationDeadlineMs <= 0 ||
    remaining < MIN_ADMISSION_REMAINING_MS ||
    remaining > MAX_ADMISSION_REMAINING_MS
  ) {
    return null
  }
  const presence = parsePresence(url.searchParams)
  if (!presence) return null
  return { version: 1, presence, authorizationDeadlineMs }
}

function parsePresence(params: URLSearchParams): ArtifactLivePresence | null {
  const presence = {
    id: params.get('user_id'),
    name: params.get('name'),
    initial: params.get('initial'),
    image: params.has('image') ? params.get('image') : null,
  }
  return isValidPresence(presence) ? presence : null
}

function readValidAttachment(
  socket: WebSocket,
  now: number,
): ArtifactLiveAttachmentV1 | null {
  let value: unknown
  try {
    value = socket.deserializeAttachment()
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const attachment = value as Partial<ArtifactLiveAttachmentV1>
  if (
    attachment.version !== 1 ||
    !isValidPresence(attachment.presence) ||
    !Number.isSafeInteger(attachment.authorizationDeadlineMs) ||
    !Number.isFinite(attachment.authorizationDeadlineMs) ||
    (attachment.authorizationDeadlineMs ?? 0) <= now
  ) {
    return null
  }
  return attachment as ArtifactLiveAttachmentV1
}

function isValidPresence(value: unknown): value is ArtifactLivePresence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const presence = value as Partial<ArtifactLivePresence>
  return (
    boundedNonblankString(presence.id, 320) &&
    boundedNonblankString(presence.name, 320) &&
    boundedNonblankString(presence.initial, 16) &&
    (presence.image === null || boundedNonblankString(presence.image, 500))
  )
}

function boundedNonblankString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength
  )
}

function uniquePresence(
  eligible: SocketSnapshot['eligible'],
): ArtifactLivePresence[] {
  const users = new Map<string, ArtifactLivePresence>()
  for (const { attachment } of eligible) {
    if (!users.has(attachment.presence.id)) {
      users.set(attachment.presence.id, attachment.presence)
    }
  }
  return [...users.values()]
}
