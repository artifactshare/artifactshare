import { updateWorkspaceBotDestinations } from '~/services/bot-destinations.server'
import { data } from 'react-router'
import {
  confirmationResult,
  runConfirmedMutation,
} from '~/lib/settings-confirmation'
import { isBotMembersEnabled } from '~/lib/bot-members-flag.server'
import { requireUser } from '~/middleware/context'
import {
  cancelWorkspaceBot,
  createWorkspaceBot,
  listWorkspaceBots,
  reissueWorkspaceBotCredential,
  stopWorkspaceBot,
} from '~/services/bot-members.server'
import { createDb } from '~/services/db.server'
import { requireSettingsAdminPage } from '../+lib/settings-admin.server'
import { SettingsPage } from '~/components/form/settings-page'
import { BotSection } from '../+components/bot-section'
import type { Route } from './+types/bots'
import type { ScreenSpec } from '~/types/screen'

export const screen = {
  id: 'settings-bots',
  route: {
    en: '/settings/bots',
  },
  auth: 'team-owner',
  loop: 'support',
  metric: 'Bot運用の安全性を高める',
  role: 'Botを棚卸し認証情報を管理する',
  primaryAction: 'Botを管理する',
  states: [
    {
      id: 'forbidden',
      description: 'A Team member opens the admin-only Bots page (403)',
      expectedStatus: 403,
      expectedError: 'settings-error-boundary',
      setup: {
        auth: 'team-member',
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
      id: 'long-email',
      description: 'long-email responsive controls and content',
      setup: {
        scenario: 'settings-bots/long-email',
        reseedBeforeCapture: true,
      },
    },
    {
      id: 'stop-pending',
      description:
        'Stopping the bot with a busy confirmation and disabled controls',
      setup: {
        scenario: 'settings/with-bots',
        reseedBeforeCapture: true,
        actionResponse: {
          route: '/settings/bots',
          method: 'POST',
          intent: 'stop',
          pending: true,
        },
        interactions: [
          {
            action: 'click',
            selector:
              'tr:has-text("Nightly report bot") button:text-is("Stop")',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Stop bot")',
            readySelector:
              '[role="alertdialog"] [data-slot="alert-dialog-action"]:disabled',
          },
        ],
      },
    },
    {
      id: 'stop-failed',
      description:
        'Stopping the bot failed with an alert inside the open confirmation',
      setup: {
        scenario: 'settings/with-bots',
        reseedBeforeCapture: true,
        actionResponse: {
          route: '/settings/bots',
          method: 'POST',
          intent: 'stop',
          status: 403,
          data: { ok: false, code: 'forbidden', intent: 'stop' },
        },
        interactions: [
          {
            action: 'click',
            selector:
              'tr:has-text("Nightly report bot") button:text-is("Stop")',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Stop bot")',
            readySelector: '[role="alertdialog"] [role="alert"]',
          },
        ],
      },
    },
    {
      id: 'stop-success',
      description: 'Stopped bot in the table after successful confirmation',
      setup: {
        scenario: 'settings/with-bots',
        reseedBeforeCapture: true,
        interactions: [
          {
            action: 'click',
            selector:
              'tr:has-text("Nightly report bot") button:text-is("Stop")',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Stop bot")',
            readySelector:
              'body:not(:has([role="alertdialog"])) [data-bot-result="stop"]:not(:empty)',
          },
        ],
      },
    },
    {
      id: 'cancel-pending',
      description:
        'Cancelling bot creation with a busy confirmation and disabled controls',
      setup: {
        scenario: 'settings/with-bots',
        reseedBeforeCapture: true,
        actionResponse: {
          route: '/settings/bots',
          method: 'POST',
          intent: 'cancel',
          pending: true,
        },
        interactions: [
          {
            action: 'click',
            selector: 'button:text-is("Cancel creation")',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Cancel creation")',
            readySelector:
              '[role="alertdialog"] [data-slot="alert-dialog-action"]:disabled',
          },
        ],
      },
    },
    {
      id: 'cancel-failed',
      description:
        'Cancelling bot creation failed with an alert inside the open confirmation',
      setup: {
        scenario: 'settings/with-bots',
        reseedBeforeCapture: true,
        actionResponse: {
          route: '/settings/bots',
          method: 'POST',
          intent: 'cancel',
          status: 403,
          data: { ok: false, code: 'forbidden', intent: 'cancel' },
        },
        interactions: [
          {
            action: 'click',
            selector: 'button:text-is("Cancel creation")',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Cancel creation")',
            readySelector: '[role="alertdialog"] [role="alert"]',
          },
        ],
      },
    },
    {
      id: 'cancel-success',
      description: 'Unused bot removed after successful creation cancellation',
      setup: {
        scenario: 'settings/with-bots',
        reseedBeforeCapture: true,
        interactions: [
          {
            action: 'click',
            selector: 'button:text-is("Cancel creation")',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Cancel creation")',
            readySelector:
              'body:not(:has([role="alertdialog"],[data-testid="bot-row"]:has-text("Setup failed bot"))):has([data-testid="bot-row"]:has-text("Nightly report bot") [data-available="true"] + [data-available="true"]) [data-bot-result="cancel"]:not(:empty)',
          },
        ],
      },
    },
    {
      id: 'reissue-pending',
      description:
        'Reissuing the bot token with a busy confirmation and disabled controls',
      setup: {
        scenario: 'settings/with-bots',
        reseedBeforeCapture: true,
        actionResponse: {
          route: '/settings/bots',
          method: 'POST',
          intent: 'reissue',
          pending: true,
        },
        interactions: [
          {
            action: 'click',
            selector:
              'tr:has-text("Nightly report bot") button:text-is("Reissue token")',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Reissue")',
            readySelector:
              '[role="alertdialog"] [data-slot="alert-dialog-action"]:disabled',
          },
        ],
      },
    },
    {
      id: 'reissue-failed',
      description:
        'Reissuing the bot token failed with an alert inside the open confirmation',
      setup: {
        scenario: 'settings/with-bots',
        reseedBeforeCapture: true,
        actionResponse: {
          route: '/settings/bots',
          method: 'POST',
          intent: 'reissue',
          status: 403,
          data: { ok: false, code: 'forbidden', intent: 'reissue' },
        },
        interactions: [
          {
            action: 'click',
            selector:
              'tr:has-text("Nightly report bot") button:text-is("Reissue token")',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Reissue")',
            readySelector: '[role="alertdialog"] [role="alert"]',
          },
        ],
      },
    },
    {
      id: 'reissue-success',
      description:
        'One-time replacement token and full import instructions after reissue',
      setup: {
        scenario: 'settings/with-bots',
        reseedBeforeCapture: true,
        interactions: [
          {
            action: 'click',
            selector:
              'tr:has-text("Nightly report bot") button:text-is("Reissue token")',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Reissue")',
            readySelector: '[data-testid="bot-token"]',
          },
        ],
      },
    },
    {
      id: 'create-populated-destinations',
      description:
        'Bot creation with an added destination and replacement-primary guidance',
      setup: {
        scenario: 'settings/with-bots',
        interactions: [
          {
            action: 'click',
            selector: 'button:text-is("Add bot")',
            readySelector: '[role="dialog"]',
          },
          {
            action: 'click',
            selector: '[role="dialog"] [role="group"] button >> nth=0',
          },
          {
            action: 'click',
            selector: '[role="dialog"] button:text-is("Add destination")',
            readySelector: '[role="dialog"] input[type="radio"]',
          },
        ],
      },
    },
    {
      id: 'default',
      description: 'Bot管理',
      setup: {},
    },
    {
      id: 'with-bots',
      description:
        '有効・認証期限切れ・利用済み停止・未使用停止のBotメンバーがある状態',
      setup: {
        scenario: 'settings/with-bots',
      },
    },
    {
      id: 'create-bot-dialog',
      description: 'Bot作成ダイアログを開いた状態',
      setup: {
        scenario: 'settings/with-bots',
        interactions: [
          {
            action: 'click',
            selector: 'button:has-text("Add bot")',
            readySelector: '#bot-name',
          },
          {
            action: 'fill',
            selector: '#bot-name',
            value: 'Weekly summary',
            readySelector:
              '[role="dialog"]:has([aria-pressed="true"]:has-text("Nightly reports")):not(:has(input[type="radio"])) #bot-create-guidance + button:disabled',
          },
        ],
      },
    },
    {
      id: 'edit-bot-destinations',
      description: 'Botの承認済み投稿先を編集する状態',
      setup: {
        scenario: 'settings/with-bots',
        interactions: [
          {
            action: 'click',
            selector:
              'tr:has-text("Nightly report bot") button:has-text("Edit destinations")',
          },
        ],
      },
    },
    {
      id: 'cancel-bot-dialog',
      description: '未使用Botの作成取消確認を開いた状態',
      setup: {
        scenario: 'settings/with-bots',
        interactions: [
          {
            action: 'click',
            selector: 'button:has-text("Cancel creation")',
          },
        ],
      },
    },
    {
      id: 'stop-bot-dialog',
      description: '利用済みBotの停止確認を開いた状態',
      setup: {
        scenario: 'settings/with-bots',
        interactions: [
          {
            action: 'click',
            selector:
              'tr:has-text("Nightly report bot") button:has-text("Stop")',
          },
        ],
      },
    },
  ],
} satisfies ScreenSpec

// Settings action for bot management. Tokens are returned only in this
// action's response body — never via redirect, flash/session storage, URL
// parameters, or logs. The bot-members feature flag gates creation only:
// stop/reissue keep working for existing bots regardless of the flag.

export async function loader({ context }: Route.LoaderArgs) {
  requireSettingsAdminPage(context)
  const user = requireUser(context)
  const db = createDb()
  const [bots, botCreationEnabled] = await Promise.all([
    listWorkspaceBots(db, user.workspaceId),
    isBotMembersEnabled(user.workspaceId),
  ])
  return { bots, botCreationEnabled }
}

export default function BotsPage({
  loaderData,
}: Pick<Route.ComponentProps, 'loaderData'>) {
  return (
    <SettingsPage>
      <BotSection
        bots={loaderData.bots}
        canCreate={loaderData.botCreationEnabled}
      />
    </SettingsPage>
  )
}

async function botRequestBody(request: {
  json: () => Promise<unknown>
}): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null)
  return isObject(body) ? body : {}
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isConfirmation(intent: unknown) {
  return intent === 'stop' || intent === 'cancel' || intent === 'reissue'
}

