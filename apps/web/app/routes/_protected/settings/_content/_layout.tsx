import {
  isRouteErrorResponse,
  Link,
  Outlet,
  useOutletContext,
} from 'react-router'
import type { SettingsLayoutContext } from '../_layout'
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '~/components/ui/empty'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'

export default function SettingsContent() {
  return <Outlet context={useOutletContext<SettingsLayoutContext>()} />
}

export function ErrorBoundary({ error }: { error: unknown }) {
  const { t } = useT()
  const status = isRouteErrorResponse(error) ? error.status : undefined
  const key =
    status === 403 ? 'forbidden' : status === 404 ? 'missing' : 'unexpected'
  return (
    <Empty data-screen-capture-error="settings-error-boundary">
      <EmptyHeader>
        <EmptyTitle>
          <h2>{t(`settings.error.${key}.title`)}</h2>
        </EmptyTitle>
        <EmptyDescription>
          {t(`settings.error.${key}.description`)}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="secondary">
          <Link to="/settings">{t('settings.error.back')}</Link>
        </Button>
      </EmptyContent>
    </Empty>
  )
}
