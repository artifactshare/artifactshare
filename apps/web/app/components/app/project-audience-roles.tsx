import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  use,
} from 'react'
import { useT } from '~/hooks/use-t'
import { isExternalEmail } from '~/lib/grant-emails'
import { UserKindBadge } from '~/components/app/user-kind-badge'
import type { TKey } from '~/lib/i18n'
import {
  PROJECT_SHARE_ROLES,
  type ProjectShareRole,
} from '~/lib/shareable-types'
import type { GrantEditorEntry } from './grant-editor-state'

const ROLE_LABEL_KEYS = {
  viewer: 'projectShareDefaults.role.viewer',
  contributor: 'projectShareDefaults.role.contributor',
  manager: 'projectShareDefaults.role.manager',
} as const satisfies Record<ProjectShareRole, TKey>

function useRoleLabel() {
  const { t } = useT()
  return (role: ProjectShareRole) => t(ROLE_LABEL_KEYS[role])
}

export function RoleSelect({
  value,
  disabled,
  onChange,
}: {
  value: ProjectShareRole
  disabled: boolean
  onChange: (role: ProjectShareRole) => void
}) {
  const { t } = useT()
  const roleLabel = useRoleLabel()
  return (
    <select
      className="focus-visible:border-ring focus-visible:ring-ring/50 border-border bg-card text-foreground h-8 shrink-0 rounded-[var(--r-sm)] border px-[var(--spacing-1_5)] font-[inherit] text-sm focus-visible:ring-3 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      aria-label={t('projectShareDefaults.role.ariaLabel')}
      value={value}
      disabled={disabled}
      onChange={(event) =>
        onChange(event.currentTarget.value as ProjectShareRole)
      }
    >
      {PROJECT_SHARE_ROLES.map((role) => (
        <option key={role} value={role}>
          {roleLabel(role)}
        </option>
      ))}
    </select>
  )
}

export interface AudienceRoleContextValue {
  canEdit: boolean
  saving: boolean
  workspaceHd: string | null
  pendingAddEmails: ReadonlyArray<string>
  pendingAddRoles: Record<string, ProjectShareRole>
  roleChanges: Record<string, ProjectShareRole>
  addRole: ProjectShareRole
  setPendingAddRoles: Dispatch<SetStateAction<Record<string, ProjectShareRole>>>
  setRoleChanges: Dispatch<SetStateAction<Record<string, ProjectShareRole>>>
  getDefaultRole: (email: string) => ProjectShareRole
}

const AudienceRoleContext = createContext<AudienceRoleContextValue | null>(null)

export function AudienceRoleProvider({
  value,
  children,
}: {
  value: AudienceRoleContextValue
  children: ReactNode
}) {
  return (
    <AudienceRoleContext.Provider value={value}>
      {children}
    </AudienceRoleContext.Provider>
  )
}

// GrantEditorSection の各行メタ枠でレンダリングする。役割編集の共有状態は
// AudienceRoleProvider から読むため、行ごとに渡すのは entry だけで済む。
export function AudienceEntryMeta({ entry }: { entry: GrantEditorEntry }) {
  const { t } = useT()
  const roleLabel = useRoleLabel()
  const ctx = use(AudienceRoleContext)
  if (!ctx) return null

  const isPending = ctx.pendingAddEmails.includes(entry.email)
  const currentRole = isPending
    ? (ctx.pendingAddRoles[entry.email] ?? ctx.addRole)
    : (ctx.roleChanges[entry.email] ?? ctx.getDefaultRole(entry.email))

  return (
    <>
      <UserKindBadge kind={entry.user?.kind} />
      {isExternalEmail(entry.email, ctx.workspaceHd) ? (
        <span className="border-divider text-muted-foreground rounded-[var(--r-sm)] border px-[var(--spacing-1)] text-xs font-medium">
          {t('projectShareDefaults.external')}
        </span>
      ) : null}
      {ctx.canEdit ? (
        <RoleSelect
          value={currentRole}
          disabled={ctx.saving}
          onChange={(role) => {
            if (isPending) {
              ctx.setPendingAddRoles((prev) => ({
                ...prev,
                [entry.email]: role,
              }))
              return
            }
            ctx.setRoleChanges((prev) => {
              const next = { ...prev }
              // 現在の役割へ戻したら変更として残さない
              // (無駄な UPDATE と「変更あり」誤判定を避ける)。
              if (role === ctx.getDefaultRole(entry.email)) {
                delete next[entry.email]
              } else {
                next[entry.email] = role
              }
              return next
            })
          }}
        />
      ) : (
        <span className="text-muted-foreground text-xs">
          {roleLabel(currentRole)}
        </span>
      )}
    </>
  )
}

export function AudienceImpactNotes({
  externalActiveCount,
  artifactCount,
  pendingAddCount,
  pendingRemoveCount,
}: {
  externalActiveCount: number
  artifactCount: number
  pendingAddCount: number
  pendingRemoveCount: number
}) {
  const { t } = useT()
  return (
    <>
      {externalActiveCount > 0 ? (
        <p className="bg-warning-soft text-warning rounded-[var(--r-md)] border border-[color-mix(in_srgb,var(--warning)_28%,var(--divider))] p-[var(--spacing-2)] font-medium">
          {t('projectShareDefaults.externalNotice', {
            count: externalActiveCount,
          })}
        </p>
      ) : null}
      {artifactCount > 0 && pendingAddCount > 0 ? (
        <p className="text-muted-foreground">
          {t('projectShareDefaults.addImpactNote', { count: artifactCount })}
        </p>
      ) : null}
      {artifactCount > 0 && pendingRemoveCount > 0 ? (
        <p className="text-muted-foreground">
          {t('projectShareDefaults.removeImpactNote', { count: artifactCount })}
        </p>
      ) : null}
    </>
  )
}
