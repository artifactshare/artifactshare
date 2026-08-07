import {
  IconBuilding as Building2,
  IconLink as LinkIcon,
  IconLock as Lock,
  IconUsers as Users,
  type TablerIcon,
} from '@tabler/icons-react'
import type { ComponentProps, ComponentPropsWithoutRef } from 'react'
import { Badge } from '~/components/ui/badge'
import { cn } from '~/lib/utils'
import { useT } from '~/hooks/use-t'
import {
  isVisibility,
  type ProjectBaseVisibility,
  type Visibility,
} from '~/lib/shareable-types'
import { projectScopeLabelKey } from '~/lib/visibility-labels'

interface VisibilityMeta {
  icon: TablerIcon
  variant: NonNullable<ComponentProps<typeof Badge>['variant']>
  glyphClassName: string
}

const VISIBILITY_CHIP_BASE =
  'h-auto rounded-full border-0 py-[var(--spacing-1)] px-[var(--spacing-2)] leading-[var(--lh-tight)]'

const VISIBILITY_CHIP_BUTTON =
  'cursor-pointer transition-[filter,box-shadow] duration-120 hover:brightness-93 hover:shadow-[var(--ring-hairline)] active:brightness-88 focus-visible:outline-none'

const VISIBILITY_META: Record<Visibility, VisibilityMeta> = {
  private: {
    icon: Lock,
    variant: 'muted',
    glyphClassName: 'bg-chip-muted text-muted-foreground',
  },
  project: {
    icon: Users,
    variant: 'success',
    glyphClassName: 'bg-success-soft text-success',
  },
  workspace: {
    icon: Building2,
    variant: 'info',
    glyphClassName: 'bg-link-soft text-link',
  },
  link: {
    icon: LinkIcon,
    variant: 'warning',
    glyphClassName: 'bg-warning-soft text-warning',
  },
}

interface VisibilityChipProps {
  visibility: unknown
  label: string
  className?: string
  title?: string
  'aria-label'?: string
  onClick?: ComponentPropsWithoutRef<'button'>['onClick']
  'data-regression-responsive'?: 'mobile-only' | 'desktop-only'
}

export function VisibilityChip({
  visibility,
  label,
  className,
  title,
  'aria-label': ariaLabel,
  onClick,
  'data-regression-responsive': regressionResponsive,
}: VisibilityChipProps) {
  if (!isVisibility(visibility)) return null

  const meta = VISIBILITY_META[visibility]
  const Icon = meta.icon
  const classes = cn(
    VISIBILITY_CHIP_BASE,
    onClick && VISIBILITY_CHIP_BUTTON,
    className,
  )

  if (onClick) {
    return (
      <Badge asChild variant={meta.variant} className={classes}>
        <button
          type="button"
          title={title ?? label}
          aria-label={ariaLabel}
          onClick={onClick}
          data-regression-responsive={regressionResponsive}
        >
          <Icon aria-hidden="true" />
          <span>{label}</span>
        </button>
      </Badge>
    )
  }

  return (
    <Badge
      variant={meta.variant}
      className={classes}
      title={title ?? label}
      data-regression-responsive={regressionResponsive}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </Badge>
  )
}

// プロジェクトの共有範囲のベースを表すチップ。'workspace'=社内全員、
// 'private'=関係者のみ。関係者の人数は別の「関係者 N」ボタンで示す。
export function ProjectScopeChip({
  baseVisibility,
  className,
}: {
  baseVisibility: ProjectBaseVisibility
  className?: string
}) {
  const { t } = useT()
  const isPrivate = baseVisibility === 'private'
  return (
    <VisibilityChip
      visibility={isPrivate ? 'private' : 'workspace'}
      label={t(projectScopeLabelKey(isPrivate ? 'private' : 'workspace'))}
      className={className}
    />
  )
}

interface VisibilityGlyphProps {
  visibility: unknown
}

export function VisibilityGlyph({ visibility }: VisibilityGlyphProps) {
  if (!isVisibility(visibility)) return null

  const meta = VISIBILITY_META[visibility]
  const Icon = meta.icon
  return (
    <span
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--r-md)] [&>svg]:size-[var(--spacing-3)] [&>svg]:stroke-2',
        meta.glyphClassName,
      )}
    >
      <Icon aria-hidden="true" />
    </span>
  )
}
