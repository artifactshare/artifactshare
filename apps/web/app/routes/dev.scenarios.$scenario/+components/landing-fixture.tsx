import { Landing } from '~/routes/_home/+components/landing'

export function LandingFixture({ invite = false }: { invite?: boolean }) {
  return (
    <Landing
      regression={{
        inviteMode: invite,
        regions: { main: 'main', hero: 'hero', footer: 'footer' },
        primary: 'continue',
      }}
    />
  )
}
