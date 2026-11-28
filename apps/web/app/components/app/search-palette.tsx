import { SearchRequestError, searchResetTime } from '~/lib/search-limit'
import { readSearchJson } from '~/lib/search-query'
import {
  IconSearch,
  IconX,
  IconFolder,
  IconHistory,
  IconLoader2,
} from '@tabler/icons-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { useLocation, useNavigate, useRouteLoaderData } from 'react-router'
import type { loader as searchLoader } from '~/routes/_home/_protected/search'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '~/components/ui/dialog'
import { Popover, PopoverAnchor, PopoverContent } from '~/components/ui/popover'
import { Command } from '~/components/ui/command'
import { Avatar, AvatarFallback } from '~/components/ui/avatar'
import { FileTypeIcon } from './file-type-icon'
import { Highlight } from './search-results'
import { renderTypeFromKind } from '~/lib/artifact-type'
import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'
import { Input } from '~/components/ui/input'
import { shortVisibilityLabelKey } from '~/lib/visibility-labels'
import { useT } from '~/hooks/use-t'
import { searchExit, searchNavigationState } from '~/lib/search-view-state'
import { useViewerCalendar } from '~/hooks/use-viewer-calendar'
import {
  removeSelectedName,
  searchApiParams,
  searchHistoryParams,
  searchConditionSummary,
  type SearchSelectionNames,
} from '~/lib/search-query'
import type { searchSuggestions } from '~/services/search.server'

type Suggestions = Awaited<ReturnType<typeof searchSuggestions>>
const empty: Suggestions = { files: [], recent: [], owners: [], projects: [] }
export type SearchProject = { id: string; name: string }

export function SearchPalette({
  project,
  results = false,
}: {
  project?: SearchProject
  results?: boolean
}) {
  const location = useLocation()
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [editQuery, setEditQuery] = useState<string>()
  const [mobile, setMobile] = useState(false)
  const resultsPage = results || /\/search$/.test(location.pathname)
  const currentQuery = resultsPage
    ? (new URLSearchParams(location.search).get('q') ?? '')
    : ''
  useEffect(() => {
    const media = window.matchMedia('(max-width: 599px)')
    const sync = () => setMobile(media.matches)
    sync()
    media.addEventListener('change', sync)
    const edit = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== 'string')
        return
      setEditQuery(event.detail)
      setOpen(true)
    }
    window.addEventListener('search:edit', edit)
    return () => {
      media.removeEventListener('change', sync)
      window.removeEventListener('search:edit', edit)
    }
  }, [])
  const keepFocus = useRef(false)
  const close = (restoreFocus = true) => {
    setOpen(false)
    setEditQuery(undefined)
    keepFocus.current = !restoreFocus
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus())
  }
  const focusAfterDialog = () => {
    if (!keepFocus.current) trigger.current?.focus()
    keepFocus.current = false
  }
  useSearchShortcuts(setOpen)
  const field = (
    <SearchTrigger
      trigger={trigger}
      mobile={mobile}
      resultsPage={resultsPage}
      currentQuery={currentQuery}
      onOpen={() => setOpen(true)}
    />
  )
  const body = (
    <PaletteBody
      key={`${location.key}:${editQuery ?? currentQuery}`}
      project={project}
      close={close}
      mobile={mobile}
      initialQuery={editQuery ?? currentQuery}
      initialParams={resultsPage ? location.search : ''}
    />
  )
  return (
    <div
      className={
        resultsPage
          ? 'nav:max-w-xl min-w-0 flex-1'
          : 'max-nav:ml-auto max-nav:shrink-0 nav:max-w-xl nav:min-w-0 nav:flex-1'
      }
    >
      {mobile ? (
        <MobileSearch
          field={field}
          body={body}
          open={open}
          setOpen={setOpen}
          close={close}
          focusAfterDialog={focusAfterDialog}
          resultsPage={resultsPage}
        />
      ) : (
        <Popover
          open={open}
          onOpenChange={(value) => (value ? setOpen(true) : close())}
        >
          {open ? body : <PopoverAnchor asChild>{field}</PopoverAnchor>}
        </Popover>
      )}
    </div>
  )
}

