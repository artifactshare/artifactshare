import { createHash } from 'node:crypto'
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

const ROOM_CAP = 128
const USER_CAP = 8
const BUCKET_CAPACITY = 512
const BUCKET_REFILL_PER_MS = 16 / 1_000
const PRESENCE_INTERVAL_MS = 1_000
const BUDGET_KEY = 'admission-budget'
const PRESENCE_KEY = 'presence-schedule'

type RetainedSocket = {
  socket: WebSocket
  attachment: ArtifactLiveAttachmentV1 | null
  eligible: boolean
  closeReason?: { code: number; reason: string }
}
type AdmissionBudget = { tokens: number; timestamp: number }
type PresenceSchedule = {
  due: number | null
  last: number
  published: string | null // SHA-256 of the last shared snapshot; null means unknown.
}

export class ArtifactLiveRoom extends DurableObject<Cloudflare.Env> {
  private alarmUpdate: Promise<void> = Promise.resolve()
  private budgetUpdate: Promise<unknown> = Promise.resolve()
  private budget: AdmissionBudget | null = null
  private persistedPresence: string | null = null
  private readonly records = new Map<WebSocket, RetainedSocket>()
  private readonly users = new Map<string, Set<RetainedSocket>>()
  private readonly occupancy = new Map<string, number>()
  private nextExpiry: number | null = null
  private expiryDirty = false
  private readonly expirations = new Map<number, Set<RetainedSocket>>()
  private readonly cleanup = new Set<RetainedSocket>()
  private reservations = 0
  private cleanupDue: number | null = null
  private presence: PresenceSchedule = { due: null, last: 0, published: null }

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    )
    this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get<AdmissionBudget>(BUDGET_KEY)
      if (saved === undefined) {
        this.budget = { tokens: BUCKET_CAPACITY, timestamp: Date.now() }
      } else if (
        saved &&
        Number.isFinite(saved.tokens) &&
        saved.tokens >= 0 &&
        saved.tokens <= BUCKET_CAPACITY &&
        Number.isSafeInteger(saved.timestamp) &&
        saved.timestamp >= 0
      ) {
        this.budget = saved
      }
      // Corrupt persisted budget fails admission closed; it never refills from full.
      const schedule =
        await this.ctx.storage.get<PresenceSchedule>(PRESENCE_KEY)
      if (schedule) {
        this.presence = schedule
        this.persistedPresence = JSON.stringify(schedule)
      }
      for (const socket of this.ctx.getWebSockets()) {
        if (socket.readyState === WebSocket.CLOSED) continue
        const attachment = readValidAttachment(socket, Date.now())
        const record = { socket, attachment, eligible: false }
        this.records.set(socket, record)
        if (attachment) this.adjustOccupancy(attachment.presence.id, 1)
        if (attachment && socket.readyState === WebSocket.OPEN) {
          this.activate(record, false)
        } else {
          this.invalidate(record)
        }
      }
      // Base-version storage cannot tell us what retained viewers last saw.
      // Only an empty room has no recipients needing a corrective snapshot.
      if (!schedule && this.users.size === 0) {
        this.presence.published = presenceDigest(this.presenceBody())
      }
      if (this.presence.published !== presenceDigest(this.presenceBody()))
        this.markPresenceDirty()
      await this.queueAlarmUpdate()
    })
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    const attachment = parseArtifactLiveAdmission(
      new URL(request.url),
      Date.now(),
    )
    if (!attachment) return new Response('Not Found', { status: 404 })

    this.expire()
    const id = attachment.presence.id
    const capacity =
      this.records.size + this.reservations < ROOM_CAP &&
      (this.occupancy.get(id) ?? 0) < USER_CAP
    // Reserve before the first await, including budget persistence.
    if (capacity) {
      this.reservations += 1
      this.adjustOccupancy(id, 1)
    }
    let reserved = capacity
    let record: RetainedSocket | undefined
    let server: WebSocket | undefined
    try {
      if (!(await this.chargeAttempt())) return unavailable(429)
      if (!capacity) return unavailable(429)
      if (Date.now() >= attachment.authorizationDeadlineMs)
        return unavailable(503)
      const pair = new WebSocketPair()
      const [client, accepted] = Object.values(pair)
      server = accepted
      server.serializeAttachment(attachment)
      // Track even a partially failing acceptance until closure is confirmed.
      record = { socket: server, attachment, eligible: false }
      this.records.set(server, record)
      this.reservations -= 1
      reserved = false
      this.ctx.acceptWebSocket(server)
      this.activate(record)
      await this.queueAlarmUpdate()
      if (!this.valid(record))
        throw new Error('Live authorization expired during setup')
      const body = this.presenceBody()
      this.send(record, body)
      // A direct snapshot may differ from what existing viewers last saw.
      // Even a return to that old projection must then reach this newcomer.
      if (presenceDigest(body) !== this.presence.published) {
        this.presence.published = null
        this.markPresenceDirty()
        await this.queueAlarmUpdate()
      }
      if (!this.valid(record))
        throw new Error('Initial presence delivery failed')
      return new Response(null, { status: 101, webSocket: client })
    } catch {
      if (record) this.invalidate(record, 1011, 'Live connection setup failed')
      else if (server)
        invalidateSocket(server, 1011, 'Live connection setup failed')
      // Keep cleanup/presence obligations if a setup storage operation failed.
      await this.queueAlarmUpdate().catch(() => {})
      return unavailable(503)
    } finally {
      if (reserved) {
        this.reservations -= 1
        this.adjustOccupancy(id, -1)
      }
    }
  }

  private chargeAttempt(): Promise<boolean> {
    const operation = this.budgetUpdate.then(async () => {
      if (!this.budget) throw new Error('Invalid admission budget')
      const timestamp = Math.max(this.budget.timestamp, Date.now())
      const available = Math.min(
        BUCKET_CAPACITY,
        this.budget.tokens +
          (timestamp - this.budget.timestamp) * BUCKET_REFILL_PER_MS,
      )
      const allowed = available >= 1
      this.budget = { tokens: allowed ? available - 1 : available, timestamp }
      // Keep the consumed in-memory value even when persistence fails.
      await this.ctx.storage.put(BUDGET_KEY, this.budget)
      return allowed
    })
    this.budgetUpdate = operation.catch(() => {})
    return operation
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
    const record = this.records.get(ws)
    if (record) {
      this.invalidate(record)
      this.forget(record)
    }
    await this.queueAlarmUpdate()
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const record = this.records.get(ws)
    if (record) this.invalidate(record, 1011, 'WebSocket error')
    await this.queueAlarmUpdate()
  }

  async alarm(): Promise<void> {
    this.expire()
    if (this.cleanupDue !== null && this.cleanupDue <= Date.now()) {
      const retained = new Set(this.ctx.getWebSockets())
      for (const record of this.cleanup) {
        if (
          !retained.has(record.socket) ||
          record.socket.readyState === WebSocket.CLOSED
        )
          this.forget(record)
        else this.invalidate(record)
      }
      this.cleanupDue = this.cleanup.size
        ? Date.now() + PRESENCE_INTERVAL_MS
        : null
    }
    if (this.presence.due !== null && this.presence.due <= Date.now()) {
      // One validation pass, then one send pass. Send failures queue the next sweep.
      for (const record of this.records.values()) this.valid(record)
      const body = this.presenceBody()
      this.presence.due = null
      this.presence.last = Date.now()
      const digest = presenceDigest(body)
      if (digest !== this.presence.published) {
        this.presence.published = digest
        for (const record of this.records.values()) this.send(record, body)
      }
    }
    await this.queueAlarmUpdate()
  }

  private adjustOccupancy(id: string, delta: number): void {
    const count = (this.occupancy.get(id) ?? 0) + delta
    if (count) this.occupancy.set(id, count)
    else this.occupancy.delete(id)
  }

  private activate(record: RetainedSocket, changed = true): void {
    const attachment = record.attachment!
    record.eligible = true
    let tabs = this.users.get(attachment.presence.id)
    if (!tabs) {
      tabs = new Set()
      this.users.set(attachment.presence.id, tabs)
      if (changed) this.markPresenceDirty()
    }
    tabs.add(record)
    const deadline = attachment.authorizationDeadlineMs
    let expiring = this.expirations.get(deadline)
    if (!expiring) {
      expiring = new Set()
      this.expirations.set(deadline, expiring)
    }
    expiring.add(record)
    this.nextExpiry = Math.min(this.nextExpiry ?? deadline, deadline)
  }

  private markPresenceDirty(): void {
    this.presence.due ??= Math.max(
      Date.now() + PRESENCE_INTERVAL_MS,
      this.presence.last + PRESENCE_INTERVAL_MS,
    )
  }

  private invalidate(
    record: RetainedSocket,
    code = AUTHORIZATION_EXPIRED_CODE,
    reason = AUTHORIZATION_EXPIRED_REASON,
  ): void {
    if (record.eligible) {
      record.eligible = false
      const id = record.attachment!.presence.id
      const tabs = this.users.get(id)!
      const previous = tabs.values().next().value
      tabs.delete(record)
      if (!tabs.size) this.users.delete(id)
      if (
        !tabs.size ||
        (previous === record &&
          JSON.stringify(previous.attachment!.presence) !==
            JSON.stringify(tabs.values().next().value?.attachment?.presence))
      )
        this.markPresenceDirty()
      const deadline = record.attachment!.authorizationDeadlineMs
      const expiring = this.expirations.get(deadline)!
      expiring.delete(record)
      if (!expiring.size) {
        this.expirations.delete(deadline)
        if (deadline === this.nextExpiry) this.expiryDirty = true
      }
    }
    record.closeReason ??= { code, reason }
    invalidateSocket(
      record.socket,
      record.closeReason.code,
      record.closeReason.reason,
    )
    if (record.socket.readyState === WebSocket.CLOSED) this.forget(record)
    else {
      this.cleanup.add(record)
      this.cleanupDue ??= Date.now() + PRESENCE_INTERVAL_MS
    }
  }

  private forget(record: RetainedSocket): void {
    if (!this.records.delete(record.socket)) return
    if (record.attachment)
      this.adjustOccupancy(record.attachment.presence.id, -1)
    this.cleanup.delete(record)
    if (!this.cleanup.size) this.cleanupDue = null
  }

  private expire(): void {
    const now = Date.now()
    if (
      !this.expiryDirty &&
      (this.nextExpiry === null || this.nextExpiry > now)
    )
      return
    this.nextExpiry = null
    // Visit deadline buckets only when the earliest one is due or removed.
    // This also keeps legacy reconstruction linear, without sorting L records.
    for (const [deadline, expiring] of this.expirations) {
      if (deadline <= now) {
        for (const record of expiring) this.invalidate(record)
      } else {
        this.nextExpiry = Math.min(this.nextExpiry ?? deadline, deadline)
      }
    }
    this.expiryDirty = false
  }

  private valid(record: RetainedSocket): boolean {
    if (!record.eligible) return false
    if (
      record.socket.readyState !== WebSocket.OPEN ||
      Date.now() >= record.attachment!.authorizationDeadlineMs ||
      !readValidAttachment(record.socket, Date.now())
    ) {
      this.invalidate(record)
      return false
    }
    return true
  }

  private presenceBody(): string {
    return JSON.stringify({
      type: 'presence',
      users: [...this.users.values()].map(
        (tabs) => tabs.values().next().value!.attachment!.presence,
      ),
    } satisfies ArtifactLiveMessage)
  }

  private send(record: RetainedSocket, body: string): void {
    if (!this.valid(record)) return
    try {
      record.socket.send(body)
    } catch {
      this.invalidate(record, 1011, 'WebSocket send failed')
    }
  }

  private broadcastProduct(
    message: Exclude<ArtifactLiveMessage, { type: 'presence' }>,
  ): void {
    const body = JSON.stringify(message)
    for (const record of this.records.values()) this.send(record, body)
  }

  private queueAlarmUpdate(): Promise<void> {
    const update = this.alarmUpdate.then(() => this.updateAlarm())
    this.alarmUpdate = update.catch(() => {})
    return update
  }

  private async updateAlarm(): Promise<void> {
    const installed = await this.ctx.storage.getAlarm()
    this.expire()
    const schedule = { ...this.presence }
    const serialized = JSON.stringify(schedule)
    if (serialized !== this.persistedPresence) {
      await this.ctx.storage.put(PRESENCE_KEY, schedule)
      this.persistedPresence = serialized
    }
    // State can change while the write is pending; the queued successor persists it.
    const obligations = [
      this.nextExpiry,
      this.presence.due,
      this.cleanupDue,
    ].filter((value): value is number => value != null)
    const earliest = obligations.length ? Math.min(...obligations) : null
    if (installed === earliest) return
    if (earliest === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(earliest)
  }
}

// Synchronous hashing keeps projection comparison and publication in one turn.
function presenceDigest(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

function unavailable(status: 429 | 503): Response {
  return new Response('Live connection unavailable', {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  })
}

function isValidOriginValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function invalidateAttachment(ws: WebSocket): void {
  try {
    ws.serializeAttachment(null)
  } catch {
    // The retained record is already ineligible; send-time deadlines remain authoritative.
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
