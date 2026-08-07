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
    <Table>
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
          <Link to={`/projects/${row.id}`}>{row.name}</Link>
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
