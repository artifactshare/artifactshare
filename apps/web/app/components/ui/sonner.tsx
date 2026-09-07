import { Toaster as Sonner, type ToasterProps } from 'sonner'
import {
  IconCircleCheck,
  IconInfoCircle,
  IconAlertTriangle,
  IconCircleX,
  IconLoader,
} from '@tabler/icons-react'
import { useAnalyticsConsent } from '~/components/app/analytics-consent-provider'
import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'
import { bindI18n } from '~/lib/i18n'

type AppToasterProps = ToasterProps & { locale?: Locale }

const Toaster = ({
  locale = DEFAULT_LOCALE,
  toastOptions,
  ...props
}: AppToasterProps) => {
  const { commentPanelOpen } = useAnalyticsConsent()
  const { t } = bindI18n(locale)
  return (
    <Sonner
      theme="system"
      className="toaster group max-sheet:[--comment-panel-toast-bottom:calc(var(--height-comment-panel-sheet)+var(--spacing-3))] [--comment-panel-toast-bottom:var(--spacing-6)]"
      {...(commentPanelOpen
        ? {
            offset: { bottom: 'var(--comment-panel-toast-bottom)' },
            mobileOffset: { bottom: 'var(--comment-panel-toast-bottom)' },
          }
        : {})}
      icons={{
        success: <IconCircleCheck className="size-4" />,
        info: <IconInfoCircle className="size-4" />,
        warning: <IconAlertTriangle className="size-4" />,
        error: <IconCircleX className="size-4" />,
        loading: <IconLoader className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        closeButtonAriaLabel:
          toastOptions?.closeButtonAriaLabel ?? t('toast.close'),
        classNames: {
          toast: 'cn-toast',
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