function SearchTrigger({
  trigger,
  mobile,
  resultsPage,
  currentQuery,
  onOpen,
}: {
  trigger: RefObject<HTMLButtonElement | null>
  mobile: boolean
  resultsPage: boolean
  currentQuery: string
  onOpen: () => void
}) {
  const { t } = useT()
  return (
    <Button
      ref={trigger}
      variant="outline"
      data-search-trigger
      aria-label={
        mobile && !resultsPage
          ? t('pal.search')
          : `${t('pal.search')}: ${currentQuery || t('pal.placeholder')}${mobile ? '' : ' ⌘K'}`
      }
      className={
        resultsPage
          ? 'text-muted-foreground max-nav:min-w-0 max-nav:flex-1 nav:w-full justify-start gap-2'
          : 'nav:text-muted-foreground nav:w-full nav:justify-start gap-2'
      }
      onClick={onOpen}
    >
      <IconSearch aria-hidden="true" />
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-left',
          !resultsPage && 'max-nav:hidden',
        )}
      >
        {currentQuery || t('pal.placeholder')}
      </span>
      <kbd aria-hidden="true" className="max-nav:hidden text-xs">
        ⌘K
      </kbd>
    </Button>
  )
}

function MobileSearch({
  field,
  body,
  open,
  setOpen,
  close,
  focusAfterDialog,
  resultsPage,
}: {
  field: ReactNode
  body: ReactNode
  open: boolean
  setOpen: (open: boolean) => void
  close: (restoreFocus?: boolean) => void
  focusAfterDialog: () => void
  resultsPage: boolean
}) {
  const { t } = useT()
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <>
      <div className="flex items-center gap-2">
        {field}
        {resultsPage && (
          <Button
            variant="ghost"
            onClick={() => {
              const exit = searchExit(location.state)
              if ('back' in exit) void navigate(-exit.back)
              else void navigate(exit.to, { replace: true })
            }}
          >
            {t('search.cancel')}
          </Button>
        )}
      </div>
      <Dialog
        open={open}
        onOpenChange={(value) => (value ? setOpen(true) : close())}
      >
        <DialogContent
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            focusAfterDialog()
          }}
          className="inset-0 flex h-dvh max-h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-3 rounded-none p-3"
          style={{
            paddingBottom: 'max(var(--spacing-4), env(safe-area-inset-bottom))',
          }}
        >
          <DialogTitle className="sr-only">{t('pal.search')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('pal.placeholder')}
          </DialogDescription>
          {open && body}
        </DialogContent>
      </Dialog>
    </>
  )
}

function useSearchShortcuts(setOpen: Dispatch<SetStateAction<boolean>>) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return
      const shortcut =
        event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)
      const editable =
        event.target instanceof Element &&
        event.target.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
        )
      const slash =
        event.key === '/' &&
        !editable &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      if (shortcut || slash) {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [setOpen])
}

function usePaletteScope(initialParams: string, project?: SearchProject) {
  const { t } = useT()
  const searchData = useRouteLoaderData<typeof searchLoader>(
    'routes/_home/_protected/search',
  )
  const selectedScope =
    searchData?.result && !('error' in searchData.result)
      ? searchData.result.selectedScope
      : undefined
  const [owners, setOwners] = useState<SearchProject[]>(() =>
    new URLSearchParams(initialParams).getAll('owner').map((id) => ({
      id,
      name:
        selectedScope?.owners.find((owner) => owner.id === id)?.name ??
        t('search.unavailable'),
    })),
  )
  const [scope, setScope] = useState<SearchProject | undefined>(() => {
    const id = new URLSearchParams(initialParams).get('project')
    return id
      ? {
          id,
          name:
            id === 'home'
              ? t('search.home')
              : (selectedScope?.projects.find((entry) => entry.id === id)
                  ?.name ?? t('search.unavailable')),
        }
      : project
  })
  return { owners, setOwners, scope, setScope }
}

type SearchHistoryEntry = {
  id: string
  query: string
  filters_json: string
  selectedScope?: SearchSelectionNames
}

function useSearchHistory(retry: number) {
  const [history, setHistory] = useState<SearchHistoryEntry[]>([])
  const [historyError, setHistoryError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/search-logs', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          void response.body?.cancel()
          throw new Error('history')
        }
        return response.json<{ searches: SearchHistoryEntry[] }>()
      })
      .then((data) => {
        const unique = new Map<string, (typeof data.searches)[number]>()
        for (const log of data.searches)
          if (!unique.has(log.filters_json)) unique.set(log.filters_json, log)
        setHistory([...unique.values()])
        setHistoryError(false)
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistoryError(true)
      })
    return () => controller.abort()
  }, [retry])
  return { history, historyError }
}

