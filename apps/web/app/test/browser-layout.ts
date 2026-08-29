export async function waitForBrowserLayout() {
  await document.fonts.ready
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}
