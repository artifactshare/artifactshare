import { useId, useState, useEffect, type ComponentProps } from 'react'
import {
  Link,
  useFetcher,
  useActionData,
  useLocation,
  redirect,
  useOutletContext,
  useSearchParams,
} from 'react-router'
import type { Route } from './+types/external-access'
import type { SettingsLayoutContext } from '../_layout'
import { ConfirmActionDialog } from '../+components/confirm-action-dialog'
import { SettingsBanner, settingsNotice } from '../+components/settings-banner'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsSection } from '~/components/form/settings-section'
import { SettingsSubsection } from '~/components/form/settings-subsection'
import { TeamMutedParagraph } from '~/components/form/team-muted'
import { useT } from '~/hooks/use-t'
import { stringValue } from '~/lib/form'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  loadWorkspaceLinkPolicy,
  previewWorkspaceExternalAccessPolicy,
  updateWorkspaceExternalAccessPolicy,
} from '~/services/link-sharing.server'
import type { ScreenSpec } from '~/types/screen'

export const screen = {
  id: 'settings-external-access',
  route: {
    en: '/settings/external-access',
  },
  auth: 'team-owner',
  loop: 'share',
  metric: '安全な外部共有を支える',
  role: '外部アクセスを管理する',
  primaryAction: 'アクセスを設定する',
  states: [
    {
      id: 'team-member-read-only',
      description: 'Role guidance for a Team member',
      setup: {
        auth: 'team-member',
        ready: {
          selector: '#expiry-guidance',
          description: 'Read-only guidance is visible',
        },
      },
    },
    {
      id: 'no-expiration',
      description: 'Unlimited default and maximum expiry',
      setup: {
        scenario: 'settings-external-access/unlimited',
        reseedBeforeCapture: true,
        interactions: [
          {
            action: 'click',
            selector:
              'button[data-policy-control="defaultUnlimited"][data-slot="checkbox"]',
          },
        ],
      },
    },
    {
      id: 'finite',
      description: 'Finite expiry inputs with adjacent day units',
      setup: {
        scenario: 'settings-external-access/finite',
        reseedBeforeCapture: true,
      },
    },
    {
      id: 'unlimited',
      description: 'Unlimited maximum expiry with a finite default',
      setup: {
        scenario: 'settings-external-access/unlimited',
        reseedBeforeCapture: true,
      },
    },
    {
      id: 'reduction-success',
      description:
        'Saved policy notice and the count of existing links shortened',
      setup: {
        scenario: 'settings-external-access/finite',
        reseedBeforeCapture: true,
        query: '?status=ok&shortened=1',
      },
    },
    {
      id: 'dirty',
      description:
        'Edited external-sharing toggle with unsaved changes beside the controls and save action',
      setup: {
        scenario: 'settings-external-access/finite',
        reseedBeforeCapture: true,
        interactions: [
          {
            action: 'click',
            selector:
              'button[data-policy-control="linkSharingEnabled"][data-slot="checkbox"]',
          },
        ],
      },
    },
    {
      id: 'external-save-failed',
      description:
        'Save failure alert with the edited external-sharing policy retained',
      setup: {
        scenario: 'settings-external-access/finite',
        reseedBeforeCapture: true,
        interactions: [
          {
            action: 'click',
            selector:
              'button[data-policy-control="linkSharingEnabled"][data-slot="checkbox"]',
          },
          {
            action: 'click',
            selector: 'button:text-is("Save changes")',
            readySelector: '[role="alert"]',
          },
        ],
        actionResponse: {
          route: '/settings/external-access',
          method: 'POST',
          intent: 'update-external-access',
          data: { kind: 'forbidden' },
        },
      },
    },
    {
      id: 'finite-reduction',
      description:
        'Confirmation showing the affected links when reducing a finite maximum',
      setup: {
        scenario: 'settings-external-access/finite',
        reseedBeforeCapture: true,
        interactions: [
          { action: 'fill', selector: 'input[name="maxDays"]', value: '30' },
          {
            action: 'click',
            selector: 'button:text-is("Save changes")',
            readySelector: '[role="alertdialog"]',
          },
        ],
      },
    },
    {
      id: 'reduction-pending',
      description:
        'Expiry confirmation stays open while the policy save is running',
      setup: {
        scenario: 'settings-external-access/finite',
        reseedBeforeCapture: true,
        actionResponse: {
          route: '/settings/external-access',
          method: 'POST',
          intent: 'update-external-access',
          pending: true,
        },
        interactions: [
          { action: 'fill', selector: 'input[name="maxDays"]', value: '30' },
          {
            action: 'click',
            selector: 'button:text-is("Save changes")',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Save changes")',
            readySelector:
              '[role="alertdialog"] button:disabled[aria-busy="true"]:text-is("Saving…")',
          },
        ],
      },
    },
    {
      id: 'reduction-failed',
      description:
        'Expiry save failure remains inside the confirmation with edits retained',
      setup: {
        scenario: 'settings-external-access/finite',
        reseedBeforeCapture: true,
        actionResponse: {
          route: '/settings/external-access',
          method: 'POST',
          intent: 'update-external-access',
          data: { kind: 'forbidden' },
        },
        interactions: [
          { action: 'fill', selector: 'input[name="maxDays"]', value: '30' },
          {
            action: 'click',
            selector: 'button:text-is("Save changes")',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Save changes")',
            readySelector: '[role="alertdialog"] [role="alert"]',
          },
        ],
      },
    },
    {
      id: 'unlimited-reduction',
      description:
        'Confirmation of a finite maximum replacing unlimited link expiration',
      setup: {
        scenario: 'settings-external-access/unlimited',
        reseedBeforeCapture: true,
        interactions: [
          {
            action: 'click',
            selector:
              'button[data-policy-control="maxUnlimited"][data-slot="checkbox"]',
          },
          { action: 'fill', selector: 'input[name="maxDays"]', value: '30' },
          {
            action: 'click',
            selector: 'button:text-is("Save changes")',
            readySelector: '[role="alertdialog"]',
          },
        ],
      },
    },
    {
      id: 'zero-reduction',
      description: 'Lower maximum confirmation with no existing links affected',
      setup: {
        scenario: 'settings-external-access/zero',
        reseedBeforeCapture: true,
        interactions: [
          { action: 'fill', selector: 'input[name="maxDays"]', value: '30' },
          {
            action: 'click',
            selector: 'button:text-is("Save changes")',
            readySelector: '[role="alertdialog"]',
          },
        ],
      },
    },
    {
      id: 'preview-failed',
      description:
        'Refused expiry count request displays an error without opening confirmation',
      setup: {
        scenario: 'settings-external-access/finite',
        reseedBeforeCapture: true,
        actionResponse: {
          route: '/settings/external-access',
          method: 'POST',
          intent: 'preview-external-access',
          data: { kind: 'forbidden' },
        },
        interactions: [
          { action: 'fill', selector: 'input[name="maxDays"]', value: '30' },
          {
            action: 'click',
            selector: 'button:text-is("Save changes")',
            readySelector: '[role="alert"]',
          },
        ],
      },
    },
    {
      id: 'default',
      description: '外部アクセス',
      setup: {},
    },
    {
      id: 'free-owner',
      description: 'Free プランのオーナーがリンク共有と期限の設定を見る状態',
      setup: {
        auth: 'free-owner',
      },
    },
  ],
} satisfies ScreenSpec

