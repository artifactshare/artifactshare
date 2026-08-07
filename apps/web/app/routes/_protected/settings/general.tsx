import {
  Form,
  Link,
  redirect,
  useFetcher,
  useNavigation,
  useOutletContext,
  useRouteLoaderData,
} from 'react-router'
import type { Route } from './+types/general'
import { TeamUser } from './+components/team-user'
import type { SettingsLayoutContext } from './_layout'
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
  if (stringValue(form.get('intent')) !== 'update-workspace-name') {
    return redirect('/settings/general?status=invalid')
  }
  const result = await updateWorkspaceName(
    createDb(),
    user,
    stringValue(form.get('workspaceName')) ?? '',
  )
  return redirect(`/settings/general?status=${result.kind}`)
}

export default function GeneralPage({ loaderData }: Route.ComponentProps) {
  const shell = useOutletContext<SettingsLayoutContext>()
  const { t } = useT()
  const canManage = shell.currentUserIsAdmin
  return (
    <SettingsPage>
      <AnalyticsConsentSection />
      <WorkspaceNameSection name={shell.workspace.name} canManage={canManage} />
      <SettingsSection title={t('team.members.owner')}>
        <TeamUser
          name={displayName(loaderData.owner)}
          email={loaderData.owner.email}
        />
      </SettingsSection>
      {canManage ? <RoleGuideSection role={shell.currentUserRole} /> : null}
    </SettingsPage>
  )
}

function AnalyticsConsentSection() {
  const { t } = useT()
  const fetcher = useFetcher()
  const rootData = useRouteLoaderData<{
    analyticsConsent?: {
      shouldLoadAnalytics: boolean
      state: 'granted' | 'denied' | 'unset'
    }
  }>('root')
  const on = rootData?.analyticsConsent?.shouldLoadAnalytics ?? false
  const pending = fetcher.state !== 'idle'
  const submit = (consent: 'granted' | 'denied') =>
    fetcher.submit(
      { consent },
      { method: 'POST', action: '/set-analytics-consent' },
    )
  return (
    <SettingsSection
      title={t('analyticsConsent.settings.title')}
      description={t('analyticsConsent.settings.description')}
    >
      <div className="gap-field flex flex-col">
        <p className="text-muted-foreground m-0 text-sm">
          {on
            ? t('analyticsConsent.status.granted')
            : t('analyticsConsent.status.denied')}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={on ? 'secondary' : 'outline'}
            size="sm"
            disabled={pending}
            onClick={() => submit('granted')}
          >
            {t('analyticsConsent.settings.on')}
          </Button>
          <Button
            type="button"
            variant={on ? 'outline' : 'secondary'}
            size="sm"
            disabled={pending}
            onClick={() => submit('denied')}
          >
            {t('analyticsConsent.settings.off')}
          </Button>
        </div>
      </div>
    </SettingsSection>
  )
}

function WorkspaceNameSection({
  name,
  canManage,
}: {
  name: string
  canManage: boolean
}) {
  const navigation = useNavigation()
  const { t } = useT()
  const pending = navigation.formData?.get('intent') === 'update-workspace-name'
  return (
    <SettingsSection
      title={t('team.workspace.name')}
      description={t('team.workspace.name.body')}
    >
      <Form method="post">
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
              required
            />
          </Field>
          <Button size="sm" type="submit" disabled={!canManage || pending}>
            {t('team.workspace.name.save')}
          </Button>
        </InlineFields>
      </Form>
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
