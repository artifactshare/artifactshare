import { AboutPage, aboutMeta } from './_public/($locale)/about'
import type { Route } from './+types/ja.about'

// Keep this legacy Japanese route wrapper until the follow-up removes
// compatibility wrappers.
export function loader() {
  return { locale: 'ja' as const }
}

export function meta() {
  return aboutMeta('ja')
}

export default function JaAboutRoute({ loaderData }: Route.ComponentProps) {
  return <AboutPage locale={loaderData.locale} />
}
