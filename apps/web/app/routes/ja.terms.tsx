import { termsHtml } from '~/services/legal-content.server'
import { TermsPage, termsMeta } from './terms'
import type { Route } from './+types/ja.terms'

export function loader() {
  return { html: termsHtml('ja') }
}

export function meta() {
  return termsMeta('ja')
}

export default function JaTermsRoute({ loaderData }: Route.ComponentProps) {
  return <TermsPage html={loaderData.html} locale="ja" />
}