export async function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const policy = await loadWorkspaceLinkPolicy(createDb(), user.workspaceId)
  if (!policy) throw new Response('Not found', { status: 404 })
  return { policy }
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = requireUser(context)
  const form = await request.formData()
  const intent = stringValue(form.get('intent'))
  const draft = {
    defaultDays: stringValue(form.get('defaultDays')) ?? '',
    maxDays: stringValue(form.get('maxDays')) ?? '',
    defaultUnlimited: form.get('defaultUnlimited') === 'true',
    maxUnlimited: form.get('maxUnlimited') === 'true',
    ...(hasFormField(form, 'linkSharingEnabled') && {
      linkSharingEnabled: form.getAll('linkSharingEnabled').includes('true'),
    }),
    ...(hasFormField(form, 'externalPostingEnabled') && {
      externalPostingEnabled: form
        .getAll('externalPostingEnabled')
        .includes('true'),
    }),
  }
  if (
    intent !== 'update-external-access' &&
    intent !== 'preview-external-access'
  ) {
    return { kind: 'invalid' as const, draft }
  }

  const defaultUnlimited = form.get('defaultUnlimited') === 'true'
  const maxUnlimited = form.get('maxUnlimited') === 'true'
  const defaultDays = defaultUnlimited
    ? null
    : parseDays(form.get('defaultDays'))
  const maxDays = maxUnlimited ? null : parseDays(form.get('maxDays'))
  if (defaultDays === undefined || maxDays === undefined) {
    return { kind: 'invalid-policy' as const, draft }
  }

  const resume = stringValue(form.get('resume'))
  const patch = {
    linkExpiryDefaultDays: defaultDays,
    linkExpiryMaxDays: maxDays,
    ...(hasFormField(form, 'linkSharingEnabled') && {
      linkSharingEnabled: form
        .getAll('linkSharingEnabled')
        .some((value) => value === 'true'),
    }),
    ...(hasFormField(form, 'externalPostingEnabled') && {
      externalPostingEnabled: form
        .getAll('externalPostingEnabled')
        .some((value) => value === 'true'),
    }),
    ...(resume === 'linkSharing' && { linkSharingEnabled: true }),
    ...(resume === 'externalPosting' && { externalPostingEnabled: true }),
  }
  const preview = await previewWorkspaceExternalAccessPolicy(
    createDb(),
    user,
    patch,
  )
  if (preview.kind !== 'preview') return { ...preview, draft }
  if (
    intent === 'preview-external-access' ||
    (preview.maximumDays !== null &&
      (preview.previousMaximumDays === null ||
        preview.maximumDays < preview.previousMaximumDays) &&
      (form.get('confirmedPreviousMaximum') !==
        String(preview.previousMaximumDays) ||
        form.get('confirmedMaximum') !== String(preview.maximumDays)))
  ) {
    return { ...preview, draft, resume }
  }
  const result = await updateWorkspaceExternalAccessPolicy(
    createDb(),
    user,
    patch,
  )
  if (result.kind !== 'ok') {
    return { ...result, draft }
  }
  const shortened =
    result.shortenedLinkCount > 0
      ? `&shortened=${result.shortenedLinkCount}`
      : ''
  return redirect(`/settings/external-access?status=ok${shortened}`)
}

