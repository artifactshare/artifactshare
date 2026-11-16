import type { Translator } from './i18n'
import { parseSearchInput } from '~/services/search-input'

export const searchQueryKeys = [
  'q',
  'owner',
  'project',
  'period',
  'dateField',
  'from',
  'to',
  'includeArchived',
  'sort',
]

/** Translate the screen vocabulary without silently dropping invalid scope. */
export function searchApiParams(params: URLSearchParams) {
  const api = new URLSearchParams(params)
  const project = params.get('project')
  if (params.has('project')) {
    api.delete('project')
    api.set('location', project === 'home' ? 'home' : 'project')
    if (project !== 'home') api.set('projectId', project ?? '')
  }
  const period = params.get('period')
  // All time keeps the UI's date-field preference, but applies no API date filter.
  if (
    !['period', 'days', 'from', 'to'].some((key) => params.has(key)) &&
    params.getAll('dateField').length === 1 &&
    ['updated', 'viewed'].includes(params.get('dateField') ?? '')
  )
    api.delete('dateField')
  api.delete('period')
  if (period && period !== 'custom') api.set('days', period)
  if (period && !api.has('dateField')) api.set('dateField', 'updated')
  if (!params.has('sort') && !params.get('q')?.trim() && params.has('owner'))
    api.set('sort', 'newest')
  return api
}
export function parseSearchQuery(params: URLSearchParams, now?: Date) {
  const duplicate = ['project', 'period'].filter(
    (key) => params.getAll(key).length > 1,
  )
  if (
    params.has('period') &&
    !['7', '30', '90', 'custom'].includes(params.get('period') ?? '')
  )
    duplicate.push('period')
  if (duplicate.length)
    return { error: { code: 'validation_error' as const, fields: duplicate } }
  return parseSearchInput(searchApiParams(params), now)
}
export function clearSearchFilters(params: URLSearchParams) {
  const next = new URLSearchParams(params)
  for (const key of searchQueryKeys)
    if (key !== 'q' && key !== 'sort') next.delete(key)
  return next
}
export function removeSelectedName(query: string, name: string) {
  if (!name) return query
  const lowered = query.toLocaleLowerCase(),
    target = name.toLocaleLowerCase()
  const wordName = /[\p{Script=Latin}\p{N}]/u.test(name)
  let index = lowered.indexOf(target)
  while (index >= 0) {
    const before = query.slice(0, index).at(-1) ?? '',
      after = query.slice(index + name.length, index + name.length + 1)
    if (
      !wordName ||
      (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after))
    )
      return `${query.slice(0, index)} ${query.slice(index + name.length)}`
        .trim()
        .replace(/\s+/g, ' ')
    index = lowered.indexOf(target, index + target.length)
  }
  return query
}
/** Logs contain canonical API filters, never cached result metadata. */
export function searchHistoryParams(canonical: string) {
  const value = JSON.parse(canonical)
  const params = new URLSearchParams({ q: value.query, sort: value.sort })
  for (const id of value.filters.ownerUserIds ?? []) params.append('owner', id)
  const location = value.filters.location
  if (location)
    params.set('project', location.kind === 'home' ? 'home' : location.id)
  if (value.filters.includeArchived) params.set('includeArchived', 'true')
  const date = value.filters.date
  if (date) {
    params.set('dateField', date.field)
    params.set('period', date.days ? String(date.days) : 'custom')
    if (date.from) params.set('from', date.from)
    if (date.to) params.set('to', date.to)
  }
  return params
}

/** HTML dates are inclusive days; canonical timestamp upper bounds are exclusive. */
export function searchDateValue(value: string | null, upper = false) {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const time = Date.parse(value)
  return Number.isFinite(time)
    ? new Date(time - (upper ? 1 : 0)).toISOString().slice(0, 10)
    : ''
}

export type SearchSelectionNames = {
  owners: Array<{ id: string; name: string }>
  projects: Array<{ id: string; name: string }>
}
export function searchConditionSummary(
  params: URLSearchParams,
  names: SearchSelectionNames | undefined,
  t: Translator['t'],
) {
  const parts: string[] = []
  const owners = params.getAll('owner')
  if (owners.length)
    parts.push(
      `${t('search.owner')}: ${owners.map((id) => names?.owners.find((row) => row.id === id)?.name ?? t('search.unavailable')).join(', ')}`,
    )
  const project = params.get('project')
  if (project)
    parts.push(
      `${t('search.project')}: ${project === 'home' ? t('search.home') : (names?.projects.find((row) => row.id === project)?.name ?? t('search.unavailable'))}`,
    )
  const period = params.get('period')
  if (period) {
    const range =
      period === 'custom'
        ? `${searchDateValue(params.get('from')) || '…'} – ${searchDateValue(params.get('to'), true) || '…'}`
        : t(
            period === '7'
              ? 'search.days7'
              : period === '30'
                ? 'search.days30'
                : 'search.days90',
          )
    parts.push(
      `${t(params.get('dateField') === 'viewed' ? 'search.viewedField' : 'search.updatedField')}: ${range}`,
    )
  }
  if (params.get('includeArchived') === 'true') parts.push(t('search.archived'))
  return parts.join(' · ')
}

/** Remove the last whitespace-delimited word without normalizing the user's text. */
export function reduceSearchKeywords(value: string): string | null {
  const trimmed = value.trim()
  const boundary = trimmed.search(/\s+\S+$/u)
  return boundary < 0 ? null : trimmed.slice(0, boundary)
}
