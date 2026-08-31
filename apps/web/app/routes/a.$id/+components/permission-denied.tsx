import { useFetcher } from 'react-router'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import type { Visibility } from '~/lib/shareable-types'
import type { UserInfo } from '~/lib/user'
import { ViewerErrorShell } from '~/components/app/viewer-error-shell'
import { IconLock } from '@tabler/icons-react'
import { signOut } from '~/lib/auth-client'

type PermissionDeniedProps =
  | {
      variant: 'internal'
      artifact: {
        id: string
        storageKey: string
        name: string
        visibility: Visibility
        ownerEmail: string | null
      }
      user: UserInfo
      emailVerified: boolean
      requestStatus: 'pending' | 'approved' | 'rejected' | null
    }
  | {
      variant: 'external'
      user: UserInfo
      artifactId: string
      emailVerified: boolean
      requestStatus: 'pending' | 'approved' | 'rejected' | null
    }

export function PermissionDenied(props: PermissionDeniedProps) {
  const { t } = useT()
  const fetcher = useFetcher<{
    ok?: boolean
    status?: string
    artifactId?: string
    error?: { code?: string }
  }>()
  const artifactId =
    props.variant === 'internal' ? props.artifact.id : props.artifactId
  const status =
    fetcher.data?.ok && fetcher.data.artifactId === artifactId
      ? fetcher.data.status
      : props.requestStatus

  const requestAction = (
    <div className="flex flex-col items-center gap-2 sm:flex-row">
      {props.emailVerified ? (
        status === 'pending' ? (
          <p className="text-muted-foreground text-sm">
            {t('accessRequest.pending')}
          </p>
        ) : (
          <Button
            type="button"
            disabled={fetcher.state !== 'idle'}
            onClick={() => {
              fetcher.submit(null, {
                method: 'POST',
                action: `/api/shareables/${artifactId}/access-request`,
              })
            }}
          >
            {status === 'rejected'
              ? t('accessRequest.requestAgain')
              : t('accessRequest.request')}
          </Button>
        )
      ) : (
        <p className="text-muted-foreground max-w-sm text-sm">
          {t('accessRequest.verifyEmail')}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        onClick={async () => {
          await signOut()
          window.location.href = `/?next=${encodeURIComponent(`/a/${artifactId}`)}`
        }}
      >
        {t('denied.switch')}
      </Button>
      {fetcher.data?.error && (
        <p className="text-destructive text-sm">
          {t('accessRequest.submitError')}
        </p>
      )}
    </div>
  )

  if (props.variant === 'internal') {
    const ownerLabel = props.artifact.ownerEmail ?? t('card.me')
    if (props.artifact.visibility === 'private') {
      return (
        <ViewerErrorShell
          user={props.user}
          icon={<IconLock strokeWidth={1.6} aria-hidden="true" />}
          title={t('denied.title')}
          body={t('denied.privateBody', { owner: ownerLabel })}
          actions={requestAction}
        />
      )
    }
    return (
      <ViewerErrorShell
        user={props.user}
        icon={<IconLock strokeWidth={1.6} aria-hidden="true" />}
        title={t('denied.title')}
        body={t('denied.body', { owner: ownerLabel })}
        actions={requestAction}
      />
    )
  }

  return (
    <ViewerErrorShell
      user={props.user}
      icon={<IconLock strokeWidth={1.6} aria-hidden="true" />}
      title={t('deniedX.title')}
      body={
        <>
          {t('deniedX.bodySignedInAs')}
          <strong>{props.user.email}</strong>
          {t('deniedX.bodyPleaseSwitch')}
          <br />
          <br />
          {t('deniedX.bodyContactOwner')}
        </>
      }
      actions={requestAction}
    />
  )
}
