import { Link } from 'react-router'
import { Button } from '~/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '~/components/ui/empty'
import { useT } from '~/hooks/use-t'

export function SelfUploadDisabledCallout({
  signInHref = '/sign-in',
}: {
  signInHref?: string
}) {
  const { t } = useT()

  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle role="heading" aria-level={2}>
          {t('upload.selfUploadDisabled.title')}
        </EmptyTitle>
        <EmptyDescription>
          {t('upload.selfUploadDisabled.body')}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" asChild>
          <Link to={signInHref}>{t('upload.selfUploadDisabled.cta')}</Link>
        </Button>
      </EmptyContent>
    </Empty>
  )
}
