import { useEffect, useEffectEvent, useRef, useState } from 'react'
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
  useOutletContext,
  useSearchParams,
} from 'react-router'
import { env } from 'cloudflare:workers'
import { toast } from 'sonner'
import { IconPlus, IconStack2 as Layers } from '@tabler/icons-react'
import type { Route } from './+types/projects'
import { ProjectScopeField } from '~/components/app/project-scope-field'
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { PageBreadcrumb } from '~/components/app/page-breadcrumb'
import {
  UpgradeRequestPanel,
  type UpgradeRequestView,
} from '~/components/app/upgrade-request-panel'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { useT } from '~/hooks/use-t'
import type { TKey } from '~/lib/i18n'
import { getLocale } from '~/lib/i18n.server'
import { checkUploadAccess } from '~/services/upload-access.server'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { buildUpgradeRequest } from '~/services/upgrade-request.server'
import {
  createProjectContainer,
  listSharedProjects,
  normalizeProjectDescription,
  normalizeProjectName,
  parseProjectBaseVisibility,
  type SharedProjectSummary,
} from '~/services/projects.server'
import type { HomeLayoutContext } from '../_layout'
import {
  joinProject,
  leaveProject,
  listProjectsForIndex,
} from '~/services/project-membership.server'
import { RedesignedProjectsIndex } from '../+components/projects-redesign'
import { AppEmptyState } from '~/components/app/app-empty-state'
import {
  AppPageHeader,
  AppPageHeaderActions,
  AppPageHeaderDescription,
  AppPageHeaderMain,
  AppPageHeaderTitle,
  AppPageHeaderTitleRow,
} from '~/components/app/app-page-header'

export const PROJECT_LIMIT_BILLING_DESTINATION =
  '/settings/billing?reason=project_limit'

type LoaderData = {
  sharedProjects: SharedProjectSummary[]
  rows: Awaited<ReturnType<typeof listProjectsForIndex>>
}

