import { Toaster as Sonner, type ToasterProps } from 'sonner'
import {
  IconCircleCheck,
  IconInfoCircle,
  IconAlertTriangle,
  IconCircleX,
  IconLoader,
} from '@tabler/icons-react'
import { useAnalyticsConsent } from '~/components/app/analytics-consent-provider'

const Toaster = ({ ...props }: ToasterProps) => {
  const { commentPanelOpen } = useAnalyticsConsent()
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
        classNames: {
          toast: 'cn-toast',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