function parseDays(value: FormDataEntryValue | null): number | undefined {
  const raw = stringValue(value)
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const days = Number(raw)
  return Number.isSafeInteger(days) ? days : undefined
}

function hasFormField(form: FormData, name: string): boolean {
  return form.getAll(name).length > 0
}

export default function ExternalAccessPage({
  loaderData,
}: Pick<Route.ComponentProps, 'loaderData'>) {
  const location = useLocation()
  return <ExternalAccessForm key={location.key} policy={loaderData.policy} />
}

function ExternalAccessForm({
  policy,
}: {
  policy: Route.ComponentProps['loaderData']['policy']
}) {
  const shell = useOutletContext<SettingsLayoutContext>()
  const { t } = useT()
  const submission = useExternalAccessSubmission(policy.linkExpiryMaxDays)
  const { save, pending, previewResult, failure } = submission
  const [draft, setDraft] = useExternalAccessDraft(policy)
  const [searchParams] = useSearchParams()
  const canEditSwitches = policy.plan === 'team' && shell.currentUserIsAdmin
  const canEditExpiry =
    policy.plan === 'team'
      ? shell.currentUserIsAdmin
      : shell.currentUserRole === 'owner'
  const expiryDisabled = !canEditExpiry || pending
  const canEdit = canEditSwitches || canEditExpiry
  const shortened = searchParams.get('shortened')
  const dirty = externalAccessDraftIsDirty(draft, policy)
  const error = failure ? (
    <SettingsBanner kind="error">
      {t(settingsNotice(failure).message)}
    </SettingsBanner>
  ) : null

  return (
    <SettingsPage>
      <save.Form
        method="post"
        className="gap-section flex flex-col"
        onChange={submission.clearPreview}
        onSubmit={submission.submit}
      >
        <input type="hidden" name="intent" value="update-external-access" />
        <ExternalAccessPolicySection
          policy={policy}
          draft={draft}
          onChange={setDraft}
          canEdit={canEdit}
          canEditSwitches={canEditSwitches}
          pending={pending}
          dirty={dirty}
          isOwner={shell.currentUserRole === 'owner'}
        />
        <ExternalAccessExpiryFields
          draft={draft}
          onChange={setDraft}
          disabled={expiryDisabled}
          guidance={
            canEditExpiry
              ? undefined
              : t(
                  policy.plan === 'team'
                    ? 'externalAccess.expiry.managerOnly'
                    : 'externalAccess.expiry.ownerOnly',
                )
          }
          shortened={shortened}
        />
        {previewResult === null ? error : null}
        {canEdit ? (
          <div className="space-y-2">
            {dirty ? (
              <p className="text-sm font-medium">
                {t('externalAccess.unsaved')}
              </p>
            ) : null}
            <Button
              id="save-external-access"
              type="submit"
              size="sm"
              disabled={pending}
            >
              {t('externalAccess.save')}
            </Button>
          </div>
        ) : null}
      </save.Form>
      <ExpiryConfirmation submission={submission} error={error} />
    </SettingsPage>
  )
}

