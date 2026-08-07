import { Landing } from './_home/+components/landing'
import { landingMeta } from '~/lib/landing-meta'
import type { Route } from './+types/ja'

export function meta() {
  return landingMeta('ja')
}

export default function JaLandingRoute() {
  return <Landing />
}
