import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { page } from 'vitest/browser'
import { IconCheck, IconCopy } from '@tabler/icons-react'
import { waitForBrowserLayout } from '~/test/browser-layout'
import { TooltipProvider } from '~/components/ui/tooltip'
import { Button } from '~/components/ui/button'
import { IconButton } from '~/components/app/icon-button'
import { CopyableCodeBlock } from '~/components/app/copyable-code-block'
import '~/app.css'

function iconBox(name: string) {
  const svg = page
    .getByRole('button', { name, exact: true })
    .element()
    .querySelector('svg')!
  const box = svg.getBoundingClientRect()
  return { width: Math.round(box.width), height: Math.round(box.height) }
}

// The icon box each button renders today. A button that wants its icon's own
// attribute size must keep it, and a button that says nothing must keep the
// 16px the base variant imposes.
test('buttons keep their rendered icon sizes', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Button>
            <IconCopy aria-hidden="true" size={15} />
            <span>Imposed</span>
          </Button>
          <Button size="sm">
            <IconCopy aria-hidden="true" size={15} />
            <span>Imposed small</span>
          </Button>
          <IconButton aria-label="Small" icon={IconCopy} size="sm" />
          <IconButton aria-label="Medium" icon={IconCopy} size="md" />
          <CopyableCodeBlock
            code="example"
            name="Token"
            labels={{ copy: 'Copy', copied: 'Copied', failed: 'Failed' }}
          />
        </TooltipProvider>,
      ),
    )
    await waitForBrowserLayout()

    expect(iconBox('Imposed')).toEqual({ width: 16, height: 16 })
    expect(iconBox('Imposed small')).toEqual({ width: 14, height: 14 })
    expect(iconBox('Small')).toEqual({ width: 14, height: 14 })
    expect(iconBox('Medium')).toEqual({ width: 15, height: 15 })
    expect(iconBox('Copy')).toEqual({ width: 15, height: 15 })
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

// The copied branch of CopyableCodeBlock, which carries a colour class on the
// icon. A size escape hatch must not depend on the icon carrying no class.
test('an icon with a colour class keeps its own size', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Button aria-label="Copied" iconSize="auto">
            <IconCheck
              aria-hidden="true"
              className="text-success"
              size={15}
              strokeWidth={2.4}
            />
            <span>Copied</span>
          </Button>
        </TooltipProvider>,
      ),
    )
    await waitForBrowserLayout()

    expect(iconBox('Copied')).toEqual({ width: 15, height: 15 })
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
