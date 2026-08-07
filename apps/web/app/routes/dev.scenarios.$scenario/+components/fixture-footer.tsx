import { PublicFooter } from '~/components/app/public-footer'

export function FixtureFooter({
  variant = 'full',
}: {
  variant?: 'full' | 'minimal'
}) {
  return (
    <div data-regression-region="footer">
      <PublicFooter variant={variant} />
    </div>
  )
}
