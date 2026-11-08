import { useT } from '~/hooks/use-t'
import type { ArtifactType } from '~/lib/artifact-type'
import { cn } from '~/lib/utils'

// Format names are shown as-is; video is labelled by its type, localized.
const LABEL: Record<Exclude<ArtifactType, 'video'>, string> = {
  html: 'HTML',
  md: 'MD',
  pdf: 'PDF',
  static_site: 'Site',
}

interface FileTypeIconProps {
  renderType: ArtifactType | null
  size?: 'md' | 'sm'
}

export function FileTypeIcon({ renderType, size = 'md' }: FileTypeIconProps) {
  const { t } = useT()
  const isSm = size === 'sm'
  const label =
    renderType === 'video'
      ? t('fileType.video')
      : renderType
        ? LABEL[renderType]
        : '—'
  return (
    <span
      className={cn(
        'border-divider bg-muted text-muted-foreground inline-flex shrink-0 items-center justify-center border font-bold select-none',
        isSm ? 'size-5 rounded-[var(--r-sm)]' : 'size-6',
      )}
      style={{
        fontSize: isSm ? '8px' : '9px',
        letterSpacing: '0.02em',
        borderRadius: isSm ? undefined : '4px',
      }}
      aria-hidden="true"
    >
      {label}
    </span>
  )
}
