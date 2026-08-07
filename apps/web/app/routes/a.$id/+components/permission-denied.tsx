import { Link } from 'react-router'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import type { Visibility } from '~/lib/shareable-types'
import type { UserInfo } from '~/lib/user'
import { ViewerErrorShell } from '~/components/app/viewer-error-shell'
import { IconLock } from '@tabler/icons-react'

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
    }
  | {
      variant: 'external'
      user: UserInfo
    }

export function PermissionDenied(props: PermissionDeniedProps) {
  const { t } = useT()

  if (props.variant === 'internal') {
    const ownerLabel = props.artifact.ownerEmail ?? t('card.me')
    if (props.artifact.visibility === 'private') {
      return (
        <ViewerErrorShell
          user={props.user}
          icon={<IconLock strokeWidth={1.6} aria-hidden="true" />}
          title={t('denied.title')}
          body={t('denied.privateBody', { owner: ownerLabel })}
          actions={
            props.artifact.ownerEmail ? (
              <Button asChild>
                <a
                  href={`mailto:${props.artifact.ownerEmail}?subject=${encodeURIComponent(
                    t('denied.privateMailSubject', {
                      name: props.artifact.name,
                    }),
                  )}`}
                >
                  {t('denied.privateCta', { owner: ownerLabel })}
                </a>
              </Button>
            ) : null
          }
        />
      )
    }
    return (
      <ViewerErrorShell
        user={props.user}
        icon={<IconLock strokeWidth={1.6} aria-hidden="true" />}
        title={t('denied.title')}
        body={t('denied.body', { owner: ownerLabel })}
        actions={
          props.artifact.ownerEmail ? (
            <Button asChild>
              <a
                href={`mailto:${props.artifact.ownerEmail}?subject=${encodeURIComponent(
                  t('denied.privateMailSubject', {
                    name: props.artifact.name,
                  }),
                )}`}
              >
                {t('denied.cta')}
              </a>
            </Button>
          ) : null
        }
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
      actions={
        <Button asChild>
          <Link to="/">{t('deniedX.back')}</Link>
        </Button>
      }
    />
  )
}
