import type { ReactNode } from 'react'

import { Stack } from '~/components/layout/stack'
import { cn } from '~/lib/utils'
import {
  statLabelClassName,
  statValueClassName,
} from '~/components/form/settings-text-styles'
import { Card } from '~/components/ui/card'

export function UsageStats({
  children,
  className,
  columns = 3,
}: {
  children: ReactNode
  className?: string
  columns?: 2 | 3 | 4
}) {
  // 各セルの右・下の境界線を外周の負マージンで隠す。列数がレスポンシブに
  // 変わっても (端数の折り返しを含め) 縦横の区切り線が追従する。
  return (
    <Card size="sm" className={cn('gap-0 overflow-hidden py-0', className)}>
      <div
        className={cn(
          `grid ${columns === 4 ? 'grid-cols-4' : columns === 2 ? 'grid-cols-2' : 'grid-cols-3'}`,
          'max-wide:grid-cols-2 max-stack:grid-cols-1',
          '-mr-px -mb-px',
          '[&>div]:border-divider [&>div]:min-w-0 [&>div]:border-r [&>div]:border-b [&>div]:p-[var(--spacing-4)]',
          // 端数の行で空トラックの手前に区切り線が残らないようにする
          // (行が埋まらないのはグリッド全体の最終セルだけ)。
          '[&>div:last-child]:border-r-0',
        )}
      >
        {children}
      </div>
    </Card>
  )
}

export function UsageStat({
  label,
  value,
  children,
}: {
  label: ReactNode
  value: ReactNode
  children?: ReactNode
}) {
  return (
    <Stack gap="2" asChild>
      <div
        // The grid's divider geometry makes adjacent statistic cells touch;
        // their contents must still be audited independently.
        data-gap-audit-allow-touch
      >
        <Stack gap="1">
          <span className={statLabelClassName}>{label}</span>
          <strong className={statValueClassName}>{value}</strong>
        </Stack>
        {children}
      </div>
    </Stack>
  )
}
