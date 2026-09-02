import {
  type ComponentProps,
  type KeyboardEvent,
  useLayoutEffect,
  useState,
} from 'react'
import { Sheet, SheetContent } from '~/components/ui/sheet'
import { cn } from '~/lib/utils'

export type SidePanelTopbar = 'app' | 'viewer' | 'none'

type AppSidePanelProps = Omit<
  ComponentProps<typeof SheetContent>,
  'onInteractOutside' | 'showOverlay'
> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  topbar: SidePanelTopbar
}

export function AppSidePanel({
  open,
  onOpenChange,
  topbar,
  className,
  onKeyDown,
  style,
  ...props
}: AppSidePanelProps) {
  const [viewerTop, setViewerTop] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (topbar !== 'viewer') {
      setViewerTop(null)
      return
    }
    if (!open) return
    const topbarElement = document.getElementById('viewer-topbar')
    if (!topbarElement) return
    const update = () => {
      const sheetBreakpoint = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          '--breakpoint-sheet',
        ),
      )
      setViewerTop(
        window.innerWidth >= sheetBreakpoint
          ? topbarElement.getBoundingClientRect().bottom
          : null,
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(topbarElement)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [open, topbar])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.key !== 'Tab' || topbar === 'none')
      return

    const panelItems = focusableElements(event.currentTarget)
    const activeElement = document.activeElement
    const leavingBackward = event.shiftKey && activeElement === panelItems[0]
    const leavingForward =
      !event.shiftKey && activeElement === panelItems.at(-1)
    if (!leavingBackward && !leavingForward) return

    const topbarElement =
      topbar === 'viewer'
        ? document.getElementById('viewer-topbar')
        : document.querySelector<HTMLElement>('header')
    if (!topbarElement) return
    const topbarItems = focusableElements(topbarElement)
    const target = leavingBackward ? topbarItems.at(-1) : topbarItems[0]
    if (!target) return
    event.preventDefault()
    target.focus()
  }

  return (
    <Sheet modal={false} open={open} onOpenChange={onOpenChange}>
      <SheetContent
        showOverlay={false}
        onInteractOutside={(event) => event.preventDefault()}
        onKeyDown={handleKeyDown}
        style={{ ...style, top: viewerTop ?? style?.top }}
        className={cn(
          'max-sheet:data-open:slide-in-from-right-0 max-sheet:data-open:slide-in-from-bottom max-sheet:data-closed:slide-out-to-right-0 max-sheet:data-closed:slide-out-to-bottom max-sheet:inset-x-2.5 max-sheet:top-auto max-sheet:bottom-0 max-sheet:h-[var(--height-comment-panel-sheet)] max-sheet:w-auto max-sheet:max-w-none max-sheet:rounded-t-[var(--r-lg)] max-sheet:border-t-divider max-sheet:border-r-divider max-sheet:border-l-divider gap-0',
          topbar === 'app' && 'sheet:top-12 sheet:h-auto',
          topbar === 'viewer' && 'sheet:top-topbar-expanded sheet:h-auto',
          className,
        )}
        {...props}
      />
    </Sheet>
  )
}

const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(focusableSelector),
  ).filter((element) => element.getClientRects().length > 0)
}
