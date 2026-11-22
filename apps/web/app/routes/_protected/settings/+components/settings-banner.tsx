import { useT } from '~/hooks/use-t'
import type { TKey } from '~/i18n/messages'
import type { TeamMutationResult } from '~/lib/team-management'
import type { ComponentProps } from 'react'
import {
  IconCheck,
  IconAlertTriangle,
  IconAlertCircle,
} from '@tabler/icons-react'
import { Alert } from '~/components/ui/alert'
import { cn } from '~/lib/utils'

export type SettingsNoticeKind = 'success' | 'warning' | 'error'

export function SettingsBanner({
  className,
  kind,
  urgent = false,
  children,
  ...props
}: Omit<ComponentProps<typeof Alert>, 'role'> & {
  kind: SettingsNoticeKind
  urgent?: boolean
}) {
  const Icon =
    kind === 'success'
      ? IconCheck
      : kind === 'warning'
        ? IconAlertTriangle
        : IconAlertCircle
  return (
    <Alert
      {...props}
      role={
        kind === 'error' || (kind === 'warning' && urgent) ? 'alert' : 'status'
      }
      className={cn(
        'text-foreground rounded-[var(--r-md)] px-[var(--spacing-4)] py-[var(--spacing-3)]',
        kind === 'success' &&
          'border-success/30 bg-success-soft [&>svg]:text-success',
        kind === 'warning' &&
          'border-warning/30 bg-warning-soft [&>svg]:text-warning',
        kind === 'error' &&
          'border-destructive/30 bg-destructive/10 [&>svg]:text-destructive',
        className,
      )}
    >
      <Icon size={16} aria-hidden="true" />
      <div className="min-w-0 space-y-2">{children}</div>
    </Alert>
  )
}

export type BillingStatusKey =
  | 'checkout-success'
  | 'checkout-cancelled'
  | 'plan-change-requested'
  | 'already-subscribed'
  | 'no-subscription'
  | 'plan-required'
  | 'invalid-policy'

type SettingsStatusKey =
  | TeamMutationResult['kind']
  | BillingStatusKey
  | 'slack-disconnected'
  | 'invalid-patch'
  | 'billing-unavailable'
  | 'removed'
  | 'removed-transfer-failed'
  | 'restore-unavailable'
  | 'slack-team-in-use'
  | 'slack-team-mismatch'

export function StatusBanner({ status }: { status: string }) {
  const notice = settingsNotice(status)
  const { t } = useT()
  return (
    <SettingsBanner kind={notice.kind} data-settings-status={status}>
      {t(notice.message)}
    </SettingsBanner>
  )
}

const SETTINGS_STATUS_NOTICES: Record<
  SettingsStatusKey,
  { message: TKey; kind: SettingsNoticeKind }
> = {
  ok: { message: 'team.status.ok', kind: 'success' },
  'slack-disconnected': {
    message: 'team.integrations.slack.disconnected',
    kind: 'success',
  },
  'invalid-patch': { message: 'team.status.invalidPatch', kind: 'error' },
  'billing-unavailable': {
    message: 'team.status.billingUnavailable',
    kind: 'error',
  },
  removed: { message: 'team.status.removed', kind: 'success' },
  'removed-transfer-failed': {
    message: 'team.status.removedTransferFailed',
    kind: 'warning',
  },
  'restore-unavailable': {
    message: 'team.status.restoreUnavailable',
    kind: 'error',
  },
  forbidden: { message: 'team.status.forbidden', kind: 'error' },
  'self-forbidden': { message: 'team.status.selfForbidden', kind: 'error' },
  'not-team': { message: 'team.status.notTeam', kind: 'error' },
  'not-found': { message: 'team.status.notFound', kind: 'error' },
  invalid: { message: 'team.status.invalid', kind: 'error' },
  'external-failed': { message: 'team.status.externalFailed', kind: 'error' },
  'checkout-success': {
    message: 'billing.status.checkoutSuccess',
    kind: 'success',
  },
  'checkout-cancelled': {
    message: 'billing.status.checkoutCancelled',
    kind: 'warning',
  },
  'plan-change-requested': {
    message: 'billing.status.planChangeRequested',
    kind: 'success',
  },
  'already-subscribed': {
    message: 'billing.status.alreadySubscribed',
    kind: 'warning',
  },
  'no-subscription': {
    message: 'billing.status.noSubscription',
    kind: 'error',
  },
  'plan-required': { message: 'team.status.planRequired', kind: 'error' },
  'invalid-policy': { message: 'team.status.invalidPolicy', kind: 'error' },
  'bot-revoke-not-supported': {
    message: 'team.status.botRevokeNotSupported',
    kind: 'error',
  },
  'slack-team-in-use': {
    message: 'team.integrations.slack.teamInUse',
    kind: 'error',
  },
  'slack-team-mismatch': {
    message: 'team.integrations.slack.teamMismatch',
    kind: 'error',
  },
}

export function settingsNotice(status: string): {
  message: TKey
  kind: SettingsNoticeKind
} {
  return (
    Object.entries(SETTINGS_STATUS_NOTICES).find(
      ([key]) => key === status,
    )?.[1] ?? { message: 'team.status.generic', kind: 'error' }
  )
}