function PaletteBody({
  project,
  close,
  mobile,
  initialQuery,
  initialParams,
}: {
  project?: SearchProject
  close: (restoreFocus?: boolean) => void
  mobile: boolean
  initialQuery: string
  initialParams: string
}) {
  const { t, locale } = useT(),
    navigate = useNavigate(),
    here = useLocation()
  const input = useRef<HTMLInputElement>(null)
  // Popover defers outside-pointer handling until click, after a chip can unmount.
  const fieldPointers = useRef(new WeakSet<Event>())
  useEffect(() => {
    input.current?.focus()
  }, [])
  const [query, setQuery] = useState(initialQuery)
  const { owners, setOwners, scope, setScope } = usePaletteScope(
    initialParams,
    project,
  )
  const [results, setResults] = useState(empty)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
      'loading',
    ),
    [selected, setSelected] = useState(-1),
    [composing, setComposing] = useState(false),
    [retry, setRetry] = useState(0)
  const [retryAt, setRetryAt] = useState<string>()
  const { history, historyError } = useSearchHistory(retry)
  const sequence = useRef(0),
    composition = useRef(false),
    fetched = useRef(false)
  const params = new URLSearchParams(initialParams)
  params.set('q', query)
  params.delete('owner')
  params.delete('project')
  for (const owner of owners) params.append('owner', owner.id)
  if (scope) params.set('project', scope.id)
  const signature = params.toString()
  useEffect(() => {
    const generation = ++sequence.current
    if (composing) return
    const controller = new AbortController()
    const timer = setTimeout(
      () => {
        fetched.current = true
        setStatus('loading')
        setRetryAt(undefined)
        void fetch(
          `/api/search-suggestions?${searchApiParams(new URLSearchParams(signature))}`,
          {
            signal: controller.signal,
          },
        )
          .then((response) => readSearchJson<Suggestions>(response))
          .then((data: Suggestions) => {
            if (sequence.current === generation) {
              setResults(data)
              setSelected(-1)
              setStatus('ready')
            }
          })
          .catch((error: unknown) => {
            if (!controller.signal.aborted && sequence.current === generation) {
              setRetryAt(
                error instanceof SearchRequestError ? error.retryAt : undefined,
              )
              setStatus('error')
            }
          })
      },
      fetched.current ? 150 : 0,
    )
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [signature, composing, retry])
  useEffect(() => {
    if (selected >= 0)
      document
        .getElementById(`search-option-${selected}`)
        ?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  function go(path: string, submit = false) {
    close(false)
    void navigate(path, {
      state: searchNavigationState(here, { searchSubmission: submit }),
    })
  }
  const submit = (keyboard = true) => {
    if (!retryAt || Date.now() >= Date.parse(retryAt))
      go(`/search?${signature}`, keyboard)
  }
  const choose = (kind: 'owner' | 'project', item: SearchProject) => {
    sequence.current++
    if (kind === 'owner')
      setOwners((values) =>
        values.some((value) => value.id === item.id)
          ? values
          : [...values, item],
      )
    else setScope(item)
    setQuery((value) => removeSelectedName(value, item.name))
    setSelected(-1)
  }
  const { timeZone } = useViewerCalendar()
  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: '2-digit',
        day: '2-digit',
        timeZone,
      }),
    [locale, timeZone],
  )
  const options = retryAt
    ? []
    : paletteOptions({
        query,
        filtered: owners.length > 0 || Boolean(scope),
        results,
        history,
        choose,
        go,
        submit,
        t,
        formatDate: (value: string) => dateFormat.format(new Date(value)),
      })
  const field = (
    <form
      data-search-field
      onPointerDownCapture={(event) =>
        fieldPointers.current.add(event.nativeEvent)
      }
      className="flex min-w-0 items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!composition.current) submit()
      }}
    >
      <div className="border-input bg-background flex min-w-0 flex-1 flex-wrap items-center gap-2 rounded-md border px-2">
        <IconSearch
          className="text-muted-foreground size-4 shrink-0"
          aria-hidden="true"
        />
        {owners.map((owner) => (
          <Button
            key={owner.id}
            type="button"
            variant="secondary"
            className="max-w-full"
            onClick={() => {
              input.current?.focus()
              sequence.current++
              setOwners((values) =>
                values.filter((value) => value.id !== owner.id),
              )
              setSelected(-1)
            }}
          >
            <span className="truncate">
              {t('search.owner')}: {owner.name}
            </span>
            <IconX aria-label={t('search.removeNamed', { name: owner.name })} />
          </Button>
        ))}
        {scope && (
          <Button
            type="button"
            variant="secondary"
            className="max-w-full"
            onClick={() => {
              input.current?.focus()
              sequence.current++
              setScope(undefined)
              setSelected(-1)
            }}
          >
            <span className="truncate">
              {t('search.project')}: {scope.name}
            </span>
            <IconX aria-label={t('search.removeNamed', { name: scope.name })} />
          </Button>
        )}
        <Input
          ref={input}
          className="min-w-16 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          placeholder={t('pal.placeholder')}
          role="combobox"
          aria-label={t('search.keyword')}
          aria-expanded="true"
          aria-controls="search-options"
          aria-autocomplete="list"
          aria-activedescendant={
            selected >= 0 ? `search-option-${selected}` : undefined
          }
          enterKeyHint="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(-1)
            sequence.current++
          }}
          onCompositionStart={() => {
            composition.current = true
            setComposing(true)
            sequence.current++
            setSelected(-1)
          }}
          onCompositionEnd={(event) => {
            composition.current = false
            setComposing(false)
            setQuery(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              close()
              return
            }
            if (
              composition.current ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            ) {
              if (event.key === 'Enter') event.preventDefault()
              return
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setSelected((value) =>
                event.key === 'ArrowDown'
                  ? Math.min(options.length - 1, value + 1)
                  : Math.max(0, value - 1),
              )
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              if (selected >= 0) options[selected]?.activate(true)
              else submit()
            }
          }}
        />
      </div>
      {mobile && (
        <Button type="button" variant="ghost" onClick={() => close()}>
          {t('search.cancel')}
        </Button>
      )}
    </form>
  )
  const candidates = (
    <PaletteCandidates
      options={options}
      query={query}
      status={status}
      historyError={historyError}
      retryAt={retryAt}
      selected={selected}
      setSelected={setSelected}
      retry={() => setRetry((value) => value + 1)}
    />
  )
  return mobile ? (
    <>
      {field}
      {candidates}
    </>
  ) : (
    <PalettePopover field={field} fieldPointers={fieldPointers}>
      {candidates}
    </PalettePopover>
  )
}

