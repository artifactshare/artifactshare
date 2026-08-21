// Load the landing serif statically here (dev-scenario chunk only) so the
// visual harness's document.fonts.ready wait covers it; the product page
// loads the same stylesheet lazily on mount.
import '@fontsource/zen-old-mincho/700.css'
import { Landing } from '~/routes/_home/+components/landing'

export function LandingFixture({ invite = false }: { invite?: boolean }) {
  return (
    <Landing
      regression={{
        inviteMode: invite,
        regions: { main: 'main', hero: 'hero', footer: 'footer' },
        primary: 'continue',
        instantHero: true,
      }}
    />
  )
}
