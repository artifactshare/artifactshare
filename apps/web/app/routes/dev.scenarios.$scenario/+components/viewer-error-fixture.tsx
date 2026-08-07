import { Link } from 'react-router'
import { ViewerErrorShell } from '~/components/app/viewer-error-shell'
import { Button } from '~/components/ui/button'
import { IconAlertTriangle, IconLock } from '@tabler/icons-react'

export function ViewerErrorFixture({
  unexpected = false,
}: {
  unexpected?: boolean
}) {
  return (
    <div className="bg-surface-warm min-h-dvh">
      <ViewerErrorShell
        user={null}
        icon={
          unexpected ? (
            <IconAlertTriangle aria-hidden="true" />
          ) : (
            <IconLock aria-hidden="true" />
          )
        }
        title={
          unexpected
            ? 'This artifact could not be opened'
            : 'You do not have access to this artifact'
        }
        body={
          unexpected
            ? 'The viewer encountered an unexpected problem.'
            : 'Ask the owner to grant access, then try again.'
        }
        actions={
          <Button asChild data-regression-primary="back-home">
            <Link to="/">Back to home</Link>
          </Button>
        }
        regressionRegions={{ header: 'header', main: 'main' }}
      />
    </div>
  )
}
