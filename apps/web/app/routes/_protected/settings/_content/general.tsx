import { useSettingsEntryChange } from '~/hooks/use-settings-entry-change'
import {
  data,
  Link,
  useActionData,
  useFetcher,
  useOutletContext,
} from 'react-router'
import type { Route } from './+types/general'
import { StatusBanner } from '../+components/settings-banner'
import { TeamUser } from '../+components/team-user'
import type { SettingsLayoutContext } from '../_layout'
import { InlineFields } from '~/components/form/inline-fields'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsSection } from '~/components/form/settings-section'
import { inlineLinkClassName } from '~/components/form/settings-text-styles'
import { Button } from '~/components/ui/button'
import { Field, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { useT } from '~/hooks/use-t'
import { withLang } from '~/lib/connect-link'
import { stringValue } from '~/lib/form'
import { settingsFailure } from '~/lib/settings-submission'
import {
  WORKSPACE_NAME_MAX_LENGTH,
  displayName,
  type WorkspaceMemberRole,
} from '~/lib/team-management'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  loadWorkspaceOwner,
  updateWorkspaceName,
} from '~/services/team-management.server'
export async function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  return { owner: await loadWorkspaceOwner(db, user.workspaceId) }
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = requireUser(context)
  const form = await request.formData()
  const intent = stringValue(form.get('intent')) ?? ''
  if (intent !== 'update-workspace-name') {
    return data({ ok: false, intent, code: 'invalid' }, { status: 400 })
  }
  const result = await updateWorkspaceName(
    createDb(),
    user,
    stringValue(form.get('workspaceName')) ?? '',
  )
  return result.kind === 'ok'
    ? data({ ok: true as const, intent, code: result.kind }, { status: 200 })
    : settingsFailure(intent, result.kind)
}

export default function GeneralPage({
  loaderData,
}: Pick<Route.ComponentProps, 'loaderData'>) {
  const shell = useOutletContext<SettingsLayoutContext>()
  const fetcher = useFetcher<typeof action>()
  useSettingsEntryChange(fetcher.reset)
  // A submission made before hydration arrives as the route's action data.
  const nativeResult = useActionData<typeof action>()
  const result = fetcher.data ?? nativeResult
  const { t } = useT()
  const canManage = shell.currentUserIsAdmin
  return (
    <SettingsPage>
      {fetcher.state !== 'submitting' && result?.ok && (
        <StatusBanner status={result.code} />
      )}
      <WorkspaceNameSection
        fetcher={fetcher}
        result={result}
        name={shell.workspace.name}
        canManage={canManage}
      />
      <SettingsSection title={t('team.members.owner')}>
        {loaderData.owner ? (
          <TeamUser
            wrapOnPhone
            name={displayName(loaderData.owner)}
            email={loaderData.owner.email}
          />
        ) : null}
      </SettingsSection>
      {canManage ? <RoleGuideSection role={shell.currentUserRole} /> : null}
    </SettingsPage>
  )
}

function WorkspaceNameSection({
  fetcher,
  result,
  name,
  canManage,
}: {
  fetcher: ReturnType<typeof useFetcher<typeof action>>
  result: ReturnType<typeof useActionData<typeof action>>
  name: string
  canManage: boolean
}) {
  const { t } = useT()
  const guidanceId = canManage ? undefined : 'name-guidance'
  const pending = fetcher.state !== 'idle'
  return (
    <SettingsSection
      title={t('team.workspace.name')}
      description={t('team.workspace.name.body')}
      guidanceId={guidanceId}
      readOnlyGuidance={
        canManage ? undefined : t('team.workspace.name.readOnly')
      }
    >
      <fetcher.Form
        method="post"
        className="flex flex-col gap-[var(--spacing-2)]"
      >
        {!pending && result && !result.ok && (
          <StatusBanner status={result.code} />
        )}
        <input type="hidden" name="intent" value="update-workspace-name" />
        <InlineFields>
          <Field key={name} className="min-w-0">
            <FieldLabel htmlFor="workspace-name" className="sr-only">
              {t('team.workspace.name.label')}
            </FieldLabel>
            <Input
              id="workspace-name"
              name="workspaceName"
              type="text"
              defaultValue={name}
              maxLength={WORKSPACE_NAME_MAX_LENGTH}
              disabled={!canManage || pending}
              aria-describedby={guidanceId}
              required
            />
          </Field>
          <Button
            size="sm"
            type="submit"
            disabled={!canManage || pending}
            aria-describedby={guidanceId}
          >
            {t('team.workspace.name.save')}
          </Button>
        </InlineFields>
      </fetcher.Form>
    </SettingsSection>
  )
}

function RoleGuideSection({ role }: { role: WorkspaceMemberRole }) {
  const { locale, t } = useT()
  return (
    <SettingsSection
      title={t('team.guides.title')}
      description={t('team.guides.body')}
    >
      <div className="flex flex-col gap-1 text-sm">
        <Link
          className={inlineLinkClassName}
          to={withLang('/guides/workspace-admin', locale)}
        >
          {role === 'admin'
            ? t('team.guides.admin.primary')
            : t('team.guides.admin')}
        </Link>
        <Link
          className={inlineLinkClassName}
          to={withLang('/guides/workspace-owner', locale)}
        >
          {role === 'admin'
            ? t('team.guides.owner.reference')
            : t('team.guides.owner')}
        </Link>
      </div>
    </SettingsSection>
  )
}