function ExpiryConfirmation({
  submission,
  error,
}: {
  submission: ReturnType<typeof useExternalAccessSubmission>
  error: React.ReactNode
}) {
  const { t, tPlural } = useT()
  const { previewResult, receivedPreview, pending } = submission
  return (
    <ConfirmActionDialog
      open={previewResult !== null}
      returnFocusId={submission.returnFocusId}
      awaitResult
      destructive={(receivedPreview?.shortenedLinkCount ?? 0) > 0}
      onOpenChange={(open) => {
        if (!open) submission.clearPreview()
      }}
      title={t(
        receivedPreview?.shortenedLinkCount === 0
          ? 'externalAccess.expiry.confirmZeroTitle'
          : 'externalAccess.expiry.confirmTitle',
        { days: receivedPreview?.maximumDays ?? '' },
      )}
      description={
        receivedPreview?.shortenedLinkCount === 0
          ? t('externalAccess.expiry.confirmZeroBody')
          : tPlural(
              'externalAccess.expiry.confirmBody',
              receivedPreview?.shortenedLinkCount ?? 0,
              {
                days: receivedPreview?.maximumDays ?? '',
              },
            )
      }
      action={t('externalAccess.save')}
      pendingLabel={t('externalAccess.saving')}
      dismissLabel={t('externalAccess.keepEditing')}
      pending={pending}
      result={previewResult !== null ? error : null}
      onConfirm={submission.confirm}
    />
  )
}

function resumeGuidanceKey(
  policy: Route.ComponentProps['loaderData']['policy'],
  isOwner: boolean,
) {
  if (isOwner || policy.plan === 'team') return
  if (policy.plan === 'plus' && !policy.externalPostingEnabled) {
    return policy.linkSharingEnabled
      ? 'externalAccess.resume.ownerOnly.externalPosting'
      : 'externalAccess.resume.ownerOnly.both'
  }
  if (!policy.linkSharingEnabled)
    return 'externalAccess.resume.ownerOnly.linkSharing'
}

