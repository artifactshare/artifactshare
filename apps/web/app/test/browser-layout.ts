export async function waitForBrowserLayout() {
  await document.fonts.ready
  // Yield to already scheduled ordinary, non-suspending React commits before
  // inspecting the next frame's layout. This does not flush future updates,
  // suspended data, or concurrent work that needs additional tasks.
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}