export async function clientAction({
  request,
  serverAction,
}: Route.ClientActionArgs) {
  const body = await botRequestBody(request.clone())
  return isConfirmation(body?.intent)
    ? confirmationResult(body.intent, serverAction)
    : serverAction()
}

export async function action({ request, context }: Route.ActionArgs) {
  requireSettingsAdminPage(context)
  if (request.method !== 'POST')
    return data(
      { ok: false, code: 'method-not-allowed', intent: '' },
      { status: 405 },
    )
  const body = await botRequestBody(request)
  const intent = typeof body.intent === 'string' ? body.intent : ''
  const submit = () => submitBotForm(context, body, intent)
  return isConfirmation(intent) ? runConfirmedMutation(submit) : submit()
}

async function submitBotForm(
  context: Route.ActionArgs['context'],
  body: Record<string, unknown>,
  intent: string,
) {
  const user = requireUser(context)
  const fail = (code: string, status: number) =>
    data({ ok: false as const, code, intent }, { status })
  const db = createDb()
  const actor = { id: user.id, workspaceId: user.workspaceId }
  const submit = async () => {
    switch (intent) {
      case 'destinations':
        if (
          typeof body.botUserId !== 'string' ||
          typeof body.projectId !== 'string' ||
          typeof body.revision !== 'string'
        )
          return { kind: 'invalid-body' } as const
        return updateWorkspaceBotDestinations(db, actor, {
          botUserId: body.botUserId,
          projectId: body.projectId,
          projectIds: body.projectIds,
          revision: body.revision,
        })
      case 'create':
        if (!(await isBotMembersEnabled(user.workspaceId)))
          return { kind: 'feature-not-available' } as const
        if (typeof body.name !== 'string' || typeof body.projectId !== 'string')
          return { kind: 'invalid-body' } as const
        return createWorkspaceBot(db, actor, {
          name: body.name,
          projectId: body.projectId,
          projectIds: body.projectIds,
        })
      case 'stop':
      case 'reissue':
      case 'cancel':
        if (typeof body.botUserId !== 'string' || !body.botUserId)
          return { kind: 'invalid-body' } as const
        if (intent === 'stop')
          return stopWorkspaceBot(db, actor, body.botUserId)
        if (intent === 'cancel')
          return cancelWorkspaceBot(db, actor, body.botUserId)
        return reissueWorkspaceBotCredential(db, actor, body.botUserId)
      default:
        return { kind: 'invalid-body' } as const
    }
  }
  const result = await submit()
  if (result.kind === 'ok') {
    const { kind, ...payload } = result
    return data(
      { ok: true as const, code: kind, intent, ...payload },
      { status: 200 },
    )
  }
  const code = result.kind
  if (code === 'forbidden' || code === 'feature-not-available')
    return fail(code, 403)
  if (code === 'not-found') return fail(code, 404)
  if (
    ['bot-conflict', 'bot-stopped', 'bot-used', 'bot-limit-reached'].includes(
      code,
    )
  )
    return fail(code, 409)
  return fail(code, 400)
}