function ExternalAccessPolicySection({
  policy,
  draft,
  onChange,
  canEdit,
  canEditSwitches,
  pending,
  dirty,
  isOwner,
}: {
  policy: Route.ComponentProps['loaderData']['policy']
  draft: ExternalAccessDraft
  onChange: (draft: ExternalAccessDraft) => void
  canEdit: boolean
  canEditSwitches: boolean
  pending: boolean
  dirty: boolean
  isOwner: boolean
}) {
  const { t } = useT()
  const switchesDisabled = !canEditSwitches || pending
  const resumeGuidance = resumeGuidanceKey(policy, isOwner)
  return (
    <SettingsSection
      title={t('externalAccess.title')}
      description={t('externalAccess.body')}
      readOnlyGuidance={resumeGuidance && t(resumeGuidance)}
    >
      {canEdit ? (
        <div className="space-y-2">
          <TeamMutedParagraph>
            {t('externalAccess.saveInstructions')}
          </TeamMutedParagraph>
          {dirty ? (
            <p role="status" className="text-sm font-medium">
              {t('externalAccess.unsaved')}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="gap-field flex flex-col">
        <div className="border-divider flex items-start justify-between gap-4 border-b pb-3">
          <div className="min-w-0">
            <h3 className="m-0 text-sm font-semibold">
              {t('externalAccess.plan')}
            </h3>
            <TeamMutedParagraph className="m-0">
              {t(`externalAccess.plan.${policy.plan}`)}
            </TeamMutedParagraph>
          </div>
          <span className="bg-muted shrink-0 rounded-full px-2 py-1 text-xs font-semibold whitespace-nowrap">
            {t(`externalAccess.planLabel.${policy.plan}`)}
          </span>
        </div>

        {policy.plan !== 'team' ? (
          <>
            <PlusPolicyStatus
              kind="linkSharing"
              plan={policy.plan}
              enabled={policy.linkSharingEnabled}
              canResume={isOwner}
              pending={pending}
              t={t}
            />
            <PlusPolicyStatus
              kind="externalPosting"
              plan={policy.plan}
              enabled={policy.externalPostingEnabled}
              canResume={policy.plan === 'plus' && isOwner}
              pending={pending}
              t={t}
            />
          </>
        ) : (
          <>
            <PolicyToggle
              name="linkSharingEnabled"
              checked={draft.linkSharingEnabled}
              onChange={(checked) =>
                onChange({ ...draft, linkSharingEnabled: checked })
              }
              disabled={switchesDisabled}
              includeHidden={canEditSwitches}
              title={t('externalAccess.linkSharing')}
              description={toggleDescription(
                policy.plan,
                'linkSharing',
                canEditSwitches,
                t,
              )}
            />
            <PolicyToggle
              name="externalPostingEnabled"
              checked={draft.externalPostingEnabled}
              onChange={(checked) =>
                onChange({ ...draft, externalPostingEnabled: checked })
              }
              disabled={switchesDisabled}
              includeHidden={canEditSwitches}
              title={t('externalAccess.externalPosting')}
              description={toggleDescription(
                policy.plan,
                'externalPosting',
                canEditSwitches,
                t,
              )}
            />
          </>
        )}
      </div>
    </SettingsSection>
  )
}

function isExpiryReduction(
  maximumDays: number | null,
  previousMaximumDays: number | null,
) {
  return (
    maximumDays !== null &&
    (previousMaximumDays === null || maximumDays < previousMaximumDays)
  )
}

function useExternalAccessSubmission(maximumDays: number | null) {
  const nativeResult = useActionData<typeof action>()
  const save = useFetcher<typeof action>()
  const preview = useFetcher<typeof action>()
  const [lastOperation, setLastOperation] = useState<{
    kind: 'native' | 'preview' | 'save'
    previousData: typeof save.data
  }>({ kind: 'native', previousData: undefined })
  const [returnFocusId, setReturnFocusId] = useState('save-external-access')
  const [submittedDraft, setSubmittedDraft] = useState<FormData | null>(() => {
    if (nativeResult?.kind !== 'preview') return null
    const form = new FormData()
    for (const [key, value] of Object.entries(nativeResult.draft))
      form.set(key, String(value))
    form.set('intent', 'update-external-access')
    if (nativeResult.resume) form.set('resume', nativeResult.resume)
    return form
  })
  const active = lastOperation.kind === 'preview' ? preview : save
  const [receivedPreview, setReceivedPreview] = useState<Extract<
    NonNullable<typeof save.data>,
    { kind: 'preview' }
  > | null>(nativeResult?.kind === 'preview' ? nativeResult : null)
  // Redirects retain fetcher data; only a new result belongs to this submission.
  const currentResult =
    active.state === 'idle' && active.data !== lastOperation.previousData
      ? active.data
      : undefined
  const readyPreview = currentResult?.kind === 'preview' ? currentResult : null
  const autoSavePending =
    submittedDraft !== null &&
    readyPreview !== null &&
    !isExpiryReduction(
      readyPreview.maximumDays,
      readyPreview.previousMaximumDays,
    )
  const pending =
    save.state !== 'idle' || preview.state !== 'idle' || autoSavePending
  useEffect(() => {
    if (readyPreview) {
      if (submittedDraft && autoSavePending) {
        setLastOperation({ kind: 'save', previousData: save.data })
        void save.submit(submittedDraft, { method: 'post' })
      } else {
        setReceivedPreview(readyPreview)
      }
    }
  }, [readyPreview, autoSavePending, submittedDraft, save])
  const previewResult = submittedDraft ? receivedPreview : null
  const fetcherFailure =
    currentResult?.kind === 'preview' ? null : currentResult?.kind
  const submit: NonNullable<ComponentProps<typeof save.Form>['onSubmit']> = (
    event,
  ) => {
    event.preventDefault()
    if (pending) return
    const form = new FormData(event.currentTarget)
    const submitter = event.nativeEvent.submitter
    if (submitter instanceof HTMLButtonElement) setReturnFocusId(submitter.id)
    if (submitter instanceof HTMLButtonElement && submitter.name)
      form.set(submitter.name, submitter.value)
    const maximum =
      form.get('maxUnlimited') === 'true'
        ? null
        : parseDays(form.get('maxDays'))
    if (maximum !== undefined && isExpiryReduction(maximum, maximumDays)) {
      setReceivedPreview(null)
      setSubmittedDraft(form)
      const request = new FormData()
      for (const [key, value] of form) request.append(key, value)
      request.set('intent', 'preview-external-access')
      setLastOperation({ kind: 'preview', previousData: preview.data })
      void preview.submit(request, { method: 'post' })
    } else {
      setReceivedPreview(null)
      setSubmittedDraft(form)
      setLastOperation({ kind: 'save', previousData: save.data })
      void save.submit(form, { method: 'post' })
    }
  }
  const confirm = () => {
    if (submittedDraft && previewResult) {
      submittedDraft.set(
        'confirmedPreviousMaximum',
        String(previewResult.previousMaximumDays),
      )
      submittedDraft.set('confirmedMaximum', String(previewResult.maximumDays))
      setLastOperation({ kind: 'save', previousData: save.data })
      void save.submit(submittedDraft, { method: 'post' })
    }
  }
  return {
    save,
    pending,
    returnFocusId,
    previewResult,
    receivedPreview,
    failure:
      lastOperation.kind === 'native' && nativeResult?.kind !== 'preview'
        ? (nativeResult?.kind ?? null)
        : fetcherFailure,
    submit,
    confirm,
    clearPreview: () => {
      // Keep the last preview visible through the dialog exit animation.
      // submittedDraft alone controls whether it is open and confirmable.
      setSubmittedDraft(null)
    },
  }
}

function useExternalAccessDraft(
  policy: Route.ComponentProps['loaderData']['policy'],
) {
  const actionData = useActionData<typeof action>()
  return useState({
    linkSharingEnabled: policy.linkSharingEnabled,
    externalPostingEnabled: policy.externalPostingEnabled,
    defaultDays: String(policy.linkExpiryDefaultDays ?? ''),
    maxDays: String(policy.linkExpiryMaxDays ?? ''),
    defaultUnlimited: policy.linkExpiryDefaultDays === null,
    maxUnlimited: policy.linkExpiryMaxDays === null,
    ...(actionData && 'draft' in actionData ? actionData.draft : {}),
  })
}

type ExternalAccessDraft = {
  linkSharingEnabled: boolean
  externalPostingEnabled: boolean
  defaultDays: string
  maxDays: string
  defaultUnlimited: boolean
  maxUnlimited: boolean
}

function externalAccessDraftIsDirty(
  draft: ExternalAccessDraft,
  policy: Route.ComponentProps['loaderData']['policy'],
) {
  return (
    draft.linkSharingEnabled !== policy.linkSharingEnabled ||
    draft.externalPostingEnabled !== policy.externalPostingEnabled ||
    (draft.defaultUnlimited ? null : Number(draft.defaultDays)) !==
      policy.linkExpiryDefaultDays ||
    (draft.maxUnlimited ? null : Number(draft.maxDays)) !==
      policy.linkExpiryMaxDays
  )
}

function ExternalAccessExpiryFields({
  draft,
  onChange,
  disabled,
  guidance,
  shortened,
}: {
  draft: ExternalAccessDraft
  onChange: (draft: ExternalAccessDraft) => void
  disabled: boolean
  guidance?: string
  shortened: string | null
}) {
  const { t, tPlural } = useT()
  const guidanceId = guidance ? 'expiry-guidance' : undefined
  const defaultExpirationUnitId = useId()
  const maximumExpirationUnitId = useId()
  return (
    <SettingsSection
      title={t('externalAccess.expiry.title')}
      description={t('externalAccess.expiry.body')}
      guidanceId={guidanceId}
      readOnlyGuidance={guidance}
    >
      <div className="gap-field flex flex-col">
        <SettingsSubsection title={t('externalAccess.expiry.default')}>
          <div className="max-stack:flex-col gap-inline flex items-start">
            <div className="gap-inline flex items-center">
              <Input
                className="w-24 flex-none"
                name="defaultDays"
                type="number"
                min={1}
                max={365}
                step={1}
                value={draft.defaultDays}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    defaultDays: event.currentTarget.value,
                  })
                }
                disabled={disabled || draft.defaultUnlimited}
                required={!draft.defaultUnlimited}
                aria-label={t('externalAccess.expiry.default')}
                aria-describedby={
                  guidanceId
                    ? `${defaultExpirationUnitId} ${guidanceId}`
                    : defaultExpirationUnitId
                }
              />
              <span
                id={defaultExpirationUnitId}
                className="text-muted-foreground text-sm"
              >
                {t('externalAccess.expiry.days')}
              </span>
            </div>
            {draft.maxUnlimited ? (
              <label className="flex items-center gap-2 pt-1.5 text-sm whitespace-nowrap">
                <Checkbox
                  name="defaultUnlimited"
                  data-policy-control="defaultUnlimited"
                  aria-describedby={guidanceId}
                  value="true"
                  checked={draft.defaultUnlimited}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onChange({
                      ...draft,
                      defaultUnlimited: checked === true,
                    })
                  }
                />
                {t('externalAccess.expiry.defaultUnlimited')}
              </label>
            ) : null}
          </div>
        </SettingsSubsection>
        <SettingsSubsection title={t('externalAccess.expiry.max')}>
          <div className="max-stack:flex-col gap-inline flex items-start">
            <div className="gap-inline flex items-center">
              <Input
                className="w-24 flex-none"
                name="maxDays"
                type="number"
                min={1}
                max={365}
                step={1}
                value={draft.maxDays}
                onChange={(event) =>
                  onChange({ ...draft, maxDays: event.currentTarget.value })
                }
                disabled={disabled || draft.maxUnlimited}
                required={!draft.maxUnlimited}
                aria-label={t('externalAccess.expiry.max')}
                aria-describedby={
                  guidanceId
                    ? `${maximumExpirationUnitId} ${guidanceId}`
                    : maximumExpirationUnitId
                }
              />
              <span
                id={maximumExpirationUnitId}
                className="text-muted-foreground text-sm"
              >
                {t('externalAccess.expiry.days')}
              </span>
            </div>
            <label className="flex items-center gap-2 pt-1.5 text-sm whitespace-nowrap">
              <Checkbox
                name="maxUnlimited"
                data-policy-control="maxUnlimited"
                aria-describedby={guidanceId}
                value="true"
                checked={draft.maxUnlimited}
                disabled={disabled}
                onCheckedChange={(checked) => {
                  onChange({
                    ...draft,
                    maxUnlimited: checked === true,
                    defaultUnlimited:
                      checked === true && draft.defaultUnlimited,
                  })
                }}
              />
              {t('externalAccess.expiry.unlimited')}
            </label>
          </div>
        </SettingsSubsection>
        {shortened !== null &&
        /^[1-9]\d*$/.test(shortened) &&
        Number.isSafeInteger(Number(shortened)) ? (
          <TeamMutedParagraph role="status">
            {tPlural('externalAccess.expiry.shortened', Number(shortened))}
          </TeamMutedParagraph>
        ) : null}
      </div>
    </SettingsSection>
  )
}

