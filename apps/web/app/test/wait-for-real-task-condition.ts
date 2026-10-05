// Capture the native clock before tests install fake timers (including performance).
const realNow = performance.now.bind(performance)

/** Wait for native async work without moving a fake clock. */
export async function waitForRealTaskCondition(
  condition: () => boolean | Promise<boolean>,
  description: string,
  budgetMs = 1000,
): Promise<void> {
  const startedAt = realNow()
  let channel: MessageChannel | undefined
  try {
    while (true) {
      if (await condition()) return
      if (realNow() - startedAt >= budgetMs) break
      await Promise.resolve()
      channel ??= new MessageChannel()
      await new Promise<void>((resolve) => {
        channel!.port1.onmessage = () => {
          channel!.port1.onmessage = null
          resolve()
        }
        channel!.port2.postMessage(null)
      })
    }
    throw new Error(
      `Condition "${description}" did not hold after ${budgetMs} ms of real time`,
    )
  } finally {
    if (channel) {
      channel.port1.onmessage = null
      channel.port1.close()
      channel.port2.close()
    }
  }
}
