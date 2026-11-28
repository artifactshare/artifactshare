import { useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { listMainClassName } from '~/components/app/page-shell-styles'
import { hasUploadQuery, uploadReturnTo } from '~/lib/home-upload-query'
import type { AppShellData } from '~/routes/_protected/+components/app-shell'
import type { EditableVisibility } from '~/lib/shareable-types'
import { UploadArtifactDialog } from './upload-artifact-dialog'

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

export type HomeLayoutContext = HomeLayoutData & {
  openUploadDialog: () => void
}

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
