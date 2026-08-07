import { AboutPage, aboutMeta } from './about'
import type { Route } from './+types/ja.about'

export function loader() {
  return { locale: 'ja' as const }
}

export function meta() {
  return aboutMeta('ja')
}

export default function JaAboutRoute({ loaderData }: Route.ComponentProps) {
  return <AboutPage locale={loaderData.locale} />
}
