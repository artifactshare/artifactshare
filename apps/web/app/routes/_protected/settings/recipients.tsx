import type { Route } from './+types/recipients'
import type { RecipientSearchData } from '~/lib/team-management'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  requireWorkspaceAdmin,
  searchAssetTransferRecipients,
} from '~/services/team-management.server'

export async function loader({
  request,
  context,
}: Route.LoaderArgs): Promise<RecipientSearchData> {
  const user = requireUser(context)
  const url = new URL(request.url)
  const query = url.searchParams.get('q')?.trim() ?? ''
  const exclude = url.searchParams.get('exclude') ?? undefined

  // fetcher 呼び出しのため throw しない (途中の権限喪失や一時障害で画面全体を壊さない)。
  try {
    const db = createDb()
    const authorized = await requireWorkspaceAdmin(db, user)
    if (authorized.kind !== 'ok') {
      return { query, recipients: [], total: 0 }
    }

    const result = await searchAssetTransferRecipients(db, user.workspaceId, {
      query,
      excludeUserIds: [user.id, ...(exclude ? [exclude] : [])],
    })
    return { query, ...result }
  } catch (error) {
    console.error('recipient_search_failed', error)
    return { query, recipients: [], total: 0, failed: true }
  }
}
