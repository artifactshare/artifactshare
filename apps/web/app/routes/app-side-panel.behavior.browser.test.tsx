import { useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '~/app.css'
import {
  AppSidePanel,
  type SidePanelTopbar,
} from '~/components/app/app-side-panel'
import { SheetTitle } from '~/components/ui/sheet'
import { HistoryPanel } from '~/routes/a.$id/+components/history-panel'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { waitForBrowserLayout } from '~/test/browser-layout'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ locale: 'en', t: (key: string) => key }),
}))

function Harness({ topbar }: { topbar: SidePanelTopbar }) {
  const [open, setOpen] = useState(true)
  const [actionCount, setActionCount] = useState(0)

  return (
    <>
      {topbar !== 'none' ? (
        <header
          id={topbar === 'viewer' ? 'viewer-topbar' : 'test-topbar'}
          className={
            topbar === 'viewer'
              ? 'bg-background min-h-topbar-expanded flex items-center'
              : 'bg-background flex h-12 items-center'
          }
        >
          <button type="button" onClick={() => setActionCount((n) => n + 1)}>
            Header action {actionCount}
          </button>
        </header>
      ) : null}
      <AppSidePanel
        open={open}
        onOpenChange={setOpen}
        topbar={topbar}
        aria-describedby={undefined}
      >
        <SheetTitle>App panel</SheetTitle>
        <button type="button">Panel action</button>
      </AppSidePanel>
    </>
  )
}

describe('app side panel browser behavior', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    container.remove()
  })

  async function renderHarness(topbar: SidePanelTopbar) {
    root.render(<Harness topbar={topbar} />)
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-slot="sheet-content"]'),
      ).not.toBeNull()
    })
    await waitForBrowserLayout()
  }

  it.each(['app', 'viewer'] as const)(
    'starts below the %s topbar and keeps header controls operable',
    async (topbarKind) => {
      await page.viewport(1280, 800)
      await renderHarness(topbarKind)

      const topbar = document.querySelector<HTMLElement>('header')!
      const panel = document.querySelector<HTMLElement>(
        '[data-slot="sheet-content"]',
      )!
      const action = topbar.querySelector<HTMLButtonElement>('button')!

      expect(panel.getBoundingClientRect().top).toBe(
        topbar.getBoundingClientRect().bottom,
      )
      expect(panel.getBoundingClientRect().bottom).toBe(800)
      expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull()

      action.focus()
      action.click()
      await vi.waitFor(() => {
        expect(action.textContent).toBe('Header action 1')
      })
      expect(document.activeElement).toBe(action)
      expect(document.querySelector('[data-slot="sheet-content"]')).toBe(panel)

      const panelAction = panel.querySelector<HTMLButtonElement>('button')!
      panelAction.focus()
      await userEvent.keyboard('{Tab}')
      expect(document.activeElement).toBe(action)

      await userEvent.keyboard('{Escape}')
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull()
      })
    },
  )

  it('tracks a viewer topbar that grows while the panel is open', async () => {
    await page.viewport(1280, 800)
    await renderHarness('viewer')

    const topbar = document.querySelector<HTMLElement>('#viewer-topbar')!
    topbar.style.height = '80px'
    await vi.waitFor(() => {
      expect(
        document
          .querySelector<HTMLElement>('[data-slot="sheet-content"]')!
          .getBoundingClientRect().top,
      ).toBe(80)
    })

    await userEvent.keyboard('{Escape}')
    const exitingPanel = document.querySelector<HTMLElement>(
      '[data-slot="sheet-content"]',
    )
    expect(exitingPanel).not.toBeNull()
    expect(exitingPanel?.getBoundingClientRect().top).toBe(80)
  })

  it('restores History focus after a menu trigger tries to reclaim it', async () => {
    await page.viewport(1280, 800)

    function HistoryHarness() {
      const [open, setOpen] = useState(false)
      const historyOpeningRef = useRef(false)
      return (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
            <DropdownMenuContent
              onCloseAutoFocus={(event) => {
                if (!historyOpeningRef.current) return
                historyOpeningRef.current = false
                event.preventDefault()
              }}
            >
              <DropdownMenuItem
                onSelect={() => {
                  historyOpeningRef.current = true
                  setOpen(true)
                }}
              >
                History
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <HistoryPanel
            open={open}
            onOpenChange={setOpen}
            versions={[]}
            topbarCollapsed
          />
        </>
      )
    }

    root.render(<HistoryHarness />)
    await page.getByRole('button', { name: 'Open menu' }).click()
    await page.getByRole('menuitem', { name: 'History' }).click()
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        document.querySelector<HTMLButtonElement>(
          '[data-slot="sheet-content"] button',
        ),
      )
    })
  })

  it('uses the full-height edge without a topbar', async () => {
    await page.viewport(1280, 800)
    await renderHarness('none')

    const panel = document.querySelector<HTMLElement>(
      '[data-slot="sheet-content"]',
    )!
    expect(panel.getBoundingClientRect().top).toBe(0)
    expect(panel.getBoundingClientRect().bottom).toBe(800)
  })

  it('keeps the existing bottom sheet presentation on phone', async () => {
    await page.viewport(390, 844)
    await renderHarness('viewer')

    const panel = document.querySelector<HTMLElement>(
      '[data-slot="sheet-content"]',
    )!
    await vi.waitFor(() => {
      expect(panel.getBoundingClientRect().left).toBe(10)
      expect(panel.getBoundingClientRect().bottom).toBe(844)
    })
    const rect = panel.getBoundingClientRect()
    expect(rect.left).toBe(10)
    expect(rect.right).toBe(380)
    expect(rect.bottom).toBe(844)
    expect(rect.top).toBeGreaterThan(0)
    expect(
      getComputedStyle(panel).getPropertyValue('--tw-enter-translate-x').trim(),
    ).toBe('calc(0*100%)')
  })
})
