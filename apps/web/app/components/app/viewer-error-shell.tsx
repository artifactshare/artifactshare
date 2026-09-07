import type { UserInfo } from '~/lib/user'
import { AppTopbar } from './app-topbar'
import { AvatarMenu } from './avatar-menu'
import { DeniedPanel } from './denied-panel'
import { ViewerNav } from './viewer-nav'

interface ViewerErrorShellProps {
  user: UserInfo | null
  icon: React.ReactNode
  title: string
  body: React.ReactNode
  actions: React.ReactNode
  screenCaptureError?: string
  /** Names an intended state so a capture can wait for it instead of a frame. */
  screenCaptureState?: string
  appOrigin?: string
  regressionRegions?: {
    header?: string
    main?: string
  }
}

export function ViewerErrorShell({
  user,
  icon,
  title,
  body,
  actions,
  screenCaptureError,
  screenCaptureState,
  appOrigin,
  regressionRegions,
}: ViewerErrorShellProps) {
  // viewer-brand-placement.md: エラー topbar は grid 領域を明示し、
  // spacer でなく avatar 側の配置で右寄せする (auto-placement に頼らない)
  const topbar = (
    <AppTopbar className="max-phone:grid max-phone:min-h-12 max-phone:grid-cols-[minmax(0,1fr)_auto] max-phone:gap-1.5 max-phone:[&>div:first-child]:col-start-1 min-h-12">
      <ViewerNav
        anonymous={user === null}
        appOrigin={appOrigin}
        variant="error"
      />
      {user ? (
        <AvatarMenu
          user={user}
          variant="viewer"
          accessRequestsTopbar="app"
          className="max-phone:col-start-2 max-phone:justify-self-end ml-auto"
        />
      ) : null}
    </AppTopbar>
  )
  return (
    <>
      {regressionRegions?.header ? (
        <div data-regression-region={regressionRegions.header}>{topbar}</div>
      ) : (
        topbar
      )}
      <main
        className="flex min-h-0 flex-1"
        data-screen-capture-error={screenCaptureError}
        data-screen-capture-state={screenCaptureState}
        data-regression-region={regressionRegions?.main}
      >
        <DeniedPanel icon={icon} title={title} body={body} actions={actions} />
      </main>
    </>
  )
}
