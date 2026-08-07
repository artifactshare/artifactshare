import { useState } from 'react'
import {
  Form,
  redirect,
  useNavigation,
  useOutletContext,
  useSearchParams,
} from 'react-router'
import type { Route } from './+types/external-access'
import type { SettingsLayoutContext } from './_layout'
import { Button } from '~/components/ui/button'
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
  updateWorkspaceExternalAccessPolicy,
} from '~/services/link-sharing.server'

export async function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const policy = await loadWorkspaceLinkPolicy(createDb(), user.workspaceId)
  if (!policy) throw new Response('Not found', { status: 404 })
  return { policy }
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = requireUser(context)
  const form = await request.formData()
  if (stringValue(form.get('intent')) !== 'update-external-access') {
    return redirect('/settings/external-access?status=invalid')
  }

  const defaultUnlimited = form.get('defaultUnlimited') === 'true'
  const maxUnlimited = form.get('maxUnlimited') === 'true'
  const defaultDays = defaultUnlimited
    ? null
    : parseDays(form.get('defaultDays'))
  const maxDays = maxUnlimited ? null : parseDays(form.get('maxDays'))
  if (defaultDays === undefined || maxDays === undefined) {
    return redirect('/settings/external-access?status=invalid')
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
  const result = await updateWorkspaceExternalAccessPolicy(
    createDb(),
    user,
    patch,
  )
  if (result.kind !== 'ok') {
    return redirect(`/settings/external-access?status=${result.kind}`)
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
}: Route.ComponentProps) {
  const { policy } = loaderData
  const shell = useOutletContext<SettingsLayoutContext>()
  const { t } = useT()
  const navigation = useNavigation()
  const [searchParams] = useSearchParams()
  const pending = navigation.state !== 'idle'
  const canEditSwitches = policy.plan === 'team' && shell.currentUserIsAdmin
  const canEditExpiry =
    (policy.plan === 'plus' && shell.currentUserRole === 'owner') ||
    (policy.plan === 'team' && shell.currentUserIsAdmin)
  const canEdit = canEditSwitches || canEditExpiry
  const [defaultUnlimited, setDefaultUnlimited] = useFormCheckbox(
    policy.linkExpiryDefaultDays === null,
  )
  const [maxUnlimited, setMaxUnlimited] = useFormCheckbox(
    policy.linkExpiryMaxDays === null,
  )
  const shortened = searchParams.get('shortened')

  return (
    <SettingsPage>
      <Form method="post" className="gap-section flex flex-col">
        <input type="hidden" name="intent" value="update-external-access" />
        <SettingsSection
          title={t('externalAccess.title')}
          description={t('externalAccess.body')}
        >
          <div className="gap-field flex flex-col">
            <div className="border-divider flex items-start justify-between gap-4 border-b pb-3">
              <div>
                <h3 className="m-0 text-sm font-semibold">
                  {t('externalAccess.plan')}
                </h3>
                <TeamMutedParagraph className="m-0">
                  {t(`externalAccess.plan.${policy.plan}`)}
                </TeamMutedParagraph>
              </div>
              <span className="bg-muted rounded-full px-2 py-1 text-xs font-semibold">
                {t(`externalAccess.planLabel.${policy.plan}`)}
              </span>
            </div>

            {policy.plan === 'plus' ? (
              <>
                <PlusPolicyStatus
                  kind="linkSharing"
                  enabled={policy.linkSharingEnabled}
                  canResume={shell.currentUserRole === 'owner'}
                  pending={pending}
                  t={t}
                />
                <PlusPolicyStatus
                  kind="externalPosting"
                  enabled={policy.externalPostingEnabled}
                  canResume={shell.currentUserRole === 'owner'}
                  pending={pending}
                  t={t}
                />
              </>
            ) : (
              <>
                <PolicyToggle
                  name="linkSharingEnabled"
                  checked={policy.linkSharingEnabled}
                  disabled={!canEditSwitches || pending}
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
                  checked={policy.externalPostingEnabled}
                  disabled={!canEditSwitches || pending}
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

        <SettingsSection
          title={t('externalAccess.expiry.title')}
          description={t('externalAccess.expiry.body')}
        >
          <div className="gap-field flex flex-col">
            <SettingsSubsection title={t('externalAccess.expiry.default')}>
              <div className="max-stack:flex-col gap-inline flex items-start">
                <Input
                  name="defaultDays"
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  defaultValue={policy.linkExpiryDefaultDays ?? ''}
                  disabled={!canEditExpiry || pending || defaultUnlimited}
                  required={!defaultUnlimited}
                  aria-label={t('externalAccess.expiry.default')}
                />
                <span className="text-muted-foreground pt-1.5 text-sm">
                  {t('externalAccess.expiry.days')}
                </span>
                {maxUnlimited ? (
                  <label className="flex items-center gap-2 pt-1.5 text-sm">
                    <input
                      type="checkbox"
                      name="defaultUnlimited"
                      value="true"
                      checked={defaultUnlimited}
                      disabled={!canEditExpiry || pending}
                      onChange={(event) =>
                        setDefaultUnlimited(event.currentTarget.checked)
                      }
                    />
                    {t('externalAccess.expiry.unlimited')}
                  </label>
                ) : null}
              </div>
            </SettingsSubsection>
            <SettingsSubsection title={t('externalAccess.expiry.max')}>
              <div className="max-stack:flex-col gap-inline flex items-start">
                <Input
                  name="maxDays"
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  defaultValue={policy.linkExpiryMaxDays ?? ''}
                  disabled={!canEditExpiry || pending || maxUnlimited}
                  required={!maxUnlimited}
                  aria-label={t('externalAccess.expiry.max')}
                />
                <span className="text-muted-foreground pt-1.5 text-sm">
                  {t('externalAccess.expiry.days')}
                </span>
                <label className="flex items-center gap-2 pt-1.5 text-sm">
                  <input
                    type="checkbox"
                    name="maxUnlimited"
                    value="true"
                    checked={maxUnlimited}
                    disabled={!canEditExpiry || pending}
                    onChange={(event) => {
                      setMaxUnlimited(event.currentTarget.checked)
                      if (!event.currentTarget.checked)
                        setDefaultUnlimited(false)
                    }}
                  />
                  {t('externalAccess.expiry.unlimited')}
                </label>
              </div>
            </SettingsSubsection>
            {shortened ? (
              <TeamMutedParagraph role="status">
                {t('externalAccess.expiry.shortened', { count: shortened })}
              </TeamMutedParagraph>
            ) : null}
            {canEdit ? (
              <div>
                <Button type="submit" size="sm" disabled={pending}>
                  {t('externalAccess.save')}
                </Button>
              </div>
            ) : null}
          </div>
        </SettingsSection>
      </Form>
    </SettingsPage>
  )
}

function PlusPolicyStatus({
  kind,
  enabled,
  canResume,
  pending,
  t,
}: {
  kind: 'linkSharing' | 'externalPosting'
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
          {t(
            enabled
              ? `externalAccess.${kind}.plus`
              : `externalAccess.${kind}.plusDisabled`,
          )}
        </span>
      </span>
      {!enabled && canResume ? (
        <Button
          type="submit"
          name="resume"
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

function useFormCheckbox(initial: boolean) {
  const [checked, setChecked] = useState(initial)
  return [checked, setChecked] as const
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
}: {
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
      <input
        type="checkbox"
        name={name}
        value="true"
        defaultChecked={checked}
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
