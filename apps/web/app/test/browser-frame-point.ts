/** Convert a borderless iframe's viewport coordinates to Playwright page coordinates. */
export function browserFramePoint(
  box: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  point: { x: number; y: number },
) {
  return {
    x: box.x + (point.x * box.width) / viewport.width,
    y: box.y + (point.y * box.height) / viewport.height,
  }
}
