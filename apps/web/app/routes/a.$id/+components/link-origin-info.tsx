import { IconInfoCircle } from '@tabler/icons-react'
import { useRef, useState } from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { Button } from '~/components/ui/button'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '~/components/ui/sheet'
import { useMediaQuery } from '~/hooks/use-media-query'
import { useT } from '~/hooks/use-t'
import { LinkReportDialog } from './link-report-dialog'

// The edge below --breakpoint-phone in app/styles/theme.css. A media query
// cannot read a custom property, so the number is written out here;
// scripts/check-design-tokens.mjs fails if it stops sitting below that
// breakpoint.
const PHONE_QUERY = '(max-width: 519.98px)'

export function LinkOriginInfo({ shareableId }: { shareableId: string }) {
  const { t } = useT()
  const isPhone = useMediaQuery(PHONE_QUERY)
  const [open, setOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      data-link-origin-trigger
      className="max-phone:size-touch-target hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-transparent bg-transparent text-inherit outline-none focus-visible:ring-3"
      aria-label={t('vw.linkOrigin.open')}
    >
      <IconInfoCircle size={14} aria-hidden="true" />
    </button>
  )
  const reportButton = (className?: string) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      data-link-report-trigger
      onClick={() => {
        setOpen(false)
        setReportOpen(true)
      }}
    >
      {t('vw.linkSafety.report')}
    </Button>
  )

  return (
    <>
      {isPhone ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>{trigger}</SheetTrigger>
          <SheetContent
            side="bottom"
            className="gap-3 p-4"
            onCloseAutoFocus={(event) => {
              if (reportOpen) event.preventDefault()
            }}
          >
            <SheetHeader className="border-0 p-0">
              <SheetTitle>{t('vw.linkOrigin.title')}</SheetTitle>
            </SheetHeader>
            <SheetDescription className="text-foreground text-sm leading-snug">
              {t('vw.linkSafety.disclaimer')}
            </SheetDescription>
            <div className="flex items-center justify-between gap-3">
              {reportButton()}
              <SheetClose asChild>
                <Button variant="ghost" size="sm">
                  {t('vw.linkSafety.close')}
                </Button>
              </SheetClose>
            </div>
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
              onCloseAutoFocus={(event) => {
                if (reportOpen) event.preventDefault()
              }}
              className="bg-popover text-popover-foreground ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 z-50 flex w-[var(--width-viewer-attribution-popover)] origin-(--radix-popover-content-transform-origin) flex-col gap-3 rounded-[var(--r-md)] p-3 shadow-md ring-1 outline-none"
            >
              <p className="text-sm leading-snug">
                {t('vw.linkSafety.disclaimer')}
              </p>
              {reportButton('self-start')}
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      )}
      <LinkReportDialog
        shareableId={shareableId}
        open={reportOpen}
        onOpenChange={setReportOpen}
        returnFocusTo={triggerRef}
      />
    </>
  )
}
