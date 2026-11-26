import { useId, useState, useEffect, type ComponentProps } from 'react'
import {
  Link,
  useFetcher,
  useLocation,
  useActionData,
  useOutletContext,
} from 'react-router'
import type { action } from '../_content/external-access'
import type { SettingsLayoutContext } from '../_layout'
import { ConfirmActionDialog } from './confirm-action-dialog'
import { StatusBanner, SettingsBanner, settingsNotice } from './settings-banner'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsSection } from '~/components/form/settings-section'
import { SettingsSubsection } from '~/components/form/settings-subsection'
import { TeamMutedParagraph } from '~/components/form/team-muted'
import { useT } from '~/hooks/use-t'
import { stringValue } from '~/lib/form'
import type { WorkspaceLinkPolicy } from '~/lib/link-sharing-policy'

export interface ExternalAccessLoaderData {
  policy: WorkspaceLinkPolicy
}

export function parseDays(
  value: FormDataEntryValue | null,
): number | undefined {
  const raw = stringValue(value)
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const days = Number(raw)
  return Number.isSafeInteger(days) ? days : undefined
}

export default function ExternalAccessPage({
  loaderData,
}: {
  loaderData: ExternalAccessLoaderData
}) {
  const location = useLocation()
  return <ExternalAccessForm key={location.key} policy={loaderData.policy} />
}

function ExternalAccessForm({ policy }: { policy: WorkspaceLinkPolicy }) {
  const shell = useOutletContext<SettingsLayoutContext>()
  const { t } = useT()
  const submission = useExternalAccessSubmission(policy.linkExpiryMaxDays)
  const { save, pending, previewResult, failure, formFailure } = submission
  const [draft, setDraft] = useExternalAccessDraft(policy)
  const saved = submission.saved
  useEffect(() => {
    if (saved) setDraft(policyDraft(saved.policy))
  }, [saved, setDraft])
  const canEditSwitches = policy.plan === 'team' && shell.currentUserIsAdmin
  const canEditExpiry =
    policy.plan === 'team'
      ? shell.currentUserIsAdmin
      : shell.currentUserRole === 'owner'
  const expiryDisabled = !canEditExpiry || pending
  const canEdit = canEditSwitches || canEditExpiry
  const shortened = saved?.shortenedLinkCount ?? 0
  const dirty = externalAccessDraftIsDirty(draft, policy)
  const banner = (code: typeof formFailure) =>
    code ? (
      <SettingsBanner kind="error">
        {t(settingsNotice(code).message)}
      </SettingsBanner>
    ) : null
  const error = banner(failure)

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
        {previewResult === null ? banner(formFailure) : null}
        {saved && <StatusBanner status={saved.code} />}
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
      fallbackFocusId="save-external-access"
      awaitResult
      destructive={(receivedPreview?.shortenedLinkCount ?? 0) > 0}
      onOpenChange={(open) => {
        if (!open) submission.dismiss()
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
      result={error}
      onConfirm={submission.confirm}
    />
  )
}

function resumeGuidanceKey(policy: WorkspaceLinkPolicy, isOwner: boolean) {
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
  policy: WorkspaceLinkPolicy
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

type PolicySubmission = ReturnType<typeof useFetcher<typeof action>>
type PolicyResult = PolicySubmission['data']

function policyPreview(result: PolicyResult) {
  return result?.ok && result.code === 'preview' ? result : null
}

function previewDraft(preview: ReturnType<typeof policyPreview>) {
  if (!preview) return null
  const form = new FormData()
  for (const [key, value] of Object.entries(preview.draft))
    form.set(key, String(value))
  form.set('intent', 'update-external-access')
  if (preview.resume) form.set('resume', preview.resume)
  return form
}

function expiryPreviewRequired(form: FormData, previous: number | null) {
  const maximum =
    form.get('maxUnlimited') === 'true' ? null : parseDays(form.get('maxDays'))
  return maximum !== undefined && isExpiryReduction(maximum, previous)
}

function submissionOutcome(result: PolicyResult) {
  return {
    saved: result?.ok && result.code === 'ok' ? result : undefined,
    failure: result && !result.ok ? result.code : null,
  }
}

function requiresAutomaticSave(
  preview: ReturnType<typeof policyPreview>,
  draft: FormData | null,
) {
  return Boolean(
    draft &&
    preview &&
    !isExpiryReduction(preview.maximumDays, preview.previousMaximumDays),
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
  const initialPreview = policyPreview(nativeResult)
  const [submittedDraft, setSubmittedDraft] = useState(() =>
    previewDraft(initialPreview),
  )
  const active = lastOperation.kind === 'preview' ? preview : save
  const [receivedPreview, setReceivedPreview] = useState(initialPreview)
  // Redirects retain fetcher data; only a new result belongs to this submission.
  const currentResult =
    (active.state === 'idle' ||
      (lastOperation.kind === 'preview' && active.state === 'loading')) &&
    active.data !== lastOperation.previousData
      ? active.data
      : undefined
  const readyPreview = policyPreview(currentResult)
  const autoSavePending = requiresAutomaticSave(readyPreview, submittedDraft)
  const pending =
    save.state !== 'idle' ||
    preview.state === 'submitting' ||
    autoSavePending ||
    (lastOperation.kind === 'save' && submittedDraft !== null && !currentResult)
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
  const settled = lastOperation.kind === 'native' ? nativeResult : currentResult
  const { saved, failure } = submissionOutcome(settled)
  const [dismissedResult, setDismissedResult] = useState<typeof settled>()
  const formFailure = settled === dismissedResult ? undefined : failure
  const previewResult = submittedDraft && !saved ? receivedPreview : null
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
    setReceivedPreview(null)
    setSubmittedDraft(form)
    if (expiryPreviewRequired(form, maximumDays)) {
      const request = new FormData()
      for (const [key, value] of form) request.append(key, value)
      request.set('intent', 'preview-external-access')
      setLastOperation({ kind: 'preview', previousData: preview.data })
      void preview.submit(request, { method: 'post' })
    } else {
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
    saved,
    failure,
    formFailure,
    submit,
    confirm,
    clearPreview: () => {
      // Keep the last preview visible through the dialog exit animation.
      // submittedDraft alone controls whether it is open and confirmable.
      setSubmittedDraft(null)
    },
    // Dismissing the confirmation ends that attempt. Its failure stays in
    // the closing dialog and is not moved to the form.
    dismiss: () => {
      setSubmittedDraft(null)
      setDismissedResult(settled)
    },
  }
}

function useExternalAccessDraft(policy: WorkspaceLinkPolicy) {
  const actionData = useActionData<typeof action>()
  return useState({
    ...policyDraft(policy),
    ...(actionData && 'draft' in actionData ? actionData.draft : {}),
  })
}

function policyDraft(policy: WorkspaceLinkPolicy) {
  return {
    linkSharingEnabled: policy.linkSharingEnabled,
    externalPostingEnabled: policy.externalPostingEnabled,
    defaultDays: String(policy.linkExpiryDefaultDays ?? ''),
    maxDays: String(policy.linkExpiryMaxDays ?? ''),
    defaultUnlimited: policy.linkExpiryDefaultDays === null,
    maxUnlimited: policy.linkExpiryMaxDays === null,
  }
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
  policy: WorkspaceLinkPolicy,
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
  shortened: number
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
        {shortened > 0 ? (
          <TeamMutedParagraph role="status" data-shortened-links>
            {tPlural('externalAccess.expiry.shortened', shortened)}
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
