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
import type { ScreenSpec } from '~/types/screen'
import ApiTokensPage, {
  MAX_TOKEN_NAME_LENGTH,
} from '../+components/ai-tools-page'

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
          status: 400,
          data: {
            ok: false,
            code: 'revoke-failed',
            intent: 'revoke-all-cli-families',
          },
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
          status: 400,
          data: {
            ok: false,
            code: 'revoke-failed',
            intent: 'revoke-cli-family',
          },
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
          status: 400,
          data: { ok: false, code: 'revoke-failed', intent: 'revoke' },
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
        reseedBeforeCapture: true,
        interactions: [
          {
            action: 'fill',
            selector: '#token-name',
            value: 'Release automation',
          },
          {
            action: 'click',
            selector: 'form:has(#token-name) button[type="submit"]',
          },
        ],
        postInteractionReady: {
          selector: 'form:has(#token-name) ~ [role="status"] code:visible',
          description: 'One-time secret returned by the create action',
        },
      },
    },
  ],
} satisfies ScreenSpec

type CreatedToken = { name: string; token: string }

export async function loader({ context }: Route.LoaderArgs): Promise<{
  tokens: Awaited<ReturnType<typeof listApiTokens>>
  // A new secret is shown only from the create action's response.
  createdToken: CreatedToken | null
  cliFamilies: Awaited<ReturnType<typeof listCliRefreshCredentialFamilies>>
}> {
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
