import { tokushohoHtml } from '~/services/legal-content.server'
import { TokushohoPage, tokushohoMeta } from './tokushoho'
import type { Route } from './+types/ja.tokushoho'

export function loader() {
  return { html: tokushohoHtml('ja') }
}

export function meta() {
  return tokushohoMeta('ja')
}

export default function JaTokushohoRoute({ loaderData }: Route.ComponentProps) {
  return <TokushohoPage html={loaderData.html} locale="ja" />
}