export async function loader({
  context,
}: Route.LoaderArgs): Promise<LoaderData> {
  const user = requireUser(context)

  const db = createDb()
  const [sharedProjects, rows] = await Promise.all([
    listSharedProjects(db, user),
    listProjectsForIndex(db, user),
  ])

  return {
    sharedProjects,
    rows,
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = requireUser(context)
  const db = createDb()

  const form = await request.formData()
  const intent = form.get('intent')
  // 参加/離脱は閲覧のみの利用者にも許すため、投稿権限のゲートより前で扱う
  if (intent === 'join-project' || intent === 'leave-project') {
    const projectId = String(form.get('projectId') ?? '')
    if (!projectId) throw new Response('Not found', { status: 404 })
    const result =
      intent === 'join-project'
        ? await joinProject(db, { containerId: projectId, user })
        : await leaveProject(db, { containerId: projectId, user })
    if (result === 'not-found') throw new Response('Not found', { status: 404 })
    return { intent, result } as const
  }
  if (intent !== 'create-project') {
    throw new Response('Unknown intent', { status: 400 })
  }
  const permission = await checkUploadAccess(user)
  if (permission.kind !== 'allowed') {
    return {
      intent: 'create-project',
      errorKey: 'project.errorCreateNotAllowed',
    } as const
  }

  const name = normalizeProjectName(form.get('name'))
  if (!name) {
    return {
      intent: 'create-project',
      errorKey: 'project.errorNameRequired',
    } as const
  }
  const description = normalizeProjectDescription(form.get('description'))
  const baseVisibility = parseProjectBaseVisibility(form.get('base_visibility'))

  const result = await createProjectContainer(db, user.workspaceId, user.id, {
    name,
    description,
    baseVisibility,
  })
  if (result.kind === 'project-limit-reached') {
    const upgradeRequest =
      result.billingWorkspaceId && result.observedPlan
        ? await buildUpgradeRequest({
            db,
            actor: {
              id: user.id,
              workspaceId: user.workspaceId,
              kind: user.kind,
            },
            billingWorkspaceId: result.billingWorkspaceId,
            limitType: 'projects',
            observedPlan: result.observedPlan,
            locale: getLocale(request, user.locale),
            appBaseUrl: env.BETTER_AUTH_URL,
          })
        : null
    const value = {
      intent: 'create-project',
      errorKey: 'project.errorProjectLimitReached',
      errorVars: { limit: result.limit },
      ...(upgradeRequest ? { upgrade_request: upgradeRequest } : {}),
    } as const
    return upgradeRequest
      ? data(value, {
          headers: { 'Cache-Control': 'private, no-store' },
        })
      : value
  }
  return redirect(`/projects/${result.id}`)
}

export default function ProjectsIndex({ loaderData }: Route.ComponentProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [createErrorVisible, setCreateErrorVisible] = useState(true)
  const actionData = useActionData<typeof action>()
  const navigation = useNavigation()
  const { t } = useT()
  // useT の t は render ごとに新しくなるため deps に入れると再発火する。
  const announceSlackError = useEffectEvent(() => {
    toast.error(t('project.slack.error'))
    setSearchParams(
      (current) => {
        current.delete('slack')
        return current
      },
      { replace: true },
    )
  })
  const slackStatus = searchParams.get('slack')
  useEffect(() => {
    if (slackStatus === 'error') announceSlackError()
  }, [slackStatus])
  const layoutData = useOutletContext<HomeLayoutContext>()
  const workspaceName = layoutData.signedIn ? layoutData.workspaceName : '—'
  const { sharedProjects } = loaderData
  const hasShared = sharedProjects.length > 0
  const createErrorKey =
    actionData?.intent === 'create-project' ? actionData.errorKey : null
  const createErrorVars =
    actionData?.intent === 'create-project' && 'errorVars' in actionData
      ? actionData.errorVars
      : undefined
  const upgradeRequest =
    actionData?.intent === 'create-project' && 'upgrade_request' in actionData
      ? (actionData.upgrade_request as UpgradeRequestView)
      : null

  useEffect(() => {
    if (
      navigation.state !== 'idle' &&
      navigation.formData?.get('intent') === 'create-project'
    ) {
      setCreateErrorVisible(true)
    }
  }, [navigation.formData, navigation.state])

  const handleCreateOpenChange = (open: boolean) => {
    setCreateProjectOpen(open)
    if (!open) setCreateErrorVisible(false)
  }

  return (
    <>
      <PageBreadcrumb aria-label={t('project.location')}>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">{t('tb.home')}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{t('project.projects')}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </PageBreadcrumb>
      <AppPageHeader as="section">
        <AppPageHeaderMain>
          <AppPageHeaderTitleRow>
            <AppPageHeaderTitle>{t('project.projects')}</AppPageHeaderTitle>
          </AppPageHeaderTitleRow>
          <AppPageHeaderDescription>
            {t('project.workspaceNote', { workspaceName })}
          </AppPageHeaderDescription>
        </AppPageHeaderMain>
        <AppPageHeaderActions>
          <Button
            type="button"
            size="sm"
            onClick={() => setCreateProjectOpen(true)}
          >
            <IconPlus size={14} aria-hidden="true" />
            {t('project.create')}
          </Button>
        </AppPageHeaderActions>
      </AppPageHeader>
      {loaderData.rows.length === 0 && !hasShared ? (
        <AppEmptyState
          icon={<Layers size={16} />}
          title={t('project.emptyTitle')}
          body={t('project.emptyBody')}
        />
      ) : (
        <RedesignedProjectsIndex
          rows={loaderData.rows}
          sharedProjects={sharedProjects}
        />
      )}

      <ProjectDialog
        open={createProjectOpen}
        onOpenChange={handleCreateOpenChange}
        workspaceName={workspaceName}
        errorKey={createErrorVisible ? createErrorKey : null}
        errorVars={createErrorVisible ? createErrorVars : undefined}
        upgradeRequest={createErrorVisible ? upgradeRequest : null}
      />
    </>
  )
}

function ProjectDialog({
  open,
  onOpenChange,
  workspaceName,
  errorKey,
  errorVars,
  upgradeRequest,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceName: string
  errorKey: TKey | null
  errorVars?: Record<string, string | number>
  upgradeRequest: UpgradeRequestView | null
}) {
  const navigation = useNavigation()
  const { t } = useT()
  const saving = navigation.state !== 'idle'

  // The description is optional, so it stays hidden behind a link until asked for.
  const [showDescription, setShowDescription] = useState(false)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setShowDescription(false)
    onOpenChange(nextOpen)
  }

  const handleAddDescription = () => {
    setShowDescription(true)
    requestAnimationFrame(() => descriptionRef.current?.focus())
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('project.createTitle')}</DialogTitle>
          <DialogDescription>
            {t('project.createDescription', { workspaceName })}
          </DialogDescription>
        </DialogHeader>
        <Form method="post">
          <input type="hidden" name="intent" value="create-project" />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-name">
                {t('project.name')}
              </FieldLabel>
              <Input id="project-name" name="name" required maxLength={120} />
            </Field>

            {showDescription ? (
              <Field>
                <FieldLabel htmlFor="project-description">
                  {t('project.description')}
                </FieldLabel>
                <Textarea
                  id="project-description"
                  ref={descriptionRef}
                  name="description"
                  rows={4}
                  maxLength={500}
                />
              </Field>
            ) : (
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleAddDescription}
                >
                  <IconPlus aria-hidden="true" />
                  {t('project.addDescription')}
                </Button>
              </div>
            )}

            <ProjectScopeField />

            {errorKey && upgradeRequest ? (
              <UpgradeRequestPanel
                request={upgradeRequest}
                existingErrorLine={t(errorKey, errorVars)}
              />
            ) : errorKey ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {t(errorKey, errorVars)}
                  {errorKey === 'project.errorProjectLimitReached' ? (
                    <>
                      {' '}
                      <Link
                        to={PROJECT_LIMIT_BILLING_DESTINATION}
                        className="underline"
                      >
                        {t('project.errorProjectLimitBillingLink')}
                      </Link>
                    </>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
              >
                {t('project.cancel')}
              </Button>
              <Button type="submit" disabled={saving}>
                {t('project.create')}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
