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
import { isDevScreenStateRequest } from '~/services/dev-screen-state.server'
import type { ScreenSpec } from '~/types/screen'
import ApiTokensPage, {
  MAX_TOKEN_NAME_LENGTH,
} from './+components/ai-tools-page'

export default function TokensRoute({
  loaderData,
}: Pick<Route.ComponentProps, 'loaderData'>) {
  return <ApiTokensPage loaderData={loaderData} />
}

export const screen = {
  id: 'settings-tokens',
  route: {
    en: '/settings/tokens',
  },
  auth: 'team-owner',
  loop: 'create',
  metric: 'CLI利用の継続を支える',
  role: 'アクセストークンを管理する',
  primaryAction: 'トークンを作成する',
  states: [
    {
      id: 'result-success',
      description:
        'Successful settings action announced above the page content',
      setup: { query: '?status=ok' },
    },
    {
      id: 'result-warning',
      description: 'Informational settings warning above the page content',
      setup: { query: '?status=removed-transfer-failed' },
    },
    {
      id: 'result-error',
      description:
        'Failed settings action with an error alert above the page content',
      setup: { query: '?status=forbidden' },
    },
    {
      id: 'active-cli',
      description: 'CLI sessions',
      setup: { scenario: 'settings-tokens/active-cli' },
    },
    {
      id: 'mixed-presets',
      description: 'CLI presets',
      setup: { scenario: 'settings-tokens/mixed-presets' },
    },
    {
      id: 'default',
      description: 'トークン設定',
      setup: {},
    },
    {
      id: 'created-secret',
      description: '作成直後のシークレットを表示する状態',
      setup: {
        scenario: 'settings-tokens/created-secret',
      },
    },
  ],
} satisfies ScreenSpec

type ActionData =
  | { kind: 'created'; token: string; name: string }
  | { kind: 'cli-revoke-noop' }
  | { kind: 'name-required' }
  | { kind: 'name-too-long' }

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const tokens = await listApiTokens(db, user.id)
  const createdToken = isDevScreenStateRequest(
    request,
    'settings-tokens/created-secret',
  )
    ? { name: 'CLI deploy', token: 'as_dev_screen_created_secret' }
    : null
  const cliFamilies = await listCliRefreshCredentialFamilies(db, user.id)
  return { tokens, createdToken, cliFamilies }
}

export async function action({
  request,
  context,
}: Route.ActionArgs): Promise<ActionData | null> {
  const user = requireUser(context)
  const form = await request.formData()
  const intent = stringValue(form.get('intent'))
  const db = createDb()

  if (intent === 'revoke-cli-family') {
    const familyId = stringValue(form.get('familyId'))
    if (!familyId) return null
    const result = await revokeCliRefreshCredentialFamily(db, user.id, familyId)
    return result === 'noop' ? { kind: 'cli-revoke-noop' } : null
  }
  if (intent === 'revoke-all-cli-families') {
    await revokeAllCliRefreshCredentialFamilies(db, user.id)
    return null
  }
  if (intent === 'create') {
    const name = stringValue(form.get('name'))?.trim() ?? ''
    if (!name) return { kind: 'name-required' }
    if (name.length > MAX_TOKEN_NAME_LENGTH) return { kind: 'name-too-long' }
    const result = await createApiToken(db, user.id, name)
    return { kind: 'created', token: result.token, name: result.name }
  }

  if (intent === 'revoke') {
    const tokenId = stringValue(form.get('tokenId'))
    if (!tokenId) return null
    await revokeApiToken(db, user.id, tokenId)
    return null
  }

  return null
}
