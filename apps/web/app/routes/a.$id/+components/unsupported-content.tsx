import { useT } from '~/hooks/use-t'
import { DeniedPanel } from '~/components/app/denied-panel'
import { BrokenFileIcon } from '~/components/app/broken-file-icon'

export function UnsupportedContent() {
  const { t } = useT()
  return (
    <div className="bg-surface-warm relative min-h-0 flex-auto overflow-hidden overscroll-none">
      <DeniedPanel
        icon={<BrokenFileIcon />}
        title={t('unsupported.title')}
        body={t('unsupported.body')}
      />
    </div>
  )
}
