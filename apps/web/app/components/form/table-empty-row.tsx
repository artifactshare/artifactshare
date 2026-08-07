import type { ReactNode } from 'react'
import { Empty, EmptyDescription } from '~/components/ui/empty'
import { TableCell, TableRow } from '~/components/ui/table'

export function TableEmptyRow({
  colSpan,
  children,
}: {
  colSpan: number
  children: ReactNode
}) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan}>
        <Empty>
          <EmptyDescription>{children}</EmptyDescription>
        </Empty>
      </TableCell>
    </TableRow>
  )
}