function PlusPolicyStatus({
  kind,
  plan,
  enabled,
  canResume,
  pending,
  t,
}: {
  kind: 'linkSharing' | 'externalPosting'
  plan: 'free' | 'plus'
  enabled: boolean
  canResume: boolean
  pending: boolean
  t: ReturnType<typeof useT>['t']
}) {
  return (
    <div className="border-divider flex items-start justify-between gap-3 border-b pb-3 last:border-b-0 last:pb-0">
      <span className="flex min-w-0 flex-col gap-1">
        <strong className="text-sm">{t(`externalAccess.${kind}`)}</strong>
        <span className="text-muted-foreground text-sm">
          {plan === 'free' && kind === 'externalPosting' ? (
            <Link to="/settings/billing" className="underline">
              {t('externalAccess.externalPosting.comparePlans')}
            </Link>
          ) : (
            t(
              enabled
                ? `externalAccess.${kind}.${plan}`
                : plan === 'free'
                  ? 'externalAccess.linkSharing.freeDisabled'
                  : `externalAccess.${kind}.plusDisabled`,
            )
          )}
        </span>
      </span>
      {!enabled && canResume ? (
        <Button
          type="submit"
          name="resume"
          id={`resume-${kind}`}
          value={kind}
          size="sm"
          variant="outline"
          disabled={pending}
        >
          {t(`externalAccess.${kind}.resume`)}
        </Button>
      ) : null}
    </div>
  )
}

