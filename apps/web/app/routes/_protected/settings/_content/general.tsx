import {
  Form,
  Link,
  redirect,
  useNavigation,
  useOutletContext,
} from 'react-router'
import type { Route } from './+types/general'
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
import { isDevScreenStateRequest } from '~/services/dev-screen-state.server'
import type { ScreenSpec } from '~/types/screen'

export const screen = {
  id: 'settings-general',
  route: {
    en: '/settings/general',
  },
  auth: 'team-owner',
  loop: 'support',
  metric: 'ワークスペース設定の完了率を高める',
  role: '基本設定を管理する',
  primaryAction: '設定を更新する',
  states: [
    {
      id: 'forbidden',
      description: 'Settings content error (403)',
      expectedStatus: 403,
      expectedError: 'settings-error-boundary',
      setup: {
        scenario: 'settings-general/forbidden',
        ready: {
          selector:
            '[data-screen-capture-error="settings-error-boundary"] a[href="/settings"]',
          description: 'Settings recovery and navigation are visible',
          visibleWith: [
            '#app-topbar',
            'main nav a[href="/settings/billing"], main button[data-slot="sheet-trigger"]',
          ],
        },
      },
    },
    {
      id: 'not-found',
      description: 'Settings content error (404)',
      expectedStatus: 404,
      expectedError: 'settings-error-boundary',
      setup: {
        scenario: 'settings-general/not-found',
        ready: {
          selector:
            '[data-screen-capture-error="settings-error-boundary"] a[href="/settings"]',
          description: 'Settings recovery and navigation are visible',
          visibleWith: [
            '#app-topbar',
            'main nav a[href="/settings/billing"], main button[data-slot="sheet-trigger"]',
          ],
        },
      },
    },
    {
      id: 'unexpected-error',
      description: 'Settings content error (500)',
      expectedStatus: 500,
      expectedError: 'settings-error-boundary',
      setup: {
        scenario: 'settings-general/unexpected-error',
        ready: {
          selector:
            '[data-screen-capture-error="settings-error-boundary"] a[href="/settings"]',
          description: 'Settings recovery and navigation are visible',
          visibleWith: [
            '#app-topbar',
            'main nav a[href="/settings/billing"], main button[data-slot="sheet-trigger"]',
          ],
        },
      },
    },
    {
      id: 'root-error',
      description: 'Standalone root error',
      expectedStatus: 500,
      expectedError: 'route-error-boundary',
      setup: {
        scenario: 'settings-general/root-error',
        ready: {
          selector: '[data-screen-capture-error="route-error-boundary"] a',
          description: 'Home logo is visible',
        },
      },
    },
    {
      id: 'team-member-read-only',
      description: 'Role guidance for a Team member',
      setup: {
        auth: 'team-member',
        ready: {
          selector: '#name-guidance',
          description: 'Read-only guidance is visible',
        },
      },
    },
    {
      id: 'long-owner',
      description: 'Long owner name and email wrap within the phone layout',
      setup: {
        scenario: 'settings-general/long-owner',
        reseedBeforeCapture: true,
      },
    },
    {
      id: 'initial-avatar',
      description: 'initial-avatar responsive controls and content',
      setup: {
        scenario: 'settings-general/initial-avatar',
        reseedBeforeCapture: true,
      },
    },
    {
      id: 'result-success',
      description: 'Saved confirmation',
      setup: {
        query: '?status=ok',
        ready: {
          selector: '[role="status"][data-settings-status="ok"]',
          description: 'Saved confirmation',
        },
      },
    },
    {
      id: 'result-error',
      description: 'Invalid input alert',
      setup: {
        query: '?status=invalid',
        ready: {
          selector: '[role="alert"][data-settings-status="invalid"]',
          description: 'Invalid input alert',
        },
      },
    },
    {
      id: 'default',
      description: '一般設定',
      setup: {},
    },
  ],
} satisfies ScreenSpec

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  if (isDevScreenStateRequest(request, 'settings-general/forbidden'))
    throw new Response(null, { status: 403 })
  if (isDevScreenStateRequest(request, 'settings-general/not-found'))
    throw new Response(null, { status: 404 })
  if (isDevScreenStateRequest(request, 'settings-general/unexpected-error'))
    throw new Error('Settings screen fixture')
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

export default function GeneralPage({
  loaderData,
}: Pick<Route.ComponentProps, 'loaderData'>) {
  const shell = useOutletContext<SettingsLayoutContext>()
  const { t } = useT()
  const canManage = shell.currentUserIsAdmin
  return (
    <SettingsPage>
      <WorkspaceNameSection name={shell.workspace.name} canManage={canManage} />
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
  name,
  canManage,
}: {
  name: string
  canManage: boolean
}) {
  const navigation = useNavigation()
  const { t } = useT()
  const guidanceId = canManage ? undefined : 'name-guidance'
  const pending = navigation.formData?.get('intent') === 'update-workspace-name'
  return (
    <SettingsSection
      title={t('team.workspace.name')}
      description={t('team.workspace.name.body')}
      guidanceId={guidanceId}
      readOnlyGuidance={
        canManage ? undefined : t('team.workspace.name.readOnly')
      }
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
