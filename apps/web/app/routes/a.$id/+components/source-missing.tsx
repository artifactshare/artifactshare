import { useState } from 'react'
import { Button } from '~/components/ui/button'
import { Stack } from '~/components/layout/stack'
import { useRemoveArtifact } from '../+hooks/use-remove-artifact'
import { useT } from '~/hooks/use-t'
import type { UserInfo } from '~/lib/user'
import { BrokenFileIcon } from '~/components/app/broken-file-icon'
import { RemoveConfirmDialog } from './remove-confirm-dialog'
import { ViewerErrorShell } from '~/components/app/viewer-error-shell'

interface SourceMissingProps {
  user: UserInfo
  artifact: { id: string }
}

export function SourceMissing({ user, artifact }: SourceMissingProps) {
  const { t } = useT()
  const remove = useRemoveArtifact(artifact.id)
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <>
      <ViewerErrorShell
        user={user}
        icon={<BrokenFileIcon />}
        title={t('sourceMissing.title')}
        body={
          <Stack gap="3">
            <p>{t('sourceMissing.body')}</p>
            <p className="text-faint text-sm">{t('sourceMissing.note')}</p>
          </Stack>
        }
        actions={
          <Button type="button" onClick={() => setConfirmOpen(true)}>
            {t('sourceMissing.remove')}
          </Button>
        }
      />

      <RemoveConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={remove}
      />
    </>
  )
}
