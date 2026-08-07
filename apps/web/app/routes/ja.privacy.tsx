import { privacyHtml } from '~/services/legal-content.server'
import { PrivacyPage, privacyMeta } from './privacy'
import type { Route } from './+types/ja.privacy'

export function loader() {
  return { html: privacyHtml('ja') }
}

export function meta() {
  return privacyMeta('ja')
}

export default function JaPrivacyRoute({ loaderData }: Route.ComponentProps) {
  return <PrivacyPage html={loaderData.html} locale="ja" />
}
