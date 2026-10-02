import type { AnchorResolutionMessage } from './csp-reporter'

type Result = AnchorResolutionMessage['results'][number]

/** One displayed frame's UI snapshot and independently acknowledged write queue. */
export function createAnchorResolutionSync(
  url: string,
  apply: (results: Result[]) => void,
  request: typeof fetch = fetch,
) {
  const latest = new Map<string, Result>()
  const saved = new Map<string, string>()
  const sentStates = new Map<string, Result['state']>()
  let lastSentAt = -Infinity
  let cooldownUntil = 0
  let current: AnchorResolutionMessage | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller = new AbortController()
  let sending = false
  let failures = 0
  let disposed = false
  // Save only state or hint changes; include the latest hash in those writes.
  const signature = (result: Result) =>
    JSON.stringify([result.state, result.textStart, result.textEnd])
  const pending = () =>
    [...latest.values()].filter(
      (result) =>
        result.state !== 'checking' &&
        saved.get(result.threadId) !== signature(result),
    )

  async function flush() {
    timer = undefined
    if (disposed || sending || !current) return
    const results = pending().slice(0, 100)
    if (!results.length) return
    const stateChanged = results.some(
      (result) => sentStates.get(result.threadId) !== result.state,
    )
    const delay = Math.max(
      cooldownUntil - Date.now(),
      stateChanged ? 0 : lastSentAt + 10_000 - Date.now(),
    )
    if (delay > 0) {
      timer = setTimeout(() => void flush(), delay)
      return
    }
    lastSentAt = Date.now()
    sending = true
    const signal = controller.signal
    const message = current
    try {
      const response = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          intent: 'anchor-resolutions',
          versionId: message.versionId,
          targetPath: message.targetPath,
          frameToken: message.token,
          generation: message.generation,
          results,
        }),
      })
      if (!response.ok) throw new Error('Position write failed')
      if (signal.aborted) return
      for (const result of results) {
        saved.set(result.threadId, signature(result))
        sentStates.set(result.threadId, result.state)
      }
      failures = 0
    } catch {
      if (!signal.aborted) failures++
    } finally {
      sending = false
      if (!disposed && pending().length && failures < 4)
        timer = setTimeout(
          () => void flush(),
          failures ? 250 * 2 ** (failures - 1) : 0,
        )
    }
  }

  return {
    accept(message: AnchorResolutionMessage) {
      if (disposed) return
      if (current && current.token !== message.token) {
        controller.abort()
        controller = new AbortController()
        latest.clear()
        saved.clear()
        sentStates.clear()
        lastSentAt = -Infinity
        cooldownUntil = 0
        clearTimeout(timer)
        timer = undefined
        failures = 0
      } else if (current && message.generation <= current.generation) return
      const changed = message.results.some(
        (result) =>
          result.state !== 'checking' &&
          signature(result) !==
            (latest.has(result.threadId)
              ? signature(latest.get(result.threadId)!)
              : undefined),
      )
      if (changed) {
        if (failures >= 4) cooldownUntil = Date.now() + 30_000
        failures = 0
      }
      current = message
      for (const result of message.results) latest.set(result.threadId, result)
      apply([...latest.values()])
      if (!sending && failures < 4) {
        clearTimeout(timer)
        timer = undefined
        void flush()
      }
    },
    reapply() {
      if (!disposed && latest.size) apply([...latest.values()])
    },
    dispose() {
      disposed = true
      controller.abort()
      clearTimeout(timer)
      latest.clear()
    },
  }
}
