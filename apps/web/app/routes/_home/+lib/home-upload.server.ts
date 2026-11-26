import {
  availableVisibilitiesFor,
  defaultVisibilityFor,
} from '~/lib/shareable-types'
import { isOrgWorkspace, type SessionUser } from '~/lib/user'
import type { Db } from '~/services/db.server'
import { isLinkSharingAllowedByPolicy } from '~/services/link-sharing.server'
import type { HomeUploadData } from '../+components/home-main'

export async function loadHomeUpload(
  db: Db,
  user: SessionUser,
): Promise<HomeUploadData> {
  return {
    workspaceId: user.workspaceId,
    defaultVisibility: defaultVisibilityFor(isOrgWorkspace(user)),
    workspaceHd: user.hd,
    availableVisibilities: availableVisibilitiesFor(
      isOrgWorkspace(user),
      'inbox',
    ),
    linkSharingAvailable: await isLinkSharingAllowedByPolicy(
      db,
      user.workspaceId,
    ),
    selfUploadEnabled: user.selfUploadEnabled === true,
  }
}
