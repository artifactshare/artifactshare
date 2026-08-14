import { useState } from 'react'
import { Button } from '~/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Textarea } from '~/components/ui/textarea'
import { useT } from '~/hooks/use-t'

export type UpgradeRequestView = {
  limit_type: 'storage' | 'projects'
  current_plan: 'free' | 'plus'
  recommended_plan: 'plus' | 'team'
} & (
  | {
      kind: 'contact'
      upgrade_url: string
      owner: { name: string | null; email: string }
      request_message: string
    }
  | { kind: 'billing'; upgrade_url: string; action_message: string }
  | { kind: 'support'; support_url: string }
)

export function UpgradeRequestPanel({
  request,
  existingErrorLine,
}: {
  request: UpgradeRequestView
  existingErrorLine: string
}) {
  const { t } = useT()
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = async () => {
    if (request.kind !== 'contact') return
    try {
      await navigator.clipboard.writeText(request.request_message)
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
  }
  return (
    <Alert>
      <AlertTitle>
        {request.current_plan === 'free' ? 'Free' : 'Plus'} →{' '}
        {request.recommended_plan === 'plus' ? 'Plus' : 'Team'}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{existingErrorLine}</p>
        {request.kind === 'contact' ? (
          <>
            <p>
              {request.owner.name
                ? `${request.owner.name} (${request.owner.email})`
                : request.owner.email}
            </p>
            <Textarea readOnly value={request.request_message} rows={5} />
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={copy}>
                {t('upgradeRequest.copy')}
              </Button>
              {copied === 'copied' ? (
                <small>{t('upgradeRequest.copied')}</small>
              ) : null}
              {copied === 'failed' ? (
                <small>{t('upgradeRequest.copyFailed')}</small>
              ) : null}
            </div>
          </>
        ) : request.kind === 'billing' ? (
          <>
            <p>{request.action_message}</p>
            <Button asChild size="sm">
              <a href={request.upgrade_url}>{t('upgradeRequest.billing')}</a>
            </Button>
          </>
        ) : (
          <Button asChild variant="outline" size="sm">
            <a href={request.support_url}>{t('upgradeRequest.support')}</a>
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}
