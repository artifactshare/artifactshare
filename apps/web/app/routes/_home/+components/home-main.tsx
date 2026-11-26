import { useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { listMainClassName } from '~/components/app/page-shell-styles'
import { hasUploadQuery, uploadReturnTo } from '~/lib/home-upload-query'
import type { AppShellData } from '~/routes/_protected/+components/app-shell'
import type { EditableVisibility } from '~/lib/shareable-types'
import { UploadArtifactDialog } from './upload-artifact-dialog'

/** What Home's upload dialog offers the viewer. */
export type HomeUploadData = {
  workspaceId: string
  defaultVisibility: EditableVisibility
  workspaceHd: string | null
  availableVisibilities: ReadonlyArray<EditableVisibility>
  linkSharingAvailable: boolean
  selfUploadEnabled: boolean
}

export type SignedInHomeData = { signedIn: true } & AppShellData &
  HomeUploadData

export type HomeLayoutData =
  | { signedIn: false; linkDomain?: boolean }
  | SignedInHomeData

/** What Home's pages read from the outlet context. */
export type HomeLayoutContext = HomeLayoutData & {
  openUploadDialog: () => void
}

/**
 * The body of Home's pages: the list in `<main>` and the upload dialog the
 * lists open, with the layout data the lists read from the outlet context.
 */
export function HomeMain({ data }: { data: SignedInHomeData }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [uploadOpen, setUploadOpen] = useState(false)
  const uploadRequested = hasUploadQuery(location.search)

  const context: HomeLayoutContext = {
    ...data,
    openUploadDialog: () => {
      if (data.selfUploadEnabled) setUploadOpen(true)
    },
  }

  return (
    <>
      <main className={listMainClassName} tabIndex={-1}>
        <Outlet context={context} />
      </main>
      <UploadArtifactDialog
        open={(uploadOpen || uploadRequested) && data.selfUploadEnabled}
        onOpenChange={(open) => {
          setUploadOpen(open)
          if (!open && new URLSearchParams(location.search).has('upload')) {
            void navigate(uploadReturnTo(location), { replace: true })
          }
        }}
        defaultVisibility={data.defaultVisibility}
        workspaceHd={data.workspaceHd}
        availableVisibilities={data.availableVisibilities}
        linkSharingAvailable={data.linkSharingAvailable}
        user={data.user}
      />
    </>
  )
}
