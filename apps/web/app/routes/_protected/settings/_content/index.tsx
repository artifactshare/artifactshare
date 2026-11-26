import { data as actionData } from 'react-router'
import type { Route } from './+types/index'
import { NO_ASSET_TRANSFER } from '../+components/recipient-picker'
import { settingsFailure } from '~/lib/settings-submission'
import {
  confirmationResult,
  runConfirmedMutation,
} from '~/lib/settings-confirmation'
import { isMemberConfirmation } from '../+components/member-confirmation'
import { stringValue } from '~/lib/form'
import type { TeamMutationResult } from '~/lib/team-management'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { settingsActiveAdmin } from '../+lib/settings-request.server'
import {
  grantWorkspaceAdmin,
  loadRemovedWorkspaceMembers,
  loadWorkspaceMembersPage,
  parseMembersPageFilters,
  isRemovedWorkspaceMember,
  removeWorkspaceMember,
  restoreWorkspaceMember,
  revokeWorkspaceAdmin,
  revokeWorkspaceMemberCliSessions,
  transferRemovedMemberAssets,
  transferWorkspaceOwner,
} from '~/services/team-management.server'
import TeamMembersPage, {
  type MembersLoaderData,
} from '../+components/members-page'

// React Router passes loaderData only to a default export declared here.
export default TeamMembersPage

export async function loader({
  request,
  context,
}: Route.LoaderArgs): Promise<MembersLoaderData> {
  const user = requireUser(context)
  const filters = parseMembersPageFilters(new URL(request.url).searchParams)
  const db = createDb()
  // The role shown on the page comes from the Settings shell. Removed members
  // are still authorized here, on the request's own active membership.
  const [membersPage, admin] = await Promise.all([
    loadWorkspaceMembersPage(db, user.workspaceId, filters),
    settingsActiveAdmin(context, request),
  ])
  const removedMembers = admin
    ? await loadRemovedWorkspaceMembers(db, user.workspaceId)
    : []
  return { membersPage, removedMembers, filters }
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData()
  const intent = stringValue(form.get('intent')) ?? ''
  return runConfirmedMutation(async () => {
    const user = requireUser(context)

    const db = createDb()
    let result: TeamMutationResult
    switch (intent) {
      case 'transfer-owner': {
        const userId = stringValue(form.get('userId'))
        if (!userId) return settingsFailure(intent, 'invalid')
        result = await transferWorkspaceOwner(db, user, userId)
        break
      }
      case 'grant-admin': {
        const userId = stringValue(form.get('userId'))
        if (!userId) return settingsFailure(intent, 'invalid')
        result = await grantWorkspaceAdmin(db, user, userId)
        break
      }
      case 'revoke-admin': {
        const userId = stringValue(form.get('userId'))
        if (!userId) return settingsFailure(intent, 'invalid')
        result = await revokeWorkspaceAdmin(db, user, userId)
        break
      }
      case 'revoke-cli-sessions': {
        const userId = stringValue(form.get('userId'))
        if (!userId) return settingsFailure(intent, 'invalid')
        result = await revokeWorkspaceMemberCliSessions(db, user, userId)
        break
      }
      case 'remove-member': {
        const userId = stringValue(form.get('userId'))
        if (!userId) return settingsFailure(intent, 'invalid')
        result = await removeWorkspaceMember(db, user, userId)
        // A retry after a lost response finds the member already removed.
        // The first request committed the removal, so finish the transfer.
        if (
          result.kind === 'not-found' &&
          (await isRemovedWorkspaceMember(db, user.workspaceId, userId))
        ) {
          result = { kind: 'ok' }
        }
        if (result.kind === 'ok') {
          const recipientUserId = stringValue(form.get('recipientUserId'))
          if (recipientUserId && recipientUserId !== NO_ASSET_TRANSFER) {
            const transferResult = await transferRemovedMemberAssets(
              db,
              user,
              userId,
              recipientUserId,
            )
            if (transferResult.kind !== 'ok') {
              return actionData(
                {
                  ok: false as const,
                  code: 'removed-transfer-failed',
                  intent,
                  removalCommitted: true,
                },
                { status: 409 },
              )
            }
          }
          return actionData(
            { ok: true as const, code: 'removed', intent },
            { status: 200 },
          )
        }
        break
      }
      case 'transfer-removed-assets': {
        const userId = stringValue(form.get('userId'))
        const recipientUserId = stringValue(form.get('recipientUserId'))
        if (
          !userId ||
          !recipientUserId ||
          recipientUserId === NO_ASSET_TRANSFER
        ) {
          return settingsFailure(intent, 'invalid')
        }
        result = await transferRemovedMemberAssets(
          db,
          user,
          userId,
          recipientUserId,
        )
        break
      }
      case 'restore-member': {
        const userId = stringValue(form.get('userId'))
        if (!userId) return settingsFailure(intent, 'invalid')
        result = await restoreWorkspaceMember(db, user, userId)
        if (result.kind === 'not-found') {
          return settingsFailure(intent, 'restore-unavailable')
        }
        break
      }
      default:
        return settingsFailure(intent, 'invalid')
    }

    return result.kind === 'ok'
      ? actionData({ ok: true as const, code: 'ok', intent }, { status: 200 })
      : settingsFailure(intent, result.kind)
  })
}

export async function clientAction({
  request,
  serverAction,
}: Route.ClientActionArgs) {
  const intent =
    stringValue((await request.clone().formData()).get('intent')) ?? ''
  return isMemberConfirmation(intent)
    ? confirmationResult(intent, serverAction)
    : serverAction()
}
