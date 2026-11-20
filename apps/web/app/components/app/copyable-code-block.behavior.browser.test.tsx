import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { page } from 'vitest/browser'
import { waitForBrowserLayout } from '~/test/browser-layout'
import { TooltipProvider } from '~/components/ui/tooltip'
import { Button } from '~/components/ui/button'
import { CopyableCodeBlock } from './copyable-code-block'
import '~/app.css'

function contrast(element: Element) {
  const style = getComputedStyle(element)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')!
  const luminance = (color: string) => {
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const rgba = context.getImageData(0, 0, 1, 1).data
    const rgb = [rgba[0], rgba[1], rgba[2]].map((value) => {
      const c = value / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
  }
  const background = luminance(style.backgroundColor)
  const foreground = luminance(style.color)
  return (
    (Math.max(foreground, background) + 0.05) /
    (Math.min(foreground, background) + 0.05)
  )
}

test.each(['light', 'dark'])(
  'default Copy foreground meets contrast before and after hover (%s)',
  async (theme) => {
    const previousTheme = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = theme
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () =>
        root.render(
          <TooltipProvider>
            <Button>Control</Button>
            <CopyableCodeBlock
              code="example"
              name="Token"
              labels={{ copy: 'Copy', copied: 'Copied', failed: 'Failed' }}
              copyButtonVariant="default"
            />
          </TooltipProvider>,
        ),
      )
      await waitForBrowserLayout()
      const copy = page.getByRole('button', { name: 'Copy', exact: true })
      const control = page.getByRole('button', { name: 'Control', exact: true })
      expect(contrast(control.element())).toBeGreaterThanOrEqual(4.5)
      expect(contrast(copy.element())).toBeGreaterThanOrEqual(4.5)
      await copy.hover()
      await waitForBrowserLayout()
      await Promise.all(
        copy
          .element()
          .getAnimations()
          .map((animation) => animation.finished),
      )
      expect(contrast(copy.element())).toBeGreaterThanOrEqual(4.5)
      // The original faint foreground must fail the same measurement.
      const original = copy.element().style.color
      copy.element().style.color = getComputedStyle(
        document.documentElement,
      ).getPropertyValue('--faint')
      await waitForBrowserLayout()
      await Promise.all(
        copy
          .element()
          .getAnimations()
          .map((animation) => animation.finished),
      )
      expect(contrast(copy.element())).toBeLessThan(4.5)
      copy.element().style.color = original
    } finally {
      await act(async () => root.unmount())
      container.remove()
      if (previousTheme === undefined)
        delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = previousTheme
    }
  },
)
