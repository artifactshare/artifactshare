import type { TrustedHtml } from '@artifactshare/viewer-kit/trusted-html'
import type { Locale } from '~/i18n/messages'

export type UpdateProduct = 'web' | 'cli' | 'agent' | 'mcp' | 'admin'
export type UpdateKind = 'new' | 'improve' | 'fix'
export type UpdateLocale = Locale

export interface UpdateEntry {
  slug: string
  title: string
  date: string
  products: UpdateProduct[]
  kind: UpdateKind
  notice?: true
  flag?: string
  bodyHtml: TrustedHtml
  summaryHtml: TrustedHtml
  hasMore: boolean
  detailsHref?: string
}

export type UpdateListItem = Omit<UpdateEntry, 'bodyHtml' | 'flag' | 'notice'>
export type UpdateDetail = Omit<
  UpdateEntry,
  'summaryHtml' | 'hasMore' | 'flag' | 'notice'
>
