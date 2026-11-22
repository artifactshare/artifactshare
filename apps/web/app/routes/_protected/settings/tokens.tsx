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
      id: 'revoke-all-cli-families-failed',
      description: 'revoke-all-cli-families confirmation failed',
      setup: {
        scenario: 'settings-tokens/active-cli',
        interactions: [
          {
            action: 'click',
            selector: 'button[id^="revoke-all-"]:visible',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[data-slot="alert-dialog-action"]',
            readySelector: '[role="alertdialog"] [role="alert"]',
          },
        ],
        actionResponse: {
          route: '/settings/tokens',
          method: 'POST',
          intent: 'revoke-all-cli-families',
          data: { kind: 'revoke-failed', intent: 'revoke-all-cli-families' },
        },
      },
    },
    {
      id: 'revoke-all-cli-families-pending',
      description: 'revoke-all-cli-families confirmation pending',
      setup: {
        scenario: 'settings-tokens/active-cli',
        interactions: [
          {
            action: 'click',
            selector: 'button[id^="revoke-all-"]:visible',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[data-slot="alert-dialog-action"]',
            readySelector: '[role="alertdialog"] [aria-busy="true"]:disabled',
          },
        ],
        actionResponse: {
          route: '/settings/tokens',
          method: 'POST',
          intent: 'revoke-all-cli-families',
          pending: true,
        },
      },
    },
    {
      id: 'revoke-all-cli-families-open',
      description: 'revoke-all-cli-families confirmation open',
      setup: {
        scenario: 'settings-tokens/active-cli',
        interactions: [
          {
            action: 'click',
            selector: 'button[id^="revoke-all-"]:visible',
            readySelector: '[role="alertdialog"]',
          },
        ],
      },
    },
    {
      id: 'revoke-cli-family-failed',
      description: 'revoke-cli-family confirmation failed',
      setup: {
        scenario: 'settings-tokens/active-cli',
        interactions: [
          {
            action: 'click',
            selector: 'button[id^="revoke-family-"]',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[data-slot="alert-dialog-action"]',
            readySelector: '[role="alertdialog"] [role="alert"]',
          },
        ],
        actionResponse: {
          route: '/settings/tokens',
          method: 'POST',
          intent: 'revoke-cli-family',
          data: { kind: 'revoke-failed', intent: 'revoke-cli-family' },
        },
      },
    },
    {
      id: 'revoke-cli-family-pending',
      description: 'revoke-cli-family confirmation pending',
      setup: {
        scenario: 'settings-tokens/active-cli',
        interactions: [
          {
            action: 'click',
            selector: 'button[id^="revoke-family-"]',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[data-slot="alert-dialog-action"]',
            readySelector: '[role="alertdialog"] [aria-busy="true"]:disabled',
          },
        ],
        actionResponse: {
          route: '/settings/tokens',
          method: 'POST',
          intent: 'revoke-cli-family',
          pending: true,
        },
      },
    },
    {
      id: 'revoke-cli-family-open',
      description: 'revoke-cli-family confirmation open',
      setup: {
        scenario: 'settings-tokens/active-cli',
        interactions: [
          {
            action: 'click',
            selector: 'button[id^="revoke-family-"]',
            readySelector: '[role="alertdialog"]',
          },
        ],
      },
    },
    {
      id: 'revoke-failed',
      description: 'revoke confirmation failed',
      setup: {
        scenario: 'settings-tokens/created-secret',
        interactions: [
          {
            action: 'click',
            selector: 'button[aria-label="Revoke CLI deploy"]',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[data-slot="alert-dialog-action"]',
            readySelector: '[role="alertdialog"] [role="alert"]',
          },
        ],
        actionResponse: {
          route: '/settings/tokens',
          method: 'POST',
          intent: 'revoke',
          data: { kind: 'revoke-failed', intent: 'revoke' },
        },
      },
    },
    {
      id: 'revoke-pending',
      description: 'revoke confirmation pending',
      setup: {
        scenario: 'settings-tokens/created-secret',
        interactions: [
          {
            action: 'click',
            selector: 'button[aria-label="Revoke CLI deploy"]',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[data-slot="alert-dialog-action"]',
            readySelector: '[role="alertdialog"] [aria-busy="true"]:disabled',
          },
        ],
        actionResponse: {
          route: '/settings/tokens',
          method: 'POST',
          intent: 'revoke',
          pending: true,
        },
      },
    },
    {
      id: 'revoke-open',
      description: 'revoke confirmation open',
      setup: {
        scenario: 'settings-tokens/created-secret',
        interactions: [
          {
            action: 'click',
            selector: 'button[aria-label="Revoke CLI deploy"]',
            readySelector: '[role="alertdialog"]',
          },
        ],
      },
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
  | {
      kind: 'revoked' | 'revoke-failed' | 'revoke-unavailable'
      intent: 'revoke' | 'revoke-cli-family' | 'revoke-all-cli-families'
    }
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

  if (intent === 'create') {
    const name = stringValue(form.get('name'))?.trim() ?? ''
    if (!name) return { kind: 'name-required' }
    if (name.length > MAX_TOKEN_NAME_LENGTH) return { kind: 'name-too-long' }
    const result = await createApiToken(db, user.id, name)
    return { kind: 'created', token: result.token, name: result.name }
  }

  if (
    intent !== 'revoke' &&
    intent !== 'revoke-cli-family' &&
    intent !== 'revoke-all-cli-families'
  )
    return null
  try {
    if (intent === 'revoke') {
      const id = stringValue(form.get('tokenId'))
      if (!id) return { kind: 'revoke-failed', intent }
      if (!(await revokeApiToken(db, user.id, id)))
        return { kind: 'revoke-unavailable', intent }
    } else if (intent === 'revoke-cli-family') {
      const id = stringValue(form.get('familyId'))
      if (!id) return { kind: 'revoke-failed', intent }
      if ((await revokeCliRefreshCredentialFamily(db, user.id, id)) === 'noop')
        return { kind: 'cli-revoke-noop' }
    } else {
      await revokeAllCliRefreshCredentialFamilies(db, user.id)
    }
    return { kind: 'revoked', intent }
  } catch (error) {
    if (error instanceof Response) throw error
    return { kind: 'revoke-failed', intent }
  }
}
