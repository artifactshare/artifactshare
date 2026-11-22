import { useEffect } from 'react'
import { useFetcher } from 'react-router'
import { useT } from '~/hooks/use-t'
import type { action } from '../tokens'
import { ConfirmActionDialog } from './confirm-action-dialog'
import { SettingsBanner } from './settings-banner'

export type RevokeTarget =
  | { intent: 'revoke'; tokenId: string; name: string }
  | { intent: 'revoke-cli-family'; familyId: string; name: string }
  | { intent: 'revoke-all-cli-families' }

export function RevokeDialog({
  target,
  onClose,
  onAlreadyRevoked,
  returnFocusId,
  fallbackFocusId,
}: {
  target: RevokeTarget
  onClose: () => void
  onAlreadyRevoked?: () => void
  fallbackFocusId: string
  returnFocusId: string
}) {
  const { t } = useT()
  const fetcher = useFetcher<typeof action>()
  const result = fetcher.state === 'idle' ? fetcher.data?.kind : undefined
  useEffect(() => {
    if (result === 'cli-revoke-noop') onAlreadyRevoked?.()
    if (result === 'revoked' || result === 'cli-revoke-noop') onClose()
  }, [result, onAlreadyRevoked, onClose])
  const all = target.intent === 'revoke-all-cli-families'
  const unavailable = result === 'revoke-unavailable'
  let actionLabel: string | null = t(
    all ? 'team.tokens.cli.revokeAllConfirm.action' : 'team.tokens.revoke',
  )
  let banner
  if (unavailable) {
    actionLabel = null
    banner = (
      <SettingsBanner kind="warning" urgent>
        {t('team.tokens.revoke.unavailable')}
      </SettingsBanner>
    )
  } else if (result === 'revoke-failed') {
    actionLabel = t('dialog.retry')
    banner = (
      <SettingsBanner kind="error">
        {t('team.tokens.revoke.failed')}
      </SettingsBanner>
    )
  }
  return (
    <ConfirmActionDialog
      open
      destructive
      awaitResult
      fallbackFocusId={fallbackFocusId}
      returnFocusId={returnFocusId}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      contentClassName="max-h-dvh overflow-y-auto [overflow-wrap:anywhere]"
      title={
        all
          ? t('team.tokens.cli.revokeAllConfirm.title')
          : t('team.tokens.revoke.title', { name: target.name })
      }
      description={
        all
          ? t('team.tokens.cli.revokeAllConfirm.body')
          : target.intent === 'revoke'
            ? t('team.tokens.revoke.body', { name: target.name })
            : t('team.tokens.cli.revoke.body')
      }
      dismissLabel={unavailable ? t('common.close') : undefined}
      action={actionLabel}
      pendingLabel={t('team.tokens.revoke.pending')}
      pending={fetcher.state !== 'idle'}
      result={banner}
      onConfirm={() => {
        const form = new FormData()
        form.set('intent', target.intent)
        if (target.intent === 'revoke') form.set('tokenId', target.tokenId)
        if (target.intent === 'revoke-cli-family')
          form.set('familyId', target.familyId)
        void fetcher.submit(form, {
          method: 'post',
          action: '/settings/tokens',
        })
      }}
    />
  )
}
