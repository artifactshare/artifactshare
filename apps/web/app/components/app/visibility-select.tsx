import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { VisibilityGlyph } from '~/components/app/visibility-chip'
import type { EditableVisibility } from '~/lib/shareable-types'
import { cn } from '~/lib/utils'
import { IconChevronDown } from '@tabler/icons-react'

const visibilitySelectTriggerClassName = cn(
  'flex w-full cursor-pointer items-center gap-[var(--spacing-2)]',
  'border-border bg-card rounded-[var(--r-md)] border',
  'text-foreground px-[var(--spacing-3)] py-[var(--spacing-2)] text-left font-[inherit] text-sm',
  'hover:border-border-strong',
  'data-[state=open]:border-border-strong',
  'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none',
)

const visibilitySelectCopyClassName = 'flex min-w-0 flex-col gap-0'

const visibilitySelectLabelClassName =
  'overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold'

const visibilitySelectTriggerDescriptionClassName =
  'text-xs text-muted-foreground'

const visibilitySelectItemDescriptionClassName = 'text-xs text-faint'

const visibilitySelectChevronClassName = 'ml-auto shrink-0 size-3.5 text-faint'

const visibilitySelectItemClassName =
  '!gap-[var(--spacing-2)] !px-[var(--spacing-3)] !py-[var(--spacing-2)]'

interface VisibilitySelectProps {
  selected: EditableVisibility
  availableVisibilities: ReadonlyArray<EditableVisibility>
  label: (visibility: EditableVisibility) => string
  description: (visibility: EditableVisibility) => string
  onSelect: (value: EditableVisibility) => void
  ariaLabel?: string
}

export function VisibilitySelect({
  selected,
  availableVisibilities,
  label,
  description,
  onSelect,
  ariaLabel,
}: VisibilitySelectProps) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={visibilitySelectTriggerClassName}
          aria-label={ariaLabel}
        >
          <VisibilityGlyph visibility={selected} />
          <span className={visibilitySelectCopyClassName}>
            <span className={visibilitySelectLabelClassName}>
              {label(selected)}
            </span>
            <small className={visibilitySelectTriggerDescriptionClassName}>
              {description(selected)}
            </small>
          </span>
          <IconChevronDown
            className={visibilitySelectChevronClassName}
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={selected}
          onValueChange={(v) => onSelect(v as EditableVisibility)}
        >
          {availableVisibilities.map((value) => (
            <DropdownMenuRadioItem
              key={value}
              value={value}
              className={visibilitySelectItemClassName}
            >
              <VisibilityGlyph visibility={value} />
              <span className={visibilitySelectCopyClassName}>
                <span className={visibilitySelectLabelClassName}>
                  {label(value)}
                </span>
                <small className={visibilitySelectItemDescriptionClassName}>
                  {description(value)}
                </small>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
