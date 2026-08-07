import { Button } from '~/components/ui/button'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'

import type { GallerySection } from './kit'
import { Labeled } from './kit'

export const layoutSections: GallerySection[] = [
  {
    id: 'layout-stack-gaps',
    title: 'Stack — gap',
    file: 'layout/stack',
    element: (
      <Inline gap="6" wrap>
        <Labeled label='gap="2"'>
          <Stack gap="2" className="w-40 rounded-lg border p-3">
            <div className="bg-muted h-8 rounded" />
            <div className="bg-muted h-8 rounded" />
          </Stack>
        </Labeled>
        <Labeled label='gap="6"'>
          <Stack gap="6" className="w-40 rounded-lg border p-3">
            <div className="bg-muted h-8 rounded" />
            <div className="bg-muted h-8 rounded" />
          </Stack>
        </Labeled>
      </Inline>
    ),
  },
  {
    id: 'layout-stack-alignment',
    title: 'Stack — alignment',
    file: 'layout/stack',
    element: (
      <Stack gap="3" align="center" className="max-w-md rounded-lg border p-3">
        <div className="bg-muted h-8 w-24 rounded" />
        <div className="bg-muted h-8 w-40 rounded" />
        <div className="bg-muted h-8 w-16 rounded" />
      </Stack>
    ),
  },
  {
    id: 'layout-stack-as-child',
    title: 'Stack — asChild',
    file: 'layout/stack',
    element: (
      <Stack gap="2" asChild>
        <ul className="max-w-md rounded-lg border p-3">
          <li>First item</li>
          <li>Second item</li>
        </ul>
      </Stack>
    ),
  },
  {
    id: 'layout-inline-controls',
    title: 'Inline — alignment / justify / wrap',
    file: 'layout/inline',
    element: (
      <Stack gap="4" className="max-w-md">
        <Labeled label="center / between">
          <Inline
            gap="2"
            align="center"
            justify="between"
            className="w-60 rounded-lg border p-3"
          >
            <span className="bg-muted rounded px-2 py-1 text-sm">Left</span>
            <span className="bg-muted rounded px-2 py-1 text-sm">Right</span>
          </Inline>
        </Labeled>
        <Labeled label="wrap on narrow width">
          <Inline gap="2" wrap className="max-w-48 rounded-lg border p-3">
            <Button size="sm" variant="outline">
              Alpha
            </Button>
            <Button size="sm" variant="outline">
              Beta
            </Button>
            <Button size="sm" variant="outline">
              Gamma
            </Button>
            <Button size="sm" variant="outline">
              Delta
            </Button>
          </Inline>
        </Labeled>
      </Stack>
    ),
  },
  {
    id: 'layout-inline-as-child',
    title: 'Inline — asChild',
    file: 'layout/inline',
    element: (
      <Inline gap="2" align="center" asChild>
        <button
          type="button"
          className="border-border bg-background hover:bg-muted rounded-lg border px-3 py-2 text-sm"
        >
          <span className="bg-primary size-2 rounded-full" />
          <span>Connected action</span>
        </button>
      </Inline>
    ),
  },
  {
    id: 'layout-inline-long-content',
    title: 'Inline — long content',
    file: 'layout/inline',
    element: (
      <Inline gap="3" align="center" className="max-w-md rounded-lg border p-3">
        <span className="bg-muted shrink-0 rounded px-2 py-1 text-xs">ID</span>
        <span className="truncate font-mono text-sm">
          workspace-prod-analytics-dashboard-v2-final
        </span>
      </Inline>
    ),
  },
]
