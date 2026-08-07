import { Link } from 'react-router'
import { Button } from '~/components/ui/button'
import { AppEmptyState } from '~/components/app/app-empty-state'
import { useT } from '~/hooks/use-t'
import { withLang } from '~/lib/connect-link'
import { IconPlus } from '@tabler/icons-react'

interface EmptyStateProps {
  variant?: 'files' | 'recent'
  onUploadClick?: () => void
  showUploadAction?: boolean
  query?: string
  hasHiddenHistory?: boolean
  filtered?: boolean
}

export function EmptyState({
  variant = 'files',
  onUploadClick,
  showUploadAction = true,
  query,
  hasHiddenHistory = false,
  filtered = false,
}: EmptyStateProps) {
  const { locale, t } = useT()
  if (query) {
    return (
      <AppEmptyState
        icon={<FileIcon />}
        title={t('recent.empty.searchTitle')}
        body={t('recent.empty.searchBody')}
      />
    )
  }
  if (variant === 'recent') {
    return (
      <AppEmptyState
        icon={<FileIcon />}
        title={t(
          filtered
            ? 'recent.empty.filteredTitle'
            : hasHiddenHistory
              ? 'recent.empty.hiddenTitle'
              : 'recent.empty.title',
        )}
        body={t(
          filtered
            ? 'recent.empty.filteredBody'
            : hasHiddenHistory
              ? 'recent.empty.hiddenBody'
              : 'recent.empty.body',
        )}
      />
    )
  }
  return (
    <AppEmptyState
      icon={<FileIcon />}
      title={t('empty.title')}
      body={t('empty.body')}
      action={
        <>
          {showUploadAction ? (
            <Button type="button" onClick={onUploadClick}>
              <IconPlus aria-hidden="true" />
              <span>{t('upload.cta.primary')}</span>
            </Button>
          ) : null}
          <Button variant="link" asChild>
            <Link to={withLang('/connect', locale)}>{t('empty.connect')}</Link>
          </Button>
          <p className="text-muted-foreground text-sm">
            {t('empty.productGuide')}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button variant="link" asChild>
              <Link to={withLang('/about', locale)}>{t('empty.about')}</Link>
            </Button>
            <Button variant="link" asChild>
              <Link to={withLang('/start', locale)}>{t('empty.start')}</Link>
            </Button>
          </div>
        </>
      }
    />
  )
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}
