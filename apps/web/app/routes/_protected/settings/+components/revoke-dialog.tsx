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
}: {
  target: RevokeTarget
  onClose: () => void
  onAlreadyRevoked?: () => void
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
  const failed = result === 'revoke-failed' || result === 'revoke-unavailable'
  return (
    <ConfirmActionDialog
      open
      destructive
      awaitResult
      returnFocusId={returnFocusId}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={t(
        all ? 'team.tokens.cli.revokeAllConfirm.title' : 'team.tokens.revoke',
      )}
      description={
        all
          ? t('team.tokens.cli.revokeAllConfirm.body')
          : t(
              target.intent === 'revoke'
                ? 'team.tokens.revoke.body'
                : 'team.tokens.cli.revoke.body',
              { name: target.name },
            )
      }
      action={t(
        failed
          ? 'dialog.retry'
          : all
            ? 'team.tokens.cli.revokeAll'
            : 'team.tokens.revoke',
      )}
      pending={fetcher.state !== 'idle'}
      result={
        failed ? (
          <SettingsBanner
            kind={result === 'revoke-unavailable' ? 'warning' : 'error'}
            urgent
          >
            {t(
              result === 'revoke-unavailable'
                ? 'team.tokens.revoke.unavailable'
                : 'team.tokens.revoke.failed',
            )}
          </SettingsBanner>
        ) : undefined
      }
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
