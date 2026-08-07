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
  bodyHtml: string
  summaryHtml: string
  hasMore: boolean
  detailsHref?: string
}

// loader が client へ流す最小形。一覧は本文全文を、個別は要約を運ばない。
export type UpdateListItem = Omit<UpdateEntry, 'bodyHtml' | 'flag' | 'notice'>
export type UpdateDetail = Omit<
  UpdateEntry,
  'summaryHtml' | 'hasMore' | 'flag' | 'notice'
>
