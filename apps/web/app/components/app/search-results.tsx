import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Link,
  useLocation,
  useNavigate,
  useNavigation,
  useNavigationType,
} from 'react-router'
import { Button } from '~/components/ui/button'
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from '~/components/ui/empty'
import {
  IconChevronDown,
  IconChevronRight,
  IconFilter,
  IconSearch,
  IconX,
} from '@tabler/icons-react'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '~/components/ui/popover'
import { Checkbox } from '~/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '~/components/ui/radio-group'
import { FileTypeIcon } from './file-type-icon'
import { detectArtifactTypeForUpload } from '~/lib/artifact-type'
import { openSearchField } from './search-field'
import { Input } from '~/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
  SheetClose,
} from '~/components/ui/sheet'
import { VisibilityChip } from './visibility-chip'
import { shortVisibilityLabelKey } from '~/lib/visibility-labels'
import { useT } from '~/hooks/use-t'
import {
  reduceSearchKeywords,
  clearSearchFilters,
  searchApiParams,
  searchDateValue,
  searchConditionSummary,
  readSearchJson,
} from '~/lib/search-query'
import { rememberSearchView, recallSearchView } from '~/lib/search-view-state'
import { prepareQuery, searchMatchSpans } from '~/services/search-index/query'
import type { search, searchGroup } from '~/services/search.server'

type Result = Exclude<Awaited<ReturnType<typeof search>>, { error: unknown }>
type Group = Exclude<
  Awaited<ReturnType<typeof searchGroup>>,
  { error: unknown }
>
type Item = Result['items'][number]
export type SearchResponse =
  | Awaited<ReturnType<typeof search>>
  | import('~/services/search-input').SearchValidation
