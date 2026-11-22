import { inlineLinkClassName } from '~/components/form/settings-text-styles'
import { TableEmptyRow } from '~/components/form/table-empty-row'
import { Link } from 'react-router'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { TeamMuted } from '~/components/form/team-muted'
import { ProjectScopeChip } from '~/components/app/visibility-chip'
import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'
import { formatBytes } from '~/lib/format'
import type { InventoryProjectEntry } from '~/lib/team-management'
import { nameCellClassName } from './inventory'

const PROJECT_HEADERS = [
  'team.inventory.name',
  'team.inventory.scope',
  'team.inventory.count',
  'team.inventory.size',
  'team.inventory.updated',
] as const

export function ProjectsTable({
  rows,
  locale,
}: {
  rows: InventoryProjectEntry[]
  locale: 'ja' | 'en'
}) {
  const { t } = useT()
  return (
    <>
      <Table className="max-wide:hidden">
        <TableHeader>
          <TableRow>
            {PROJECT_HEADERS.map((key) => (
              <TableHead key={key}>{t(key)}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <ProjectRow key={row.id} row={row} locale={locale} />
          ))}
          {!rows.length ? (
            <TableEmptyRow colSpan={PROJECT_HEADERS.length}>
              {t('team.inventory.empty')}
            </TableEmptyRow>
          ) : null}
        </TableBody>
      </Table>
      <div className="max-wide:block max-wide:space-y-3 hidden">
        {!rows.length ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {t('team.inventory.empty')}
          </p>
        ) : null}
        {rows.map((row) => (
          <article
            key={row.id}
            className="border-border bg-card rounded-lg border p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <Link
                className="text-link min-w-0 font-medium [overflow-wrap:anywhere] underline"
                to={`/projects/${row.id}`}
              >
                {row.name}
              </Link>
              <ProjectScopeChip baseVisibility={row.baseVisibility} />
            </div>
            {row.archivedAt ? (
              <TeamMuted>{t('team.inventory.archived')}</TeamMuted>
            ) : null}
            <dl className="text-muted-foreground mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <dt className="text-xs">{t('team.inventory.count')}</dt>
                <dd>{row.artifactCount}</dd>
              </div>
              <div>
                <dt className="text-xs">{t('team.inventory.size')}</dt>
                <dd>
                  {row.sizeBytes == null ? '—' : formatBytes(row.sizeBytes)}
                </dd>
              </div>
              <div>
                <dt className="text-xs">{t('team.inventory.updated')}</dt>
                <dd>{formatRelative(row.updatedAt, locale)}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </>
  )
}

function ProjectRow({
  row,
  locale,
}: {
  row: InventoryProjectEntry
  locale: 'ja' | 'en'
}) {
  const { t } = useT()
  return (
    <TableRow>
      <TableCell>
        <span className={nameCellClassName} title={row.name}>
          <Link className={inlineLinkClassName} to={`/projects/${row.id}`}>
            {row.name}
          </Link>
        </span>
        {row.archivedAt ? (
          <TeamMuted> · {t('team.inventory.archived')}</TeamMuted>
        ) : null}
      </TableCell>
      <TableCell>
        <ProjectScopeChip baseVisibility={row.baseVisibility} />
      </TableCell>
      <TableCell>{row.artifactCount}</TableCell>
      <TableCell>
        {row.sizeBytes == null ? '—' : formatBytes(row.sizeBytes)}
      </TableCell>
      <TableCell>{formatRelative(row.updatedAt, locale)}</TableCell>
    </TableRow>
  )
}
