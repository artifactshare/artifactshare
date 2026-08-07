import type { ReactNode } from 'react'

import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'

export type GallerySection = {
  id: string
  title: string
  /** 対応する部品ファイル参照。例: `ui/button` / `form/page-header`。parity テストの基準。 */
  file: string
  element: ReactNode
}

export function Labeled({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <Stack gap="1.5">
      <span className="text-muted-foreground font-mono text-xs">{label}</span>
      <Inline gap="3" align="center" wrap>
        {children}
      </Inline>
    </Stack>
  )
}

export function GalleryColumn({ children }: { children: ReactNode }) {
  return (
    <Stack gap="3" className="max-w-md">
      {children}
    </Stack>
  )
}