function recordOpen(searchId: string, receipt: string) {
  void fetch(`/api/search-logs/${searchId}/opens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receipt }),
    keepalive: true,
  }).catch(() => {})
}
export function SearchResults({
  result,
  actor,
}: {
  result: SearchResponse
  actor: string
}) {
  const { t } = useT(),
    location = useLocation(),
    navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  if ('error' in result)
    return (
      <div role="alert" className="space-y-3">
        <p>
          {t(
            result.error.code === 'validation_error'
              ? 'search.invalid'
              : result.error.code === 'search_capacity_exceeded'
                ? 'search.capacity'
                : 'search.failure',
          )}
        </p>
        <Button
          variant="outline"
          onClick={() => openSearchField(params.get('q') ?? '')}
        >
          {t('search.edit')}
        </Button>
        <SearchFilterBar
          params={params}
          facets={undefined}
          selectedScope={undefined}
          actor={actor}
          update={(next) => {
            void navigate(`/search?${next}`, {
              preventScrollReset: true,
              state: { searchFromApp: true },
            })
          }}
        />
        <Button onClick={() => window.location.reload()}>
          {t('search.retry')}
        </Button>
      </div>
    )
  return (
    <ResultBody
      key={new URLSearchParams(location.search).get('q') ?? ''}
      initial={result}
      actor={actor}
    />
  )
}
function ResultBody({
  initial: loaded,
  actor,
}: {
  initial: Result
  actor: string
}) {
  const { t, tPlural, locale } = useT(),
    location = useLocation(),
    navigate = useNavigate(),
    navigation = useNavigation()
  const [restarted, setRestarted] = useState<{
    source: Result
    result: Result
  }>()
  const initial = restarted?.source === loaded ? restarted.result : loaded
  async function restartSearch() {
    const response = await fetch(
      `/api/search?${searchApiParams(new URLSearchParams(location.search))}`,
    )
    const data = await readSearchJson<SearchResponse>(response)
    setRestarted({ source: loaded, result: data })
  }
  const navigationType = useNavigationType()
  const params = new URLSearchParams(location.search),
    query = params.get('q') ?? ''
  const heading = useRef<HTMLHeadingElement>(null)
  const count = (value: number, relation: string) =>
    tPlural(relation === 'gte' ? 'search.lower' : 'search.count', value, {
      formatted: value.toLocaleString(locale),
    })
  const total = count(initial.total.value, initial.total.relation)
  const owners = params.getAll('owner')
  const ownerName =
    initial.selectedScope?.owners.find((row) => row.id === owners[0])?.name ??
    initial.facets?.owners.find((row) => row.id === owners[0])?.name ??
    t('search.unavailable')
  const title = searchHeading(query, owners, ownerName, t)
  useEffect(() => {
    if (location.state?.searchSubmission && navigationType !== 'POP')
      heading.current?.focus({ preventScroll: true })
  }, [location.state, navigationType])
  function update(next: URLSearchParams) {
    void navigate(`/search?${next}`, {
      preventScrollReset: true,
      state: { searchFromApp: true },
    })
  }
  function relax(filter: string) {
    const next = new URLSearchParams(params)
    if (filter === 'owners') next.delete('owner')
    if (filter === 'location') next.delete('project')
    if (filter === 'archive') next.set('includeArchived', 'true')
    if (filter === 'date')
      for (const key of ['period', 'dateField', 'from', 'to']) next.delete(key)
    update(next)
  }
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-xl font-semibold tracking-tight"
        >
          {title}
        </h1>
        <span className="text-muted-foreground text-sm">{total}</span>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {navigation.state !== 'idle' ? t('search.loading') : total}
      </p>
      <SearchFilterBar
        params={params}
        facets={initial.facets}
        selectedScope={initial.selectedScope}
        actor={actor}
        update={update}
        total={total}
      />
      <SearchNotices
        initial={initial}
        itemsLength={initial.items.length}
        total={total}
        query={query}
        owners={owners}
        ownerName={ownerName}
        scope={searchConditionSummary(params, initial.selectedScope, t)}
        onEdit={() => openSearchField(query)}
        onFewer={() => openSearchField(reduceSearchKeywords(query) ?? query)}
        relax={relax}
        count={count}
      />
      <SearchResultListing
        restartSearch={restartSearch}
        key={`${location.search}:${initial.searchLogId}`}
        initial={initial}
        actor={actor}
        query={query}
      />
    </section>
  )
}
function SearchFilterBar({
  params,
  facets,
  selectedScope,
  actor,
  update,
  total,
}: {
  params: URLSearchParams
  facets: Result['facets']
  selectedScope: Result['selectedScope']
  actor: string
  update: (params: URLSearchParams) => void
  total?: string
}) {
  const { t } = useT()
  const navigation = useNavigation()
  const [sheet, setSheet] = useState(false)
  const filters = (
    <SearchFilters
      params={params}
      facets={facets}
      selectedScope={selectedScope}
      actor={actor}
      update={update}
    />
  )
  return (
    <>
      <div className="max-nav:hidden">{filters}</div>
      <div className="nav:hidden flex flex-wrap items-center gap-2">
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetTrigger asChild>
            <Button
              data-search-filters
              variant="outline"
              size="sm"
              className="rounded-full"
            >
              <IconFilter />
              {t('search.filters')}
            </Button>
          </SheetTrigger>
          <SheetContent
            side="bottom"
            className="flex max-h-(--height-search-filter-sheet) flex-col rounded-t-xl p-4"
            style={{
              paddingBottom:
                'max(var(--spacing-4), env(safe-area-inset-bottom))',
            }}
          >
            <div className="flex shrink-0 items-center justify-between">
              <SheetTitle>{t('search.filters')}</SheetTitle>
              <Button
                variant="ghost"
                onClick={() => update(clearSearchFilters(params))}
              >
                {t('search.clearAll')}
              </Button>
            </div>
            <SheetDescription
              className="shrink-0"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {navigation.state !== 'idle'
                ? t('search.loading')
                : (total ?? t('search.failure'))}
            </SheetDescription>
            <div
              data-search-filter-scroll
              className="min-h-0 flex-1 overflow-y-auto"
            >
              <SearchFilters
                params={params}
                facets={facets}
                selectedScope={selectedScope}
                actor={actor}
                update={update}
                clearAll
              />
            </div>
            <SheetClose asChild>
              <Button
                data-search-show-results
                className="w-full shrink-0"
                aria-busy={navigation.state !== 'idle'}
              >
                {navigation.state !== 'idle'
                  ? t('search.loading')
                  : total
                    ? t('search.show', { n: total })
                    : t('search.closeFilters')}
              </Button>
            </SheetClose>
          </SheetContent>
        </Sheet>
        <SelectedFilters
          params={params}
          facets={facets}
          selectedScope={selectedScope}
          update={update}
        />
      </div>
    </>
  )
}

function useFacetChoices(
  kind: 'owners' | 'projects',
  includeArchived: boolean,
) {
  const [name, setName] = useState('')
  const [retry, setRetry] = useState(0)
  const [response, setResponse] = useState<{
    key: string
    choices: Array<{ id: string; name: string }>
    failed: boolean
  }>({ key: '', choices: [], failed: false })
  const key = `${name}:${includeArchived}:${retry}`
  useEffect(() => {
    if (!name.trim()) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void fetch(
        `/api/search-suggestions?q=${encodeURIComponent(name)}&includeArchived=${includeArchived}`,
        { signal: controller.signal },
      )
        .then((reply) => {
          if (!reply.ok) throw new Error('suggestions')
          return reply.json<{
            owners: Array<{ id: string; name: string }>
            projects: Array<{ id: string; name: string }>
          }>()
        })
        .then((data) => {
          if (!controller.signal.aborted)
            setResponse({ key, choices: data[kind], failed: false })
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setResponse((old) => ({ ...old, key, failed: true }))
        })
    }, 150)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [name, includeArchived, key, kind])
  return {
    name,
    setName,
    choices: response.choices,
    status: !name.trim()
      ? 'idle'
      : response.key !== key
        ? 'loading'
        : response.failed
          ? 'error'
          : 'ready',
    retry: () => setRetry((value) => value + 1),
  }
}
function FacetLookupStatus({
  lookup,
}: {
  lookup: ReturnType<typeof useFacetChoices>
}) {
  const { t } = useT()
  if (lookup.status !== 'error' && lookup.status !== 'loading') return null
  return (
    <div role={lookup.status === 'error' ? 'alert' : 'status'}>
      <p>
        {t(
          lookup.status === 'error' ? 'search.lookupFailure' : 'search.loading',
        )}
      </p>
      {lookup.choices.length > 0 && <p>{t('search.previousChoices')}</p>}
      {lookup.status === 'error' && (
        <Button onClick={lookup.retry}>{t('search.retry')}</Button>
      )}
    </div>
  )
}

function hasSearchFilters(params: URLSearchParams) {
  return (
    ['owner', 'project', 'period'].some((key) => params.has(key)) ||
    params.get('includeArchived') === 'true'
  )
}

function SearchFilters({
  params,
  facets,
  selectedScope,
  actor,
  update,
  clearAll = false,
}: {
  clearAll?: boolean
  params: URLSearchParams
  facets: Result['facets']
  selectedScope: Result['selectedScope']
  actor: string
  update: (params: URLSearchParams) => void
}) {
  const { t } = useT()
  const includeArchived = params.get('includeArchived') === 'true'
  const ownerLookup = useFacetChoices('owners', includeArchived)
  const projectLookup = useFacetChoices('projects', includeArchived)
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key === 'period') {
      next.delete('from')
      next.delete('to')
      if (value) next.set('dateField', next.get('dateField') ?? 'updated')
    }
    if (key === 'from' || key === 'to') {
      next.set('period', 'custom')
      next.set('dateField', next.get('dateField') ?? 'updated')
      next.delete('days')
    }
    update(next)
  }
  const selectedSet = new Set(params.getAll('owner'))
  const selected = params.getAll('owner'),
    project = params.get('project') ?? ''
  const ownerChoices = ownerLookup.name
    ? ownerLookup.choices
    : (facets?.owners ?? [])
  const projectChoices = projectLookup.name
    ? projectLookup.choices
    : (facets?.projects ?? [])
  const countLabel = (row: { id?: string; count?: number }) =>
    row.count === undefined ? '' : ` (${row.count})`
  return (
    <div
      className={clearAll ? 'space-y-5' : 'flex flex-wrap items-center gap-2'}
    >
      <FilterMenu label={t('search.owner')} inline={clearAll} menu="owner">
        <div className="space-y-3" data-search-owner>
          <div className="relative">
            <IconSearch
              aria-hidden="true"
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            />
            <Input
              className="pl-9"
              aria-label={t('search.owner')}
              placeholder={t('search.ownerPlaceholder')}
              value={ownerLookup.name}
              onChange={(event) => ownerLookup.setName(event.target.value)}
            />
          </div>
          <FacetLookupStatus lookup={ownerLookup} />
          {[
            ...ownerChoices,
            ...selected
              .filter((id) => !ownerChoices.some((row) => row.id === id))
              .map((id) => ({
                id,
                name:
                  selectedScope?.owners.find((row) => row.id === id)?.name ??
                  t('search.unavailable'),
              })),
          ].map((row) => (
            <label key={row.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selectedSet.has(row.id)}
                onCheckedChange={() => {
                  const next = new URLSearchParams(params)
                  next.delete('owner')
                  for (const id of selectedSet.has(row.id)
                    ? selected.filter((ownerId) => ownerId !== row.id)
                    : [...selected, row.id])
                    next.append('owner', id)
                  update(next)
                }}
              />
              {row.id === actor ? t('search.me') : row.name}
              {countLabel(row)}
            </label>
          ))}
        </div>
      </FilterMenu>
      <FilterMenu label={t('search.project')} inline={clearAll}>
        <div className="space-y-3">
          <div className="relative">
            <IconSearch
              aria-hidden="true"
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            />
            <Input
              className="pl-9"
              aria-label={t('search.project')}
              placeholder={t('search.projectPlaceholder')}
              value={projectLookup.name}
              onChange={(event) => projectLookup.setName(event.target.value)}
            />
          </div>
          <FacetLookupStatus lookup={projectLookup} />
          <RadioGroup
            aria-label={t('search.project')}
            value={project || 'all'}
            onValueChange={(value) =>
              change('project', value === 'all' ? '' : value)
            }
          >
            {[
              { id: 'all', name: t('search.allProjects') },
              {
                id: 'home',
                name: t('search.home'),
                count: facets?.projects.find((row) => row.id === 'home')?.count,
              },
              ...projectChoices.filter((row) => row.id !== 'home'),
              ...(project &&
              project !== 'home' &&
              !projectChoices.some((row) => row.id === project)
                ? [
                    {
                      id: project,
                      name:
                        selectedScope?.projects.find(
                          (row) => row.id === project,
                        )?.name ?? t('search.unavailable'),
                    },
                  ]
                : []),
            ].map((row) => (
              <label
                key={row.id}
                className="flex items-center gap-2 py-1 text-sm"
              >
                <RadioGroupItem value={row.id} />
                {row.name}
                {countLabel(row)}
              </label>
            ))}
          </RadioGroup>
          <label className="flex gap-2 text-sm">
            <Checkbox
              checked={params.get('includeArchived') === 'true'}
              onCheckedChange={(checked) =>
                change('includeArchived', String(checked === true))
              }
            />
            {t('search.archived')}
          </label>
        </div>
      </FilterMenu>
      <DateSortFilters params={params} change={change} inline={clearAll} />
      {!clearAll && (
        <SelectedFilters
          params={params}
          selectedScope={selectedScope}
          facets={facets}
          update={update}
        />
      )}
      {!clearAll && hasSearchFilters(params) && (
        <Button
          variant="ghost"
          onClick={() => update(clearSearchFilters(params))}
        >
          {t('search.remove')}
        </Button>
      )}
    </div>
  )
}
const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' })
export function Highlight({ text, query }: { text: string; query: string }) {
  const segments = Array.from(segmenter.segment(text))
  const spans = searchMatchSpans(text, query)
  return (
    <>
      {segments.map((part) => {
        return spans.some(
          ([a, b]) => part.index < b && part.index + part.segment.length > a,
        ) ? (
          <mark className="bg-search-highlight text-inherit" key={part.index}>
            {part.segment}
          </mark>
        ) : (
          <span key={part.index}>{part.segment}</span>
        )
      })}
    </>
  )
}
function SearchResultRow({
  item,
  actor,
  query,
  searchId,
  initiallyExpanded,
  restoreDepth,
  onGroupDepth,
  onExpand,
  beforeOpen,
  onRestored,
  restartSearch,
}: {
  restartSearch: () => Promise<void>
  restoreDepth: number
  onGroupDepth: (id: string, depth: number) => void
  initiallyExpanded: boolean
  onExpand: (id: string, open: boolean) => void
  beforeOpen: (anchor: string) => void
  onRestored: (id: string) => void
  item: Item
  actor: string
  query: string
  searchId: string
}) {
  const { t, locale } = useT(),
    location = useLocation()
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const { group, error, pending, loadGroup, recover } = useSearchGroup(
    item,
    initiallyExpanded,
    restoreDepth,
    onGroupDepth,
    onRestored,
    restartSearch,
  )
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: '2-digit',
        day: '2-digit',
        timeZone: 'UTC',
      }),
    [locale],
  )
  const date = (value: string) => formatter.format(new Date(value))
  const returnTo = `${location.pathname}${location.search}${location.hash}`
  return (
    <li id={`search-file-${item.id}`} className="relative space-y-2 py-4 pl-9">
      <div className="absolute top-4 left-0">
        <FileTypeIcon
          renderType={detectArtifactTypeForUpload(null, item.path ?? '')}
        />
      </div>
      <SearchRowHeader
        item={item}
        actor={actor}
        query={query}
        returnTo={returnTo}
        beforeOpen={beforeOpen}
        searchId={searchId}
        date={date}
      />
      <SearchExcerpt item={item} query={query} />
      {item.groupSize > 1 && (
        <Button
          variant="link"
          className="h-auto p-0 text-sm"
          data-search-group
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((value) => !value)
            onExpand(item.id, !expanded)
            if (!group && !expanded) void loadGroup()
          }}
        >
          <IconChevronRight className={expanded ? 'rotate-90' : ''} />
          {t(
            item.groupSizeRelation === 'gte'
              ? 'search.groupLower'
              : 'search.group',
            { n: item.groupSize - 1 },
          )}
        </Button>
      )}
      {expanded && (
        <div className="border-divider ml-2 space-y-2 border-l pl-4">
          {group?.items.map((row) => (
            <div
              key={row.id}
              id={`search-file-${row.id}`}
              className="flex flex-wrap gap-3 text-sm"
            >
              <Link
                to={`/a/${row.id}`}
                state={{ galleryReturnTo: returnTo }}
                onClick={() => {
                  beforeOpen(row.id)
                  recordOpen(searchId, row.receipt)
                }}
                className="text-link"
              >
                {row.title}
              </Link>
              <span className="text-muted-foreground ml-auto">
                {t('search.updated', { date: date(row.updatedAt) })}
              </span>
              {row.lastViewedAt && (
                <span className="text-muted-foreground">
                  {t('search.viewed', { date: date(row.lastViewedAt) })}
                </span>
              )}
            </div>
          ))}
          {pending && <p role="status">{t('search.loading')}</p>}
          {error && (
            <div role="alert" className="space-y-3">
              <p>{t('search.continuation')}</p>
              <Button disabled={pending} onClick={() => void recover()}>
                {t(
                  error === 'invalid_cursor'
                    ? 'search.restart'
                    : 'search.retry',
                )}
              </Button>
            </div>
          )}
          {group?.nextCursor && !error && (
            <Button
              disabled={pending}
              onClick={() => void loadGroup(group.nextCursor ?? undefined)}
            >
              {t(
                group.total.relation === 'gte'
                  ? 'search.moreLower'
                  : 'search.more',
                {
                  n: Math.max(1, group.total.value - group.items.length - 1),
                },
              )}
            </Button>
          )}
        </div>
      )}
    </li>
  )
}

function SearchRowHeader({
  item,
  actor,
  query,
  returnTo,
  beforeOpen,
  searchId,
  date,
}: {
  item: Item
  actor: string
  query: string
  returnTo: string
  beforeOpen: (id: string) => void
  searchId: string
  date: (value: string) => string
}) {
  const { t } = useT()
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Link
            to={`/a/${item.id}`}
            state={{ galleryReturnTo: returnTo }}
            onClick={() => {
              beforeOpen(item.id)
              recordOpen(searchId, item.receipt)
            }}
            className="text-link font-medium break-words"
          >
            <Highlight text={item.title} query={query} />
          </Link>
          <p className="max-nav:hidden text-muted-foreground text-sm">
            {item.ownerId === actor ? t('search.me') : item.ownerName} ·{' '}
            {item.project?.name ?? t('tb.home')}
          </p>
        </div>
        <div className="max-nav:hidden ml-auto">
          <VisibilityChip
            visibility={item.visibility}
            label={t(shortVisibilityLabelKey(item.visibility))}
          />
        </div>
        <div className="max-nav:hidden text-muted-foreground w-24 shrink-0 space-y-1 text-xs">
          <p>{t('search.updated', { date: date(item.updatedAt) })}</p>
          {item.lastViewedAt && (
            <p>{t('search.viewed', { date: date(item.lastViewedAt) })}</p>
          )}
        </div>
      </div>
      <div className="nav:hidden text-muted-foreground flex flex-wrap items-center gap-x-1 gap-y-1 text-xs">
        <span>{item.ownerId === actor ? t('search.me') : item.ownerName}</span>
        <span aria-hidden="true">·</span>
        <span>{item.project?.name ?? t('tb.home')}</span>
        <span aria-hidden="true">·</span>
        <span>{t('search.updated', { date: date(item.updatedAt) })}</span>
        {item.lastViewedAt && (
          <>
            <span aria-hidden="true">·</span>
            <span>{t('search.viewed', { date: date(item.lastViewedAt) })}</span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <VisibilityChip
          visibility={item.visibility}
          label={t(shortVisibilityLabelKey(item.visibility))}
        />
      </div>
    </>
  )
}

function SearchExcerpt({ item, query }: { item: Item; query: string }) {
  const { t } = useT()
  return (
    <>
      {query.trim() && (
        <p className="text-muted-foreground text-sm">
          {item.hasBody === false ? (
            t('search.bodyless')
          ) : (
            <Highlight text={item.excerpt} query={query} />
          )}
        </p>
      )}
      {item.tier === 'any' && (
        <p className="text-muted-foreground text-xs">
          {t('search.matched', {
            terms: item.matchedKeywords?.join(' · ') ?? '',
          })}
        </p>
      )}
    </>
  )
}

function useSearchGroup(
  item: Item,
  initiallyExpanded: boolean,
  restoreDepth: number,
  onGroupDepth: (id: string, depth: number) => void,
  onRestored: (id: string) => void,
  restartSearch: () => Promise<void>,
) {
  const [group, setGroup] = useState<Group>()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const loadedDepth = useRef(0)
  async function loadGroup(cursor?: string, restoring = false) {
    setPending(true)
    setError('')
    try {
      do {
        const response = await fetch(
          `/api/search-groups?${new URLSearchParams({ receipt: item.receipt, ...(cursor ? { cursor } : {}) })}`,
        )
        const data =
          await readSearchJson<Awaited<ReturnType<typeof searchGroup>>>(
            response,
          )
        loadedDepth.current = cursor ? loadedDepth.current + 1 : 1
        onGroupDepth(item.id, loadedDepth.current)
        const append = Boolean(cursor)
        setGroup((old) => ({
          ...data,
          items:
            append && old
              ? [
                  ...old.items,
                  ...data.items.filter(
                    (row) => !old.items.some((member) => member.id === row.id),
                  ),
                ]
              : data.items,
        }))
        cursor = data.nextCursor ?? undefined
      } while (restoring && cursor && loadedDepth.current < restoreDepth)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'request_failed')
    } finally {
      setPending(false)
      if (initiallyExpanded) onRestored(item.id)
    }
  }
  const loadGroupRef = useRef(loadGroup)
  useEffect(() => {
    if (initiallyExpanded) void loadGroupRef.current(undefined, true)
  }, [initiallyExpanded])
  async function recover() {
    if (error !== 'invalid_cursor') {
      await loadGroup(group?.nextCursor ?? undefined)
      return
    }
    setPending(true)
    try {
      await restartSearch()
    } catch {
      setError('invalid_cursor')
    } finally {
      setPending(false)
    }
  }
  return { group, error, pending, loadGroup, recover }
}

function FilterMenu({
  label,
  inline,
  children,
  sort = false,
  menu,
}: {
  label: string
  inline: boolean
  children: ReactNode
  sort?: boolean
  menu?: 'owner'
}) {
  if (inline)
    return (
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{label}</h3>
        {children}
      </section>
    )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          data-search-sort={sort || undefined}
          data-search-menu={menu}
          variant="outline"
          size="sm"
          className={sort ? 'order-last ml-auto rounded-full' : 'rounded-full'}
        >
          {label}
          <IconChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-96 overflow-y-auto">
        {children}
      </PopoverContent>
    </Popover>
  )
}
function SelectedFilters({
  params,
  selectedScope,
  facets,
  update,
}: {
  params: URLSearchParams
  selectedScope: Result['selectedScope']
  facets: Result['facets']
  update: (params: URLSearchParams) => void
}) {
  const { t } = useT()
  const choices = [
    ...params.getAll('owner').map((id) => ({
      key: 'owner',
      id,
      name:
        selectedScope?.owners.find((row) => row.id === id)?.name ??
        facets?.owners.find((row) => row.id === id)?.name ??
        t('search.unavailable'),
    })),
    ...(params.has('project')
      ? [
          {
            key: 'project',
            id: params.get('project')!,
            name:
              params.get('project') === 'home'
                ? t('search.home')
                : (selectedScope?.projects.find(
                    (row) => row.id === params.get('project'),
                  )?.name ??
                  facets?.projects.find(
                    (row) => row.id === params.get('project'),
                  )?.name ??
                  t('search.unavailable')),
          },
        ]
      : []),
  ]
  return (
    <>
      {choices.map((row) => (
        <Button
          key={row.key + row.id}
          size="sm"
          variant="secondary"
          className="max-w-full rounded-full"
          onClick={() => {
            const next = new URLSearchParams(params)
            next.delete(row.key, row.id)
            update(next)
          }}
        >
          <span className="truncate">
            {t(row.key === 'owner' ? 'search.owner' : 'search.project')}:{' '}
            {row.name}
          </span>
          <IconX aria-label={t('search.removeNamed', { name: row.name })} />
        </Button>
      ))}
    </>
  )
}
function DateSortFilters({
  params,
  change,
  inline,
}: {
  params: URLSearchParams
  change: (key: string, value: string) => void
  inline: boolean
}) {
  const { t } = useT()
  const [customFor, setCustomFor] = useState<string>()
  const customOpen = customFor === params.toString()
  const sort =
    params.get('sort') ??
    (!params.get('q')?.trim() && params.has('owner') ? 'newest' : 'relevance')
  return (
    <>
      <FilterMenu label={t('search.period')} inline={inline}>
        <div className="space-y-4">
          <RadioGroup
            aria-label={t('search.dateField')}
            value={params.get('dateField') ?? 'updated'}
            onValueChange={(value) => change('dateField', value)}
          >
            {(['updated', 'viewed'] as const).map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <RadioGroupItem value={value} />
                {t(
                  value === 'updated'
                    ? 'search.updatedField'
                    : 'search.viewedField',
                )}
              </label>
            ))}
          </RadioGroup>
          <RadioGroup
            aria-label={t('search.period')}
            value={customOpen ? 'custom' : (params.get('period') ?? 'all')}
            onValueChange={(value) => {
              setCustomFor(value === 'custom' ? params.toString() : undefined)
              if (value !== 'custom')
                change('period', value === 'all' ? '' : value)
            }}
          >
            {(
              [
                ['all', 'search.allTime'],
                ['7', 'search.days7'],
                ['30', 'search.days30'],
                ['90', 'search.days90'],
                ['custom', 'search.custom'],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className="flex items-center gap-2 py-1 text-sm"
              >
                <RadioGroupItem value={value} />
                {t(label)}
              </label>
            ))}
          </RadioGroup>
          {(customOpen || params.get('period') === 'custom') && (
            <div className="space-y-2">
              <Input
                type="date"
                aria-label={t('search.from')}
                value={searchDateValue(params.get('from'))}
                onChange={(event) => change('from', event.target.value)}
              />
              <Input
                type="date"
                aria-label={t('search.to')}
                value={searchDateValue(params.get('to'), true)}
                onChange={(event) => change('to', event.target.value)}
              />
            </div>
          )}
        </div>
      </FilterMenu>
      <FilterMenu
        label={t(
          inline
            ? 'search.sort'
            : sort === 'newest'
              ? 'search.newest'
              : 'search.relevance',
        )}
        inline={inline}
        sort
      >
        <RadioGroup
          aria-label={t('search.sort')}
          value={sort}
          onValueChange={(value) => change('sort', value)}
        >
          {(['relevance', 'newest'] as const).map((value) => (
            <label key={value} className="flex items-center gap-2 py-1 text-sm">
              <RadioGroupItem data-search-sort-value={value} value={value} />
              {t(value === 'relevance' ? 'search.relevance' : 'search.newest')}
            </label>
          ))}
        </RadioGroup>
      </FilterMenu>
    </>
  )
}

function searchHeading(
  query: string,
  owners: string[],
  ownerName: string,
  t: ReturnType<typeof useT>['t'],
) {
  if (query.trim()) return t('search.heading', { q: query })
  if (owners.length === 1) return t('search.ownerHeading', { name: ownerName })
  return t('search.fileHeading')
}

function relaxationLabel(filter: string, t: ReturnType<typeof useT>['t']) {
  if (filter === 'owners') return t('search.owner')
  if (filter === 'location') return t('search.project')
  if (filter === 'date') return t('search.period')
  return t('search.archiveFilter')
}

function searchEmptyTitle(
  query: string,
  owners: string[],
  ownerName: string,
  scope: string,
  t: ReturnType<typeof useT>['t'],
) {
  if (owners.length === 1)
    return t(query.trim() ? 'search.zeroOwner' : 'search.zeroOwnerNoQuery', {
      name: ownerName,
      q: query,
    })
  if (query.trim())
    return t(scope ? 'search.zero' : 'search.zeroUnfiltered', { q: query })
  return t(scope ? 'search.zeroNoQuery' : 'search.zeroNoQueryUnfiltered')
}

function SearchNotices({
  initial,
  itemsLength,
  total,
  query,
  owners,
  ownerName,
  scope,
  onEdit,
  onFewer,
  relax,
  count,
}: {
  initial: Result
  itemsLength: number
  total: string
  query: string
  owners: string[]
  ownerName: string
  scope: string
  onFewer: () => void
  onEdit: () => void
  relax: (filter: string) => void
  count: (value: number, relation: string) => string
}) {
  const { t, locale } = useT()
  const isEmpty =
    !itemsLength && initial.total.value === 0 && initial.total.relation === 'eq'
  const relaxationButtons = initial.relaxations.map((row) => (
    <Button
      key={row.filter}
      variant="outline"
      onClick={() => relax(row.filter)}
    >
      {t('search.relax', {
        filter: relaxationLabel(row.filter, t),
        n: count(row.total.value, row.total.relation),
      })}
    </Button>
  ))
  return (
    <>
      {' '}
      {initial.tier === 'any' && (
        <div>
          <h2 className="font-semibold">{t('search.any', { n: total })}</h2>
          <p>
            {t('search.missingAll', {
              q: prepareQuery(query).terms.join(
                locale === 'ja' ? '』『' : '", "',
              ),
            })}
          </p>
        </div>
      )}
      {isEmpty && (
        <Empty data-search-zero>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconSearch aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle role="heading" aria-level={2}>
              {searchEmptyTitle(query, owners, ownerName, scope, t)}
            </EmptyTitle>
            {scope && <p className="text-muted-foreground text-sm">{scope}</p>}
            <EmptyDescription>{t('search.searched')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {relaxationButtons}
            <Button variant="outline" onClick={onEdit}>
              {t('search.edit')}
            </Button>
            {reduceSearchKeywords(query) !== null && (
              <Button variant="outline" onClick={onFewer}>
                {t('search.fewer')}
              </Button>
            )}
          </EmptyContent>
        </Empty>
      )}
      {!itemsLength && initial.total.relation === 'gte' && (
        <p>{t('search.partial')}</p>
      )}
      {!isEmpty && relaxationButtons}
    </>
  )
}

function SearchResultListing({
  restartSearch,
  initial,
  actor,
  query,
}: {
  initial: Result
  actor: string
  query: string
  restartSearch: () => Promise<void>
}) {
  const { t } = useT(),
    location = useLocation(),
    navigationType = useNavigationType()
  const params = new URLSearchParams(location.search)
  const returnKey = `${location.pathname}${location.search}${location.hash}`
  const [restore] = useState(() =>
    navigationType === 'POP'
      ? recallSearchView(location.key)
      : location.state?.galleryFocusFallback
        ? recallSearchView(returnKey)
        : undefined,
  )
  const [depth, setDepth] = useState(1)
  const [restored, setRestored] = useState(!restore)
  const restoredGroups = useMemo(
    () => new Set(restore?.expanded ?? []),
    [restore],
  )
  const expandedGroups = useRef(restoredGroups)
  const groupDepths = useRef<Record<string, number>>({
    ...restore?.groupDepths,
  })
  const [settledGroups, setSettledGroups] = useState(() => new Set<string>())
  const [items, setItems] = useState(initial.items),
    [cursor, setCursor] = useState(initial.nextCursor)
  const [pending, setPending] = useState(false),
    [failure, setFailure] = useState('')
  const sentinel = useRef<HTMLDivElement>(null),
    nextCursor = useRef(initial.nextCursor),
    busy = useRef(false),
    alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  async function more() {
    if (!nextCursor.current || busy.current) return
    busy.current = true
    setPending(true)
    setFailure('')
    try {
      const api = searchApiParams(params)
      api.set('cursor', nextCursor.current)
      const response = await fetch(`/api/search?${api}`)
      const data = await readSearchJson<SearchResponse>(response)
      if (alive.current) {
        setItems((old) =>
          [
            ...old,
            ...data.items.filter(
              (row) => !old.some((item) => item.id === row.id),
            ),
          ].slice(0, 1000),
        )
        nextCursor.current = data.nextCursor
        setCursor(data.nextCursor)
        setDepth((value) => value + 1)
      }
    } catch (error) {
      if (alive.current)
        setFailure(error instanceof Error ? error.message : 'request_failed')
    } finally {
      busy.current = false
      if (alive.current) setPending(false)
    }
  }
  const moreRef = useRef(more)
  useEffect(() => {
    moreRef.current = more
  })
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !failure)
        void moreRef.current()
    })
    const node = sentinel.current
    if (node) observer.observe(node)
    return () => observer.disconnect()
  }, [cursor, failure])
  const waitingForGroups = items.some(
    (row) => restoredGroups.has(row.id) && !settledGroups.has(row.id),
  )
  useEffect(() => {
    if (!restore || restored || failure || pending) return
    if (cursor && depth < Math.min(50, restore.depth)) {
      void moreRef.current()
      return
    }
    if (waitingForGroups) return
    const frame = requestAnimationFrame(() => {
      const anchor =
        document.getElementById(`search-file-${restore.anchor}`) ??
        document.getElementById(
          `search-file-${items[Math.min(restore.position, items.length - 1)]?.id}`,
        )
      if (anchor)
        window.scrollTo({
          top:
            window.scrollY +
            anchor.getBoundingClientRect().top -
            restore.offset,
        })
      setRestored(true)
    })
    return () => cancelAnimationFrame(frame)
  }, [
    restore,
    restored,
    depth,
    cursor,
    pending,
    failure,
    waitingForGroups,
    items,
  ])
  function remember(anchor: string, parent = anchor) {
    const element = document.getElementById(`search-file-${anchor}`)
    const view = {
      depth,
      expanded: [...expandedGroups.current],
      groupDepths: { ...groupDepths.current },
      anchor,
      position: items.findIndex((item) => item.id === parent),
      offset: element?.getBoundingClientRect().top ?? 0,
    }
    rememberSearchView(location.key, view)
    rememberSearchView(returnKey, view)
  }
  const rememberVisible = useRef(() => {})
  useEffect(() => {
    rememberVisible.current = () => {
      const visible = items.find((item) => {
        const node = document.getElementById(`search-file-${item.id}`)
        return node && node.getBoundingClientRect().bottom > 0
      })
      if (visible) remember(visible.id)
    }
    if (restored) rememberVisible.current()
  })
  useEffect(() => {
    const save = () => rememberVisible.current()
    window.addEventListener('scroll', save, { passive: true })
    // Capture before router click/submit handlers change the active history entry.
    document.addEventListener('click', save, true)
    document.addEventListener('submit', save, true)
    return () => {
      window.removeEventListener('scroll', save)
      document.removeEventListener('click', save, true)
      document.removeEventListener('submit', save, true)
    }
  }, [])
  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? t('search.loading') : t('search.count', { n: items.length })}
      </p>
      <ul className="divide-divider divide-y">
        {items.map((item) => (
          <SearchResultRow
            restartSearch={restartSearch}
            key={item.id}
            item={item}
            actor={actor}
            query={query}
            searchId={initial.searchLogId}
            initiallyExpanded={restoredGroups.has(item.id)}
            onExpand={(id, open) => {
              if (open) expandedGroups.current.add(id)
              else expandedGroups.current.delete(id)
            }}
            restoreDepth={restore?.groupDepths?.[item.id] ?? 1}
            onGroupDepth={(id, pages) => {
              groupDepths.current[id] = pages
            }}
            beforeOpen={(anchor) => remember(anchor, item.id)}
            onRestored={(id) =>
              setSettledGroups((current) => new Set([...current, id]))
            }
          />
        ))}
      </ul>
      {failure && (
        <div role="alert" className="space-y-3">
          <p>{t('search.continuation')}</p>
          <Button
            onClick={() =>
              failure === 'invalid_cursor'
                ? window.location.reload()
                : void more()
            }
          >
            {t(
              failure === 'invalid_cursor' ? 'search.restart' : 'search.retry',
            )}
          </Button>
        </div>
      )}
      {cursor && !failure && (
        <div ref={sentinel}>
          <Button
            data-search-load-more
            disabled={pending}
            variant="ghost"
            onClick={() => void more()}
          >
            {t(pending ? 'search.loading' : 'search.loadMore')}
          </Button>
        </div>
      )}
      {initial.total.relation === 'gte' && initial.total.value === 1000 && (
        <p className="text-muted-foreground text-sm">
          {t(
            params.get('sort') === 'newest' ||
              (!query.trim() && params.has('owner') && !params.has('sort'))
              ? 'search.capNewest'
              : 'search.cap',
          )}
        </p>
      )}
    </>
  )
}
