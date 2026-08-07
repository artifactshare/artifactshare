import type { ArtifactType } from '~/lib/artifact-type'
import { cn } from '~/lib/utils'

const LABEL: Record<ArtifactType, string> = {
  html: 'HTML',
  md: 'MD',
  static_site: 'Site',
}

interface FileTypeIconProps {
  renderType: ArtifactType | null
  size?: 'md' | 'sm'
}

export function FileTypeIcon({ renderType, size = 'md' }: FileTypeIconProps) {
  const isSm = size === 'sm'
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
      {renderType ? LABEL[renderType] : '—'}
    </span>
  )
}
