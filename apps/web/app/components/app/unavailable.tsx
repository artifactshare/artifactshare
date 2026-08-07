import { Link } from 'react-router'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import type { UserInfo } from '~/lib/user'
import { BrokenFileIcon } from './broken-file-icon'
import { ViewerErrorShell } from './viewer-error-shell'

export type UnavailableReason =
  | 'missing'
  | 'too-large'
  | 'open-error'
  | 'copy-forbidden'
  | 'quota-exceeded'
  | 'storage-failed'
  | 'unsupported-mime'
  | 'not-registered'

interface UnavailableProps {
  user: UserInfo | null
  reason: UnavailableReason
}

const MESSAGES = {
  missing: { title: 'unavailable.title', body: 'unavailable.body' },
  'too-large': { title: 'tooLarge.title', body: 'tooLarge.body' },
  'open-error': { title: 'openErr.title', body: 'openErr.body' },
  'copy-forbidden': {
    title: 'storageOpen.title',
    body: 'upload.error.copyForbidden',
  },
  'quota-exceeded': {
    title: 'storageOpen.title',
    body: 'upload.error.quotaExceeded',
  },
  'storage-failed': {
    title: 'storageOpen.title',
    body: 'upload.error.storageFailed',
  },
  'unsupported-mime': { title: 'unsupported.title', body: 'unsupported.body' },
  'not-registered': {
    title: 'storageOpen.title',
    body: 'storageOpen.notRegistered',
  },
} as const

export function Unavailable({ user, reason }: UnavailableProps) {
  const { t } = useT()
  const { title: titleKey, body: bodyKey } = MESSAGES[reason]

  return (
    <ViewerErrorShell
      user={user}
      icon={<BrokenFileIcon />}
      title={t(titleKey)}
      body={t(bodyKey)}
      actions={
        <Button asChild>
          <Link to="/">{t('unavailable.back')}</Link>
        </Button>
      }
    />
  )
}
