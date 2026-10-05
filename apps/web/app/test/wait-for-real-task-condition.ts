/** Wait for native async work without moving a fake clock. */
export async function waitForRealTaskCondition(
  condition: () => boolean | Promise<boolean>,
  description: string,
  maxTaskYields = 50,
): Promise<void> {
  let channel: MessageChannel | undefined
  try {
    for (let yielded = 0; yielded <= maxTaskYields; yielded += 1) {
      if (await condition()) return
      if (yielded === maxTaskYields) break
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
      `Condition "${description}" did not hold after ${maxTaskYields} real task yields`,
    )
  } finally {
    if (channel) {
      channel.port1.onmessage = null
      channel.port1.close()
      channel.port2.close()
    }
  }
}