function toggleDescription(
  plan: string,
  kind: 'linkSharing' | 'externalPosting',
  canEdit: boolean,
  t: ReturnType<typeof useT>['t'],
) {
  if (plan === 'free') {
    return t(
      kind === 'linkSharing'
        ? 'externalAccess.linkSharing.free'
        : 'externalAccess.externalPosting.free',
    )
  }
  if (plan === 'plus') {
    return t(
      kind === 'linkSharing'
        ? 'externalAccess.linkSharing.plus'
        : 'externalAccess.externalPosting.plus',
    )
  }
  return canEdit
    ? t(
        kind === 'linkSharing'
          ? 'externalAccess.linkSharing.team'
          : 'externalAccess.externalPosting.team',
      )
    : t('externalAccess.readOnly')
}

function PolicyToggle({
  name,
  checked,
  disabled,
  includeHidden,
  title,
  description,
  onChange,
}: {
  onChange: (checked: boolean) => void
  name: string
  checked: boolean
  disabled: boolean
  includeHidden: boolean
  title: string
  description: string
}) {
  return (
    <label className="border-divider flex items-start gap-3 border-b pb-3 last:border-b-0 last:pb-0">
      {includeHidden ? <input type="hidden" name={name} value="false" /> : null}
      <Checkbox
        data-policy-control={name}
        name={name}
        value="true"
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        disabled={disabled}
        className="size-4 self-start"
      />
      <span className="flex min-w-0 flex-col gap-1">
        <strong className="text-sm">{title}</strong>
        <span className="text-muted-foreground text-sm">{description}</span>
      </span>
    </label>
  )
}
