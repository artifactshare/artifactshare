import { IconUpload as UploadIcon } from '@tabler/icons-react'
import { cn } from '~/lib/utils'
import { filesFromDrop } from '~/lib/upload-drop-items'

const uploadDropzoneClassName = cn(
  'flex min-h-48 cursor-pointer flex-col items-center justify-center gap-2',
  'border-border-strong bg-muted text-foreground rounded-[var(--r-md)] border-2 border-dashed',
  'transition-[background,border-color,color] duration-100',
  'hover:border-link hover:text-link hover:bg-[color-mix(in_srgb,var(--link)_8%,var(--muted))]',
  'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none',
  'disabled:cursor-progress disabled:opacity-70',
  '[&>small]:text-muted-foreground [&_svg]:size-7 [&>small]:text-xs [&>span]:text-base [&>span]:font-semibold',
)

interface UploadDropzoneProps {
  dragOver: boolean
  disabled: boolean
  label: string
  help: string
  bundleHelp: string
  onOpenPicker: () => void
  onDragOverChange: (dragOver: boolean) => void
  onFiles: (files: FileList | File[]) => void
  onDropError: () => void
}

export function UploadDropzone({
  dragOver,
  disabled,
  label,
  help,
  bundleHelp,
  onOpenPicker,
  onDragOverChange,
  onFiles,
  onDropError,
}: UploadDropzoneProps) {
  return (
    <button
      type="button"
      className={cn(
        uploadDropzoneClassName,
        dragOver &&
          'border-link text-link bg-[color-mix(in_srgb,var(--link)_8%,var(--muted))]',
      )}
      disabled={disabled}
      onClick={onOpenPicker}
      onDragOver={(event) => {
        event.preventDefault()
        onDragOverChange(true)
      }}
      onDragLeave={() => onDragOverChange(false)}
      onDrop={(event) => {
        event.preventDefault()
        onDragOverChange(false)
        const dataTransfer = event.dataTransfer
        const fallbackFiles = Array.from(dataTransfer.files)
        void filesFromDrop(dataTransfer).then(onFiles, () =>
          fallbackFiles.length > 0 ? onFiles(fallbackFiles) : onDropError(),
        )
      }}
    >
      <UploadIcon aria-hidden="true" />
      <span>{label}</span>
      <small>{help}</small>
      <small>{bundleHelp}</small>
    </button>
  )
}
