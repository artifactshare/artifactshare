import { Link } from 'react-router'
import type { TKey } from '~/i18n/messages'
import { useT } from '~/hooks/use-t'
import { TeamMuted } from './team-muted'
import { Button } from '~/components/ui/button'

export function Pager({
  page,
  total,
  pageSize,
  hrefFor,
  labels,
}: {
  page: number
  total: number
  pageSize: number
  hrefFor: (page: number) => string
  labels: { range: TKey; prev: TKey; next: TKey }
}) {
  const { t } = useT()
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <TeamMuted>{t(labels.range, { from, to, total })}</TeamMuted>
      {pageCount > 1 ? (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link to={hrefFor(page - 1)}>{t(labels.prev)}</Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              {t(labels.prev)}
            </Button>
          )}
          {page < pageCount ? (
            <Button asChild variant="outline" size="sm">
              <Link to={hrefFor(page + 1)}>{t(labels.next)}</Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              {t(labels.next)}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  )
}
