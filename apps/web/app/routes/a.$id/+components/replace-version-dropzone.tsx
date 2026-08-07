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
  active,
  uploading,
  inputRef,
  replaceMode,
  setLocalDropActive,
  submitFiles,
  t,
}: {
  className: string
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
          className="bg-muted text-muted-foreground border-border flex w-full cursor-default flex-col items-center gap-1 rounded-[var(--r-lg)] border-2 border-solid p-4"
          data-panel-dropzone=""
          aria-live="polite"
          aria-busy="true"
        >
          <IconLoader
            className="size-icon-dropzone text-link animate-spin [animation-duration:var(--anim-spin-duration)]"
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
  active,
  inputRef,
  replaceMode,
  setLocalDropActive,
  submitFiles,
  t,
}: {
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
          void filesFromDrop(event.dataTransfer).then(submitFiles, () =>
            fallbackFiles.length > 0
              ? submitFiles(fallbackFiles)
              : toast.error(t('upload.error.dropReadFailed')),
          )
        } else {
          submitFiles(event.dataTransfer.files)
        }
      }}
    >
      <UploadIcon className="size-icon-dropzone text-link" aria-hidden="true" />
      <span className="text-sm font-semibold">{t('history.dropTitle')}</span>
      <small className="text-muted-foreground text-xs">
        {t('history.dropCaption')}
      </small>
      <span className="bg-foreground text-background mt-1.5 rounded-[var(--r-sm)] px-3 py-1.5 text-sm font-medium">
        {t('history.pickFile')}
      </span>
    </button>
  )
}
