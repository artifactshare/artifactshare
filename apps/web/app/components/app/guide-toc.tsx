import { useGuideToc } from '~/hooks/use-guide-toc'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'
import {
  guideRailNavSurfaceClassName,
  guideTocMobileSurfaceClassName,
} from '~/components/app/guide-styles'

export interface GuideTocItem {
  id: string
  label: string
}

const guideRailClassName = 'sticky top-20 max-lg:hidden'

const guideRailTitleClassName =
  'm-0 mb-3 pl-3 text-xs font-semibold tracking-wide text-faint'

export function GuideTocMobile({
  items,
  title,
}: {
  items: GuideTocItem[]
  title: string
}) {
  return (
    <Inline gap="2" wrap className={guideTocMobileSurfaceClassName} asChild>
      <nav aria-label={title}>
        {items.map((item) => (
          <a key={item.id} href={`#${item.id}`}>
            {item.label}
          </a>
        ))}
      </nav>
    </Inline>
  )
}

export function GuideRail({
  items,
  title,
}: {
  items: GuideTocItem[]
  title: string
}) {
  const activeId = useGuideToc()
  return (
    <aside className={guideRailClassName} aria-label={title}>
      <p className={guideRailTitleClassName}>{title}</p>
      <Stack gap="1" className={guideRailNavSurfaceClassName} asChild>
        <nav>
          {items.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              aria-current={activeId === item.id ? 'true' : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </Stack>
    </aside>
  )
}
