import { IconInfoCircle } from '@tabler/icons-react'
import { useState, useSyncExternalStore } from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { Button } from '~/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '~/components/ui/sheet'
import { useT } from '~/hooks/use-t'
import { LinkReportDialog } from './link-report-dialog'

// Mirrors --breakpoint-phone in app.css; the phone layout gets a bottom sheet
// instead of a popover.
const PHONE_QUERY = '(max-width: 519.98px)'

function subscribePhone(onChange: () => void) {
  const media = window.matchMedia(PHONE_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  )
}

/**
 * Small ⓘ next to the author of a link-shared page. Opening it explains that
 * the page was published by an Artifact Share user and offers the report
 * action; nothing is shown until the viewer asks.
 */
export function LinkOriginInfo({ shareableId }: { shareableId: string }) {
  const { t } = useT()
  const isPhone = useIsPhone()
  const [open, setOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)

  const trigger = (
    <button
      type="button"
      data-link-origin-trigger
      className="hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-transparent bg-transparent text-inherit outline-none focus-visible:ring-3"
      aria-label={t('vw.linkOrigin.open')}
    >
      <IconInfoCircle size={14} aria-hidden="true" />
    </button>
  )
  const body = (
    <>
      <p className="text-sm leading-snug">{t('vw.linkSafety.disclaimer')}</p>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        data-link-report-trigger
        onClick={() => {
          setOpen(false)
          setReportOpen(true)
        }}
      >
        {t('vw.linkSafety.report')}
      </Button>
    </>
  )

  return (
    <>
      {isPhone ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>{trigger}</SheetTrigger>
          <SheetContent side="bottom" className="gap-3">
            <SheetHeader className="p-0">
              <SheetTitle>{t('vw.linkOrigin.title')}</SheetTitle>
              <SheetDescription className="sr-only">
                {t('vw.linkSafety.disclaimer')}
              </SheetDescription>
            </SheetHeader>
            {body}
          </SheetContent>
        </Sheet>
      ) : (
        <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
          <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
              align="start"
              sideOffset={6}
              collisionPadding={8}
              aria-label={t('vw.linkOrigin.title')}
              className="bg-popover text-popover-foreground ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 z-50 flex w-[var(--width-viewer-attribution-popover)] origin-(--radix-popover-content-transform-origin) flex-col gap-3 rounded-[var(--r-md)] p-3 shadow-md ring-1 outline-none"
            >
              {body}
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      )}
      <LinkReportDialog
        shareableId={shareableId}
        open={reportOpen}
        onOpenChange={setReportOpen}
      />
    </>
  )
}
