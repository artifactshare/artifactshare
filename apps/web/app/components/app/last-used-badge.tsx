import { Badge } from '~/components/ui/badge'
import { useLastLoginMethod } from '~/hooks/use-last-login-method'
import { useT } from '~/hooks/use-t'

/**
 * Small "last used" hint pill, shown only on the sign-in option matching the method
 * the user last signed in with on this browser. Renders nothing otherwise.
 */
export function LastUsedBadge({
  method,
}: {
  method: 'google' | 'microsoft' | 'email'
}) {
  const { t } = useT()
  const last = useLastLoginMethod()
  if (last !== method) return null
  return (
    <Badge className="ml-[var(--spacing-2)] h-auto rounded-full border-0 bg-[color-mix(in_srgb,currentColor_13%,transparent)] px-1.75 py-px text-inherit opacity-85">
      {t('signin.lastUsed')}
    </Badge>
  )
}
