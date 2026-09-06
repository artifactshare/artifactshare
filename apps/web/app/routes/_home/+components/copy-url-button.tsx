import { IconButton } from '~/components/app/icon-button'
import { useT } from '~/hooks/use-t'
import { copyShareUrl } from '~/lib/clipboard'
import { buildShareableUrl } from '~/lib/share-url'
import { IconCopy } from '@tabler/icons-react'
import type { Visibility } from '~/lib/shareable-types'

export interface CopyUrlButtonProps {
  shareableId: string
  visibility: Visibility
  className?: string
}

export function CopyUrlButton({
  shareableId,
  visibility,
  className,
}: CopyUrlButtonProps) {
  const translator = useT()
  const { t } = translator
  return (
    <IconButton
      type="button"
      icon={IconCopy}
      size="sm"
      className={className}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void copyShareableUrl(shareableId, visibility, translator)
      }}
      aria-label={t('vw.copyUrl')}
      title={t('vw.copyUrl')}
    />
  )
}

export function copyShareableUrl(
  shareableId: string,
  visibility: Visibility,
  translator: ReturnType<typeof useT>,
) {
  return copyShareUrl(buildShareableUrl(shareableId, visibility), translator)
}
