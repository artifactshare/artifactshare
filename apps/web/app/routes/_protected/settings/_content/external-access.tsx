import { data } from 'react-router'
import type { Route } from './+types/external-access'
import {
  confirmationResult,
  runConfirmedMutation,
} from '~/lib/settings-confirmation'
import { stringValue } from '~/lib/form'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  loadWorkspaceLinkPolicy,
  previewWorkspaceExternalAccessPolicy,
  updateWorkspaceExternalAccessPolicy,
} from '~/services/link-sharing.server'
import { normalizeWorkspaceLinkPolicy } from '~/lib/link-sharing-policy'
import {
  settingsShellLoads,
  settingsWorkspace,
} from '../+lib/settings-request.server'
import ExternalAccessPage, {
  parseDays,
  type ExternalAccessLoaderData,
} from '../+components/external-access-page'

// React Router passes loaderData only to a default export declared here.
export default ExternalAccessPage

// With the shell running in this request, the policy comes from the same
// workspace read; a policy refresh on its own uses the feature reader.
export async function loader({
  context,
  request,
}: Route.LoaderArgs): Promise<ExternalAccessLoaderData> {
  const user = requireUser(context)
  const policy = settingsShellLoads(request)
    ? normalizeWorkspaceLinkPolicy(await settingsWorkspace(context))
    : await loadWorkspaceLinkPolicy(createDb(), user.workspaceId)
  if (!policy) throw new Response('Not found', { status: 404 })
  return { policy }
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData()
  const mutate = () => submitPolicy(context, form)
  return form.has('confirmedMaximum') ? runConfirmedMutation(mutate) : mutate()
}

export async function clientAction({
  request,
  serverAction,
}: Route.ClientActionArgs) {
  const form = await request.clone().formData()
  return form.get('intent') === 'update-external-access' &&
    form.has('confirmedMaximum')
    ? confirmationResult('update-external-access', serverAction)
    : serverAction()
}

async function submitPolicy(
  context: Route.ActionArgs['context'],
  form: FormData,
) {
  const user = requireUser(context)
  const intent = stringValue(form.get('intent')) ?? ''
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
  function failure(code: string) {
    return data(
      { ok: false as const, code, intent, draft },
      {
        status:
          code === 'forbidden' || code === 'plan-required'
            ? 403
            : code === 'not-found'
              ? 404
              : 400,
      },
    )
  }
  if (
    intent !== 'update-external-access' &&
    intent !== 'preview-external-access'
  ) {
    return failure('invalid')
  }

  const defaultUnlimited = form.get('defaultUnlimited') === 'true'
  const maxUnlimited = form.get('maxUnlimited') === 'true'
  const defaultDays = defaultUnlimited
    ? null
    : parseDays(form.get('defaultDays'))
  const maxDays = maxUnlimited ? null : parseDays(form.get('maxDays'))
  if (defaultDays === undefined || maxDays === undefined) {
    return failure('invalid-policy')
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
  if (preview.kind !== 'preview') return failure(preview.kind)
  if (
    intent === 'preview-external-access' ||
    (preview.maximumDays !== null &&
      (preview.previousMaximumDays === null ||
        preview.maximumDays < preview.previousMaximumDays) &&
      (form.get('confirmedPreviousMaximum') !==
        String(preview.previousMaximumDays) ||
        form.get('confirmedMaximum') !== String(preview.maximumDays)))
  ) {
    const { kind, ...details } = preview
    return data(
      { ok: true as const, code: kind, intent, ...details, draft, resume },
      { status: 200 },
    )
  }
  const result = await updateWorkspaceExternalAccessPolicy(
    createDb(),
    user,
    patch,
  )
  if (result.kind !== 'ok') {
    return failure(result.kind)
  }
  return data(
    {
      ok: true as const,
      code: 'ok' as const,
      intent,
      shortenedLinkCount: result.shortenedLinkCount,
      policy: result.policy,
    },
    { status: 200 },
  )
}

function hasFormField(form: FormData, name: string): boolean {
  return form.getAll(name).length > 0
}
