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
import { VisibilityChip } from '~/components/app/visibility-chip'
import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'
import { formatBytes } from '~/lib/format'
import { shortVisibilityLabelKey } from '~/lib/visibility-labels'
import type { Visibility } from '~/lib/shareable-types'
import type { InventoryArtifactEntry } from '~/lib/team-management'
import { nameCellClassName } from './inventory'
import { truncateCellClassName } from '~/components/form/settings-text-styles'

const ARTIFACT_HEADERS = [
  'team.inventory.name',
  'team.inventory.owner',
  'team.inventory.location',
  'team.inventory.scope',
  'team.inventory.size',
  'team.inventory.updated',
] as const

export function visibilityLabel(
  v: Visibility,
  t: ReturnType<typeof useT>['t'],
) {
  return t(shortVisibilityLabelKey(v))
}

export function ArtifactsTable({
  rows,
  locale,
}: {
  rows: InventoryArtifactEntry[]
  locale: 'ja' | 'en'
}) {
  const { t } = useT()
  return (
    <>
      <Table className="max-nav:hidden">
        <TableHeader>
          <TableRow>
            {ARTIFACT_HEADERS.map((key) => (
              <TableHead key={key}>{t(key)}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <ArtifactRow key={row.id} row={row} locale={locale} />
          ))}
          {!rows.length ? (
            <TableEmptyRow colSpan={ARTIFACT_HEADERS.length}>
              {t('team.inventory.empty')}
            </TableEmptyRow>
          ) : null}
        </TableBody>
      </Table>
      <div className="max-nav:block max-nav:space-y-3 hidden">
        {rows.map((row) => (
          <article
            key={row.id}
            className="border-border bg-card rounded-lg border p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <Link
                className="text-link min-w-0 truncate font-medium underline"
                to={`/a/${row.id}`}
              >
                {row.name}
              </Link>
              <VisibilityChip
                visibility={row.visibility}
                label={visibilityLabel(row.visibility, t)}
              />
            </div>
            <dl className="text-muted-foreground mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <dt className="text-xs">{t('team.inventory.owner')}</dt>
                <dd className="truncate">
                  {row.owner.name ?? row.owner.email}
                </dd>
              </div>
              <div>
                <dt className="text-xs">{t('team.inventory.location')}</dt>
                <dd>
                  {row.location.kind === 'inbox'
                    ? t('team.inventory.home')
                    : row.location.name}
                </dd>
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
            <Link
              className="text-link mt-3 inline-block text-sm underline"
              to={`/a/${row.id}`}
            >
              {t('team.inventory.open')}
            </Link>
          </article>
        ))}
      </div>
      <p className="text-muted-foreground mt-[var(--spacing-4)] text-sm">
        <Link className="text-link underline" to="/settings#removed-members">
          {t('team.removedMembers')}
        </Link>
      </p>
    </>
  )
}

function ArtifactRow({
  row,
  locale,
}: {
  row: InventoryArtifactEntry
  locale: 'ja' | 'en'
}) {
  const { t } = useT()
  return (
    <TableRow>
      <TableCell>
        <span className={nameCellClassName} title={row.name}>
          <Link to={`/a/${row.id}`}>{row.name}</Link>
        </span>
      </TableCell>
      <TableCell>
        <span
          className={truncateCellClassName}
          title={row.owner.name ?? row.owner.email}
        >
          {row.owner.name ?? row.owner.email}
        </span>
      </TableCell>
      <TableCell>
        {row.location.kind === 'inbox'
          ? t('team.inventory.home')
          : row.location.name}
      </TableCell>
      <TableCell>
        <VisibilityChip
          visibility={row.visibility}
          label={visibilityLabel(row.visibility, t)}
        />
      </TableCell>
      <TableCell>
        {row.sizeBytes == null ? '—' : formatBytes(row.sizeBytes)}
      </TableCell>
      <TableCell>{formatRelative(row.updatedAt, locale)}</TableCell>
    </TableRow>
  )
}
