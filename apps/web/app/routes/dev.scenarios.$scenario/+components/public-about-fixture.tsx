import { AboutPage } from '~/routes/_public/($locale)/about'

export function PublicAboutFixture() {
  return (
    <AboutPage
      locale="en"
      regression={{
        regions: { header: 'header', main: 'main', footer: 'footer' },
        primary: 'about-primary',
      }}
    />
  )
}
