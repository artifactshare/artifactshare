import { IconHistory as HistoryIcon, IconX } from '@tabler/icons-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { Button } from '~/components/ui/button'
import { IconButton } from '~/components/app/icon-button'
import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'
import { ReplaceVersionDropzone } from './replace-version-dropzone'
import type { VersionRow } from './version-history-types'
import { VersionRows } from './version-rows'

export type { VersionRow } from './version-history-types'
export { VersionWidget } from './version-widget'

interface HistoryPanelProps {
  artifactId?: string
  displayedVersionId?: string | null
  versions: ReadonlyArray<VersionRow>
  open: boolean
  onOpenChange: (open: boolean) => void
  canReplaceFile?: boolean
  onSubmit?: (files: File[]) => void
  replaceMode?: 'single' | 'static_site'
  uploading?: boolean
  dropActive?: boolean
  returnFocusRef?: RefObject<HTMLElement | null>
}

export function HistoryPanel({
  artifactId,
  displayedVersionId,
  versions,
  open,
  onOpenChange,
  canReplaceFile = false,
  onSubmit,
  replaceMode = 'single',
  uploading = false,
  dropActive = false,
  returnFocusRef,
}: HistoryPanelProps) {
  const { locale, t } = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const [localDropActive, setLocalDropActive] = useState(false)
  const wasOpenRef = useRef(open)
  const active = dropActive || localDropActive

  useEffect(() => {
    if (wasOpenRef.current && !open) {
      returnFocusRef?.current?.focus()
    }
    wasOpenRef.current = open
  }, [open, returnFocusRef])

  const submitFiles = (files: FileList | File[] | null) => {
    const list = Array.from(files ?? [])
    if (list.length === 0) {
      toast.error(t('upload.error.missingFile'))
      return
    }
    onSubmit?.(list)
  }

  const titleKey = canReplaceFile
    ? 'vw.versionHistory'
    : 'vw.versionHistoryReadonly'

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>
            <HistoryIcon size={16} aria-hidden="true" />
            <span>{t(titleKey)}</span>
          </SheetTitle>
          <SheetClose asChild>
            <IconButton
              type="button"
              icon={IconX}
              size="md"
              aria-label={t('common.close')}
            />
          </SheetClose>
        </SheetHeader>
        <HistoryPanelBody
          versions={versions}
          canReplaceFile={canReplaceFile}
          active={active}
          uploading={uploading}
          inputRef={inputRef}
          replaceMode={replaceMode}
          setLocalDropActive={setLocalDropActive}
          submitFiles={submitFiles}
          locale={locale}
          t={t}
          artifactId={artifactId}
          displayedVersionId={displayedVersionId}
          onVersionSelect={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  )
}

export function HistoryPanelBody({
  versions,
  canReplaceFile,
  active,
  uploading,
  inputRef,
  replaceMode,
  setLocalDropActive,
  submitFiles,
  locale,
  t,
  artifactId,
  displayedVersionId,
  onVersionSelect,
}: {
  versions: ReadonlyArray<VersionRow>
  canReplaceFile: boolean
  active: boolean
  uploading: boolean
  inputRef: RefObject<HTMLInputElement | null>
  replaceMode: 'single' | 'static_site'
  setLocalDropActive: (active: boolean) => void
  submitFiles: (files: FileList | File[] | null) => void
  locale: Parameters<typeof formatRelative>[1]
  t: ReturnType<typeof useT>['t']
  artifactId?: string
  displayedVersionId?: string | null
  onVersionSelect?: () => void
}) {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3.5">
        <VersionRows
          versions={versions}
          locale={locale}
          t={t}
          artifactId={artifactId}
          displayedVersionId={displayedVersionId}
          onVersionSelect={onVersionSelect}
        />
      </div>

      {canReplaceFile ? (
        <ReplaceVersionDropzone
          className="border-divider bg-card border-t p-3.5"
          active={active}
          uploading={uploading}
          inputRef={inputRef}
          replaceMode={replaceMode}
          setLocalDropActive={setLocalDropActive}
          submitFiles={submitFiles}
          t={t}
        />
      ) : null}
    </>
  )
}
