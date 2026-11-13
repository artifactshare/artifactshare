import type { ReactNode } from 'react'
import { TableEmptyRow } from '~/components/form/table-empty-row'
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { useT } from '~/hooks/use-t'

export function CredentialTable({
  children,
  empty,
  emptyMessage,
}: {
  children: ReactNode
  empty: boolean
  emptyMessage: string
}) {
  const { t } = useT()
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('team.tokens.table.name')}</TableHead>
          <TableHead className="max-phone:hidden">
            {t('team.tokens.table.created')}
          </TableHead>
          <TableHead className="max-nav:hidden">
            {t('team.tokens.table.lastUsed')}
          </TableHead>
          <TableHead className="text-right">
            {t('team.tokens.table.actions')}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {children}
        {empty ? (
          <TableEmptyRow colSpan={4}>{emptyMessage}</TableEmptyRow>
        ) : null}
      </TableBody>
    </Table>
  )
}
