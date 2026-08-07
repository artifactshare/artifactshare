import { VisibilitySelect } from '~/components/app/visibility-select'
import type { Translator } from '~/lib/i18n'
import type { EditableVisibility } from '~/lib/shareable-types'

interface UploadVisibilitySelectorProps {
  label: string
  visibility: EditableVisibility
  workspaceHd: string | null
  availableVisibilities: ReadonlyArray<EditableVisibility>
  t: Translator['t']
  onSelect: (visibility: EditableVisibility) => void
}

export function UploadVisibilitySelector({
  label,
  visibility,
  workspaceHd,
  availableVisibilities,
  t,
  onSelect,
}: UploadVisibilitySelectorProps) {
  return (
    <VisibilitySelect
      selected={visibility}
      availableVisibilities={availableVisibilities}
      label={(v) => t(`upload.visibility.${v}`)}
      description={(v) =>
        t(`upload.visibility.${v}.sub`, { hd: workspaceHd ?? '—' })
      }
      onSelect={onSelect}
      ariaLabel={label}
    />
  )
}
