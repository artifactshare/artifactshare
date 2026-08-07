import { avatarSlotFor } from '~/lib/user'

export function ProjectMark({ id, name }: { id: string; name: string }) {
  const initial = Array.from(name.trim())[0] ?? '?'
  return (
    <span
      className="inline-flex size-[var(--project-mark-size)] shrink-0 items-center justify-center rounded-full text-xs font-medium text-white"
      style={{ background: `var(--avatar-${avatarSlotFor(id)})` }}
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}
