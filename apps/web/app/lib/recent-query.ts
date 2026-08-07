import { parsePageParam } from './pagination'

export type RecentRelation = 'all' | 'own' | 'project' | 'shared'

export function recentQuery(params: URLSearchParams) {
  const value = params.get('relation')
  const relation: RecentRelation =
    value === 'own' || value === 'project' || value === 'shared' ? value : 'all'
  return {
    relation,
    unread: params.get('unread') === '1',
    page: parsePageParam(params),
  }
}

export function recentUrl({
  pathname = '/recent',
  page = 1,
  relation = 'all',
  unread = false,
  hash = '',
}: {
  pathname?: string
  page?: number
  relation?: 'all' | 'own' | 'project' | 'shared'
  unread?: boolean
  hash?: string
}) {
  const params = new URLSearchParams()
  if (page > 1) params.set('page', String(page))
  if (relation !== 'all') params.set('relation', relation)
  if (unread) params.set('unread', '1')
  return `${pathname}${params.toString() ? `?${params}` : ''}${hash}`
}
