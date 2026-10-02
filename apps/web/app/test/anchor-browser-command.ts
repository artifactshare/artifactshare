import { defineBrowserCommand } from '@vitest/browser-playwright'
import { browserFramePoint } from './browser-frame-point'

export const selectAnchorText = defineBrowserCommand(
  async (
    { page, frame },
    startSelector: string,
    startOffset: number,
    endSelector: string,
    endOffset: number,
    backwards = false,
  ) => {
    const testFrame = await frame()
    const handle = await testFrame.$('#anchor-reporter')
    const artifact = await handle?.contentFrame()
    if (!artifact || !handle) throw new Error('Anchor fixture is not visible')
    await handle.scrollIntoViewIfNeeded()
    const box = await handle.boundingBox()
    if (!box) throw new Error('Anchor fixture is not visible')
    const measured = await artifact.evaluate(
      (endpoints) => {
        function point(selector: string, offset: number, end: boolean) {
          const element = document.querySelector(selector)!
          const nodes: Text[] = []
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
          )
          let node: Node | null
          while ((node = walker.nextNode())) {
            if (
              node.parentElement!.checkVisibility({ visibilityProperty: true })
            )
              nodes.push(node as Text)
          }
          const text = end ? nodes[nodes.length - 1] : nodes[0]
          const range = document.createRange()
          range.setStart(text, end ? offset - 1 : offset)
          range.setEnd(text, end ? offset : offset + 1)
          const rect = range.getBoundingClientRect()
          return {
            x: end ? rect.right - 0.25 : rect.left + 0.25,
            y: rect.top + rect.height / 2,
          }
        }
        return {
          viewport: { width: innerWidth, height: innerHeight },
          points: [
            point(endpoints.startSelector, endpoints.startOffset, false),
            point(endpoints.endSelector, endpoints.endOffset, true),
          ],
        }
      },
      { startSelector, startOffset, endSelector, endOffset },
    )
    const points = measured.points.map((point) =>
      browserFramePoint(box, measured.viewport, point),
    )
    if (backwards) points.reverse()
    await page.mouse.move(points[0].x, points[0].y)
    await page.mouse.down()
    await page.mouse.move(points[1].x, points[1].y, {
      steps: 12,
    })
    await page.mouse.up()
  },
)

declare module 'vitest/browser' {
  interface BrowserCommands {
    selectAnchorText: (
      startSelector: string,
      startOffset: number,
      endSelector: string,
      endOffset: number,
      backwards?: boolean,
    ) => Promise<void>
  }
}
