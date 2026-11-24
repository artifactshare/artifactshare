import { useFetcher, useRouteLoaderData } from 'react-router'
import { SettingsSection } from '~/components/form/settings-section'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
export default function AnalyticsPage() {
  const { t } = useT()
  const fetcher = useFetcher()
  const rootData = useRouteLoaderData<{
    analyticsConsent?: {
      shouldLoadAnalytics: boolean
      state: 'granted' | 'denied' | 'unset'
    }
  }>('root')
  const on = rootData?.analyticsConsent?.shouldLoadAnalytics ?? false
  const pending = fetcher.state !== 'idle'
  const submit = (consent: 'granted' | 'denied') =>
    fetcher.submit(
      { consent },
      { method: 'POST', action: '/set-analytics-consent' },
    )
  return (
    <SettingsSection
      title={t('analyticsConsent.settings.title')}
      description={t('analyticsConsent.settings.description')}
    >
      <div className="gap-field flex flex-col">
        <p className="text-muted-foreground m-0 text-sm">
          {on
            ? t('analyticsConsent.status.granted')
            : t('analyticsConsent.status.denied')}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={on ? 'default' : 'outline'}
            size="sm"
            disabled={pending}
            aria-pressed={on}
            onClick={() => submit('granted')}
          >
            {t('analyticsConsent.settings.on')}
          </Button>
          <Button
            type="button"
            variant={on ? 'outline' : 'default'}
            size="sm"
            disabled={pending}
            aria-pressed={!on}
            onClick={() => submit('denied')}
          >
            {t('analyticsConsent.settings.off')}
          </Button>
        </div>
      </div>
    </SettingsSection>
  )
}
