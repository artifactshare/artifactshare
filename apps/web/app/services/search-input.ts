import type { DiscoveryFilters } from './search-discovery.server'
export type SearchInput = {
  query: string
  filters: DiscoveryFilters
  sort: 'relevance' | 'newest'
  pageSize: number
  relativeDays?: number
  cursor?: string
}
export type SearchValidation = {
  error: { code: 'validation_error'; fields: string[] }
}
function instant(value: string, end: boolean): Date | undefined {
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    )
  )
    return
  const day = value.slice(0, 10)
  const calendar = new Date(`${day}T00:00:00.000Z`)
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== day
  )
    return
  if (value.length === 10)
    return new Date(calendar.getTime() + (end ? 86400000 : 0))
  if (
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    return
  const result = new Date(value)
  return Number.isFinite(result.getTime()) ? result : undefined
}
export function parseSearchInput(
  params: URLSearchParams,
  now = new Date(),
): SearchInput | SearchValidation {
  const fields: string[] = []
  const query = params.get('q') ?? ''
  if (query.length > 500) fields.push('q')
  for (const key of new Set(params.keys()))
    if (key !== 'owner' && params.getAll(key).length > 1) fields.push(key)
  const ownerUserIds = [...new Set(params.getAll('owner'))].sort()
  if (
    ownerUserIds.some((id) => !id || id.length > 200) ||
    ownerUserIds.length > 100
  )
    fields.push('owner')
  const filters: DiscoveryFilters = { includeArchived: false }
  if (ownerUserIds.length) filters.ownerUserIds = ownerUserIds
  const location = params.get('location'),
    project = params.get('projectId')
  if (location === 'home' && !params.has('projectId'))
    filters.location = { kind: 'home' }
  else if (location === 'project' && project)
    filters.location = { kind: 'project', id: project }
  else if (params.has('location') || params.has('projectId'))
    fields.push('location')
  if (params.has('includeArchived')) {
    if (!['true', 'false'].includes(params.get('includeArchived')!))
      fields.push('includeArchived')
    filters.includeArchived = params.get('includeArchived') === 'true'
  }
  const field = params.get('dateField'),
    days = params.get('days'),
    from = params.get('from'),
    to = params.get('to')
  for (const key of ['dateField', 'days', 'from', 'to'])
    if (params.has(key) && !params.get(key)) fields.push(key)
  if (field || days || from || to) {
    if (field !== 'updated' && field !== 'viewed') fields.push('dateField')
    else if (days) {
      if (
        !['7', '30', '90'].includes(days) ||
        params.has('from') ||
        params.has('to')
      )
        fields.push('days')
      else
        filters.date = {
          field,
          from: new Date(now.getTime() - Number(days) * 86400000),
          to: now,
        }
    } else {
      const lower = from ? instant(from, false) : undefined,
        upper = to ? instant(to, true) : undefined
      if (
        (!from && !to) ||
        (from && !lower) ||
        (to && !upper) ||
        (lower && upper && lower >= upper)
      )
        fields.push('date')
      else filters.date = { field, from: lower, to: upper }
    }
  }
  if (
    params.has('cursor') &&
    (!params.get('cursor') || params.get('cursor')!.length > 200)
  )
    fields.push('cursor')
  const sort = params.get('sort') ?? 'relevance'
  if (sort !== 'relevance' && sort !== 'newest') fields.push('sort')
  const pageSize = Number(params.get('pageSize') ?? 20)
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50)
    fields.push('pageSize')
  if (fields.length || (sort !== 'relevance' && sort !== 'newest'))
    return { error: { code: 'validation_error', fields } }
  return {
    query,
    filters,
    sort,
    pageSize,
    relativeDays: days ? Number(days) : undefined,
    cursor: params.get('cursor') ?? undefined,
  }
}
export function canonicalSearch(input: SearchInput) {
  const scope = input.filters.credentialScope
  const filters = scope
    ? {
        ...input.filters,
        credentialScope: {
          kind: scope.kind,
          familyId: scope.familyId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          agentProfileId: scope.agentProfileId,
          ordinaryBot: Boolean(scope.ordinaryBot),
        },
      }
    : input.filters
  return JSON.stringify({
    query: input.query,
    filters: input.relativeDays
      ? {
          ...filters,
          date: { field: input.filters.date?.field, days: input.relativeDays },
        }
      : filters,
    sort: input.sort,
    pageSize: input.pageSize,
  })
}
