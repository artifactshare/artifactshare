import { data } from 'react-router'
import {
  confirmationResult,
  runConfirmedMutation,
} from '~/lib/settings-confirmation'
import type { Route } from './+types/tokens'
import { stringValue } from '~/lib/form'
import { requireUser } from '~/middleware/context'
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from '~/services/api-tokens.server'
import {
  listCliRefreshCredentialFamilies,
  revokeCliRefreshCredentialFamily,
  revokeAllCliRefreshCredentialFamilies,
} from '~/services/cli-refresh-credentials.server'
import { createDb } from '~/services/db.server'
import ApiTokensPage, {
  MAX_TOKEN_NAME_LENGTH,
  type TokensLoaderData,
} from '../+components/ai-tools-page'

// React Router passes loaderData only to a default export declared here.
export default ApiTokensPage

export async function loader({
  context,
}: Route.LoaderArgs): Promise<TokensLoaderData> {
  const user = requireUser(context)
  const db = createDb()
  const tokens = await listApiTokens(db, user.id)
  // Keep the existing order: the CLI read starts only after the token list
  // succeeds, so a failed first read issues no second query.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
  const cliFamilies = await listCliRefreshCredentialFamilies(db, user.id)
  return { tokens, createdToken: null, cliFamilies }
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData()
  const intent = stringValue(form.get('intent')) ?? ''
  const submit = () => submitTokenForm(context, form, intent)
  return isRevokeIntent(intent) ? runConfirmedMutation(submit) : submit()
}

async function submitTokenForm(
  context: Route.ActionArgs['context'],
  form: FormData,
  intent: string,
) {
  const user = requireUser(context)
  const db = createDb()

  if (intent === 'create') {
    const name = stringValue(form.get('name'))?.trim() ?? ''
    if (!name || name.length > MAX_TOKEN_NAME_LENGTH)
      return data(
        {
          ok: false as const,
          intent,
          code: !name ? 'name-required' : 'name-too-long',
        },
        { status: 400 },
      )
    const result = await createApiToken(db, user.id, name)
    return data(
      {
        ok: true as const,
        code: 'created' as const,
        intent,
        token: result.token,
        name: result.name,
      },
      { status: 200 },
    )
  }

  if (!isRevokeIntent(intent))
    return data(
      { ok: false as const, intent, code: 'invalid' },
      { status: 400 },
    )

  if (intent === 'revoke') {
    const id = stringValue(form.get('tokenId'))
    if (!id)
      return data(
        { ok: false as const, code: 'revoke-failed', intent },
        { status: 400 },
      )
    if (!(await revokeApiToken(db, user.id, id)))
      return data(
        { ok: false as const, code: 'revoke-unavailable', intent },
        { status: 404 },
      )
  } else if (intent === 'revoke-cli-family') {
    const id = stringValue(form.get('familyId'))
    if (!id)
      return data(
        { ok: false as const, code: 'revoke-failed', intent },
        { status: 400 },
      )
    if ((await revokeCliRefreshCredentialFamily(db, user.id, id)) === 'noop')
      return data(
        { ok: true as const, code: 'cli-revoke-noop' as const, intent },
        { status: 200 },
      )
  } else {
    await revokeAllCliRefreshCredentialFamilies(db, user.id)
  }
  return data(
    { ok: true as const, code: 'revoked' as const, intent },
    { status: 200 },
  )
}

function isRevokeIntent(intent: string) {
  return (
    intent === 'revoke' ||
    intent === 'revoke-cli-family' ||
    intent === 'revoke-all-cli-families'
  )
}

export async function clientAction({
  request,
  serverAction,
}: Route.ClientActionArgs) {
  const form = await request.clone().formData()
  const intent = stringValue(form.get('intent')) ?? ''
  return isRevokeIntent(intent)
    ? confirmationResult(intent, serverAction)
    : serverAction()
}
