import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useState,
  type CSSProperties,
} from 'react'
import { type TextSelectionMessage } from '~/lib/csp-reporter'
import { type PendingTextAnchor } from './viewer-comment-types'

export function useInlinePopoverOutsideDismiss(
  popoverRef: { current: HTMLElement | null },
  enabled: boolean,
  onClose: () => void,
) {
  const closePopover = useEffectEvent(() => {
    onClose()
  })

  useEffect(() => {
    if (!enabled) return
    function onPointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popoverRef.current?.contains(target)) return
      const path = event.composedPath()
      if (path.some(isInlinePopoverPortalElement)) {
        return
      }
      if (hasOpenInlinePopoverMenu(popoverRef.current)) return
      closePopover()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [enabled, popoverRef])
}

function hasOpenInlinePopoverMenu(popover: HTMLElement | null): boolean {
  return Boolean(
    popover?.querySelector(
      '[data-slot="dropdown-menu-trigger"][data-state="open"]',
    ),
  )
}

function isInlinePopoverPortalElement(target: EventTarget): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(
    target.closest(
      [
        '[data-radix-popper-content-wrapper]',
        '[data-slot="dropdown-menu-content"]',
        '[data-slot="alert-dialog-content"]',
        '[data-slot="alert-dialog-overlay"]',
      ].join(', '),
    ),
  )
}

export function useInlinePopoverPosition(
  popoverRef: { current: HTMLElement | null },
  rect: TextSelectionMessage['rect'] | null,
  width: number,
  enabled: boolean,
) {
  const [style, setStyle] = useState<CSSProperties>(() =>
    rect ? popoverStyle(rect, width, null) : {},
  )

  useLayoutEffect(() => {
    if (!enabled || !rect) return
    const anchorRect = rect

    function updatePosition() {
      setStyle(
        popoverStyle(
          anchorRect,
          width,
          popoverRef.current?.getBoundingClientRect().height ?? null,
        ),
      )
    }

    updatePosition()
    const frameId = window.requestAnimationFrame(updatePosition)
    window.addEventListener('resize', updatePosition)
    return () => {
      window.cancelAnimationFrame(frameId)
      window.removeEventListener('resize', updatePosition)
    }
  }, [enabled, popoverRef, rect, width])

  return style
}

// 選択しただけではフォーカスを奪わず (= iframe 内の選択が残り Cmd+C が通る)、
// このチップを押して初めてコメント入力を開く。textarea へ focus するのは
// 入力を開いた後だけにする。
function popoverStyle(
  rect: TextSelectionMessage['rect'],
  width: number,
  measuredHeight: number | null,
): CSSProperties {
  const arrowSize = 12
  const gap = 12
  const margin = 12
  const preferredArrowLeft = 48
  const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth
  const viewportHeight =
    typeof window === 'undefined' ? 900 : window.innerHeight
  const height = measuredHeight ?? 320
  const anchorCenter = rect.left + rect.width / 2
  const left = Math.max(
    margin,
    Math.min(
      viewportWidth - width - margin,
      anchorCenter - preferredArrowLeft - arrowSize / 2,
    ),
  )
  const arrowLeft = Math.max(
    18,
    Math.min(width - 18, anchorCenter - left - arrowSize / 2),
  )
  const belowTop = rect.top + rect.height + gap
  const aboveTop = rect.top - gap - height
  const spaceBelow = viewportHeight - belowTop - margin
  const spaceAbove = rect.top - gap - margin
  const side =
    spaceBelow >= height || spaceBelow >= spaceAbove ? 'below' : 'above'
  const top =
    side === 'below'
      ? Math.min(belowTop, viewportHeight - height - margin)
      : Math.max(margin, aboveTop)
  return {
    top,
    left,
    '--as-popover-arrow-left': `${arrowLeft}px`,
    '--as-popover-arrow-top': side === 'below' ? '-7px' : 'auto',
    '--as-popover-arrow-bottom': side === 'below' ? 'auto' : '-7px',
    '--as-popover-arrow-transform':
      side === 'below' ? 'rotate(45deg)' : 'rotate(225deg)',
  } as CSSProperties
}

export function withoutRect(anchor: PendingTextAnchor) {
  return {
    quotedText: anchor.quotedText,
    prefixText: anchor.prefixText,
    suffixText: anchor.suffixText,
    textStart: anchor.textStart,
    textEnd: anchor.textEnd,
    cssPath: anchor.cssPath,
  }
}

export function pendingAnchorKey(anchor: PendingTextAnchor): string {
  return `${anchor.textStart}:${anchor.textEnd}:${anchor.quotedText}`
}