function PalettePopover({
  field,
  fieldPointers,
  children,
}: {
  field: ReactNode
  fieldPointers: RefObject<WeakSet<Event>>
  children: ReactNode
}) {
  return (
    <>
      <PopoverAnchor asChild>{field}</PopoverAnchor>
      <PopoverContent
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (
            fieldPointers.current.has(event.detail.originalEvent) ||
            (event.target instanceof Element &&
              event.target.closest('[data-search-field]'))
          )
            event.preventDefault()
        }}
        className="flex max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] min-w-80 flex-col p-0"
      >
        {children}
      </PopoverContent>
    </>
  )
}

function PaletteCandidates({
  options,
  query,
  status,
  historyError,
  selected,
  setSelected,
  retry,
  retryAt,
}: {
  options: ReturnType<typeof paletteOptions>
  query: string
  status: 'loading' | 'ready' | 'error'
  historyError: boolean
  selected: number
  setSelected: (value: number) => void
  retry: () => void
  retryAt?: string
}) {
  const { t, locale } = useT()
  return (
    <Command
      shouldFilter={false}
      value=""
      onKeyDown={(event) => event.stopPropagation()}
      className="min-h-0"
    >
      <div
        role="status"
        aria-live="polite"
        className={
          status === 'ready'
            ? 'sr-only'
            : 'text-muted-foreground px-3 py-1 text-sm'
        }
      >
        {status === 'loading' ? (
          <span className="flex items-center gap-2">
            <IconLoader2
              className="size-4 motion-safe:animate-spin motion-safe:[animation-duration:var(--anim-spin-duration)]"
              aria-hidden="true"
            />
            {t(query.trim() ? 'search.loading' : 'search.loadingRecent')}
          </span>
        ) : status === 'error' ? (
          retryAt ? (
            t('search.dailyLimit', { time: searchResetTime(retryAt, locale) })
          ) : (
            t('search.failure')
          )
        ) : (
          t('search.suggestionCount', {
            n: options.filter((option) => option.key !== 'all').length,
          })
        )}
      </div>
      {!retryAt && (status === 'error' || historyError) && (
        <Button onClick={retry}>{t('search.retry')}</Button>
      )}
      <div
        id="search-options"
        role="listbox"
        aria-label={t('pal.search')}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2"
      >
        {options.map((option, index) => (
          <div key={option.key}>
            {option.section &&
              options[index - 1]?.section !== option.section && (
                <p className="text-muted-foreground px-2 py-1 text-xs">
                  {option.section}
                </p>
              )}
            <button
              type="button"
              role="option"
              aria-selected={selected === index}
              id={`search-option-${index}`}
              onPointerMove={() => setSelected(index)}
              onClick={() => option.activate(false)}
              className="hover:bg-accent aria-selected:bg-accent flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left"
            >
              <span className="flex w-full items-start gap-3">
                {option.kind === 'owner' ? (
                  <Avatar size="sm" aria-hidden="true">
                    <AvatarFallback>
                      {option.label.split(': ').at(-1)?.slice(0, 1)}
                    </AvatarFallback>
                  </Avatar>
                ) : option.kind === 'project' ? (
                  <IconFolder className="text-muted-foreground size-5 shrink-0" />
                ) : option.kind === 'file' ? (
                  <FileTypeIcon
                    renderType={
                      option.artifactKind
                        ? renderTypeFromKind(option.artifactKind)
                        : null
                    }
                  />
                ) : option.key === 'all' ? (
                  <IconSearch className="size-4 shrink-0" />
                ) : (
                  <IconHistory className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="block text-sm">
                    <Highlight text={option.label} query={query} />
                  </span>
                  {option.detail && (
                    <span className="text-muted-foreground block text-xs">
                      {option.detail}
                    </span>
                  )}
                  {option.excerpt && (
                    <span className="text-muted-foreground line-clamp-2 text-xs">
                      <Highlight text={option.excerpt} query={query} />
                    </span>
                  )}
                </span>
                {option.kind === 'owner' && (
                  <span className="text-muted-foreground text-xs">
                    {t('search.owner')}
                  </span>
                )}
                {option.kind === 'project' && (
                  <span className="text-muted-foreground text-xs">
                    {t('search.project')}
                  </span>
                )}
                {option.key === 'all' && (
                  <kbd className="text-muted-foreground text-xs">Enter</kbd>
                )}
              </span>
            </button>
          </div>
        ))}
      </div>
      {!retryAt && (
        <p className="max-nav:hidden text-muted-foreground border-t px-3 py-2 text-xs">
          {t('search.keyboardHint')}
        </p>
      )}
    </Command>
  )
}

function paletteOptions({
  query,
  filtered,
  results,
  history,
  choose,
  go,
  submit,
  t,
  formatDate,
}: {
  query: string
  filtered: boolean
  results: Suggestions
  history: Array<{
    id: string
    query: string
    filters_json: string
    selectedScope?: SearchSelectionNames
  }>
  choose: (kind: 'owner' | 'project', item: SearchProject) => void
  go: (path: string, submit?: boolean) => void
  submit: (keyboard?: boolean) => void
  t: ReturnType<typeof useT>['t']
  formatDate: (value: string) => string
}) {
  const options: Array<{
    key: string
    label: string
    detail?: string
    excerpt?: string
    path?: string | null
    artifactKind?: import('~/lib/shareable-types').ArtifactKind | null
    kind?: 'owner' | 'project' | 'file'
    section?: string
    activate: (keyboard?: boolean) => void
  }> = []
  if (query.trim()) {
    for (const owner of results.owners)
      options.push({
        section: t('search.people'),
        key: `owner-${owner.id}`,
        kind: 'owner',
        label: owner.name,
        activate: () => choose('owner', owner),
      })
    for (const item of results.projects)
      options.push({
        section: t('search.people'),
        key: `project-${item.id}`,
        kind: 'project',
        label: item.name,
        activate: () => choose('project', item),
      })
    for (const file of results.files)
      options.push({
        section: t('search.files'),
        key: file.id,
        kind: 'file',
        label: file.title,
        detail: `${file.ownedByViewer ? t('search.me') : file.ownerName} · ${file.project?.name ?? t('tb.home')} · ${file.lastViewedAt ? t('search.viewed', { date: formatDate(file.lastViewedAt) }) : t(shortVisibilityLabelKey(file.visibility))}`,
        excerpt: file.excerpt,
        path: file.path,
        artifactKind: file.artifactKind,
        activate: () => go(`/a/${file.id}`),
      })
  } else {
    for (const file of results.recent)
      options.push({
        section: t('search.recent'),
        key: file.id,
        kind: 'file',
        artifactKind: file.artifactKind,
        label: file.title,
        detail: file.ownedByViewer ? t('search.me') : file.ownerName,
        activate: () => go(`/a/${file.id}`),
      })
    for (const log of history)
      options.push({
        section: t('search.history'),
        key: log.id,
        label: log.query || t('search.files'),
        detail: searchConditionSummary(
          searchHistoryParams(log.filters_json),
          log.selectedScope,
          t,
          { includeSort: true },
        ),
        activate: (keyboard) =>
          go(
            `/search?${searchHistoryParams(log.filters_json)}`,
            Boolean(keyboard),
          ),
      })
  }
  if (query.trim() || filtered)
    options.push({
      key: 'all',
      label: query.trim()
        ? t('search.all', { q: query })
        : t('search.allFiltered'),
      activate: submit,
    })
  return options
}
