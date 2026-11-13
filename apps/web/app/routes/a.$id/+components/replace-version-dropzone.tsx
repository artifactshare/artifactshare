import { IconLoader, IconUpload as UploadIcon } from '@tabler/icons-react'
import { useCallback, useRef, type RefObject } from 'react'
import { toast } from 'sonner'
import { cn } from '~/lib/utils'
import { useT } from '~/hooks/use-t'
import { configureDirectoryInput } from '~/lib/directory-input'
import {
  ACCEPTED_FILE_UPLOAD_TYPES,
  ACCEPTED_SITE_UPLOAD_TYPES,
} from '~/lib/upload-artifact-validation'
import { filesFromDrop } from '~/lib/upload-drop-items'
import { hasLocalFiles } from './drag-files'

export function ReplaceVersionDropzone({
  className,
  compactOnMobile = false,
  active,
  uploading,
  inputRef,
  replaceMode,
  setLocalDropActive,
  submitFiles,
  t,
}: {
  className: string
  compactOnMobile?: boolean
  active: boolean
  uploading: boolean
  inputRef: RefObject<HTMLInputElement | null>
  replaceMode: 'single' | 'static_site'
  setLocalDropActive: (active: boolean) => void
  submitFiles: (files: FileList | File[] | null) => void
  t: ReturnType<typeof useT>['t']
}) {
  const directoryInputRef = useRef<HTMLInputElement>(null)
  const setDirectoryInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      directoryInputRef.current = element
      configureDirectoryInput(element)
    },
    [],
  )

  return (
    <div className={className}>
      {uploading ? (
        <div
          className={cn(
            'bg-muted text-muted-foreground border-border flex w-full cursor-default flex-col items-center gap-1 rounded-[var(--r-lg)] border-2 border-solid p-4',
            compactOnMobile &&
              'max-sheet:flex-row max-sheet:flex-wrap max-sheet:justify-center max-sheet:gap-2 max-sheet:p-2',
          )}
          data-panel-dropzone=""
          aria-live="polite"
          aria-busy="true"
        >
          <IconLoader
            className={cn(
              'size-icon-dropzone text-link animate-spin [animation-duration:var(--anim-spin-duration)]',
              compactOnMobile && 'max-sheet:size-4',
            )}
            aria-hidden="true"
          />
          <span className="text-sm font-semibold">
            {t('history.uploadingTitle')}
          </span>
          <small className="text-muted-foreground text-xs">
            {t('history.uploadingCaption')}
          </small>
        </div>
      ) : (
        <DropzoneButton
          compactOnMobile={compactOnMobile}
          active={active}
          inputRef={inputRef}
          replaceMode={replaceMode}
          setLocalDropActive={setLocalDropActive}
          submitFiles={submitFiles}
          t={t}
        />
      )}
      <input
        ref={inputRef}
        className="hidden"
        type="file"
        accept={
          replaceMode === 'static_site'
            ? ACCEPTED_SITE_UPLOAD_TYPES
            : ACCEPTED_FILE_UPLOAD_TYPES
        }
        multiple={replaceMode === 'static_site'}
        aria-label={t('history.pickFile')}
        disabled={uploading}
        onChange={(event) => {
          submitFiles(event.currentTarget.files)
          event.currentTarget.value = ''
        }}
      />
      {replaceMode === 'static_site' ? (
        <>
          <input
            ref={setDirectoryInputRef}
            className="hidden"
            type="file"
            accept={ACCEPTED_SITE_UPLOAD_TYPES}
            multiple
            aria-label={t('upload.pick.folder')}
            disabled={uploading}
            onChange={(event) => {
              submitFiles(event.currentTarget.files)
              event.currentTarget.value = ''
            }}
          />
          <button
            type="button"
            className="bg-background text-foreground hover:bg-muted min-h-replace-button border-border hover:border-border-strong mt-2 w-full cursor-pointer rounded-[var(--r-sm)] border text-sm font-semibold disabled:cursor-default disabled:opacity-60"
            disabled={uploading}
            onClick={() => directoryInputRef.current?.click()}
          >
            {t('upload.pick.folder')}
          </button>
        </>
      ) : null}
    </div>
  )
}

function DropzoneButton({
  compactOnMobile = false,
  active,
  inputRef,
  replaceMode,
  setLocalDropActive,
  submitFiles,
  t,
}: {
  compactOnMobile?: boolean
  active: boolean
  inputRef: RefObject<HTMLInputElement | null>
  replaceMode: 'single' | 'static_site'
  setLocalDropActive: (active: boolean) => void
  submitFiles: (files: FileList | File[] | null) => void
  t: ReturnType<typeof useT>['t']
}) {
  return (
    <button
      type="button"
      className={cn(
        'text-foreground flex w-full cursor-pointer flex-col items-center gap-1 rounded-[var(--r-lg)] border-2 border-dashed p-4 transition-[border-color,background] duration-100',
        compactOnMobile &&
          'max-sheet:flex-row max-sheet:justify-center max-sheet:gap-2 max-sheet:p-2',
        active ? 'border-link bg-link-soft' : 'bg-muted border-border-strong',
      )}
      data-panel-dropzone=""
      onClick={() => inputRef.current?.click()}
      onDragEnter={(event) => {
        if (!hasLocalFiles(event.dataTransfer)) return
        event.preventDefault()
        setLocalDropActive(true)
      }}
      onDragOver={(event) => {
        if (!hasLocalFiles(event.dataTransfer)) return
        event.preventDefault()
        setLocalDropActive(true)
      }}
      onDragLeave={() => setLocalDropActive(false)}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setLocalDropActive(false)
        if (replaceMode === 'static_site') {
          const fallbackFiles = Array.from(event.dataTransfer.files)
          void filesFromDrop(event.dataTransfer)
            .then(submitFiles, () =>
              fallbackFiles.length > 0
                ? submitFiles(fallbackFiles)
                : toast.error(t('upload.error.dropReadFailed')),
            )
            .catch(() => toast.error(t('upload.error.dropReadFailed')))
        } else {
          submitFiles(event.dataTransfer.files)
        }
      }}
    >
      <UploadIcon
        className={cn(
          'size-icon-dropzone text-link',
          compactOnMobile && 'max-sheet:size-4',
        )}
        aria-hidden="true"
      />
      <span
        className={cn(
          'text-sm font-semibold',
          compactOnMobile && 'max-sheet:hidden',
        )}
      >
        {t('history.dropTitle')}
      </span>
      <small
        className={cn(
          'text-muted-foreground text-xs',
          compactOnMobile && 'max-sheet:hidden',
        )}
      >
        {t('history.dropCaption')}
      </small>
      <span
        className={cn(
          'bg-foreground text-background mt-1.5 rounded-[var(--r-sm)] px-3 py-1.5 text-sm font-medium',
          compactOnMobile && 'max-sheet:mt-0',
        )}
      >
        {t('history.pickFile')}
      </span>
    </button>
  )
}
