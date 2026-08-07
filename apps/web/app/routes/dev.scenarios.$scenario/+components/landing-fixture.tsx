import { Landing } from '~/routes/_home/+components/landing'

export function LandingFixture({
  invite = false,
  aiOpen = false,
}: {
  invite?: boolean
  aiOpen?: boolean
}) {
  return (
    <Landing
      regression={{
        inviteMode: invite,
        agentEntryOpen: aiOpen,
        eagerProductImages: true,
        regions: { main: 'main', hero: 'hero', footer: 'footer' },
        primary: 'continue',
      }}
    />
  )
}
