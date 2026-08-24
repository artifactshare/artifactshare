/* Hallmark · pre-emit critique: P5 H4 E5 S5 R5 V4
 * component: project picker · genre: modern-minimal · theme: existing product system
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: inherited product tokens
 */
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ProjectScopeChip } from '~/components/app/visibility-chip'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { useT } from '~/hooks/use-t'
import { PROJECT_CANDIDATE_SEARCH_THRESHOLD } from '~/lib/project-candidates'
import { cn } from '~/lib/utils'

export type ProjectCandidateOption = {
  id: string
  name: string
  baseVisibility: 'workspace' | 'private'
  updatedAt: string
}

type Page = {
  projects: ProjectCandidateOption[]
  preferredProject: ProjectCandidateOption | null
  nextCursor: string | null
}
type SearchState = Page & {
  status: 'loading' | 'ready' | 'error'
  loadingMore: boolean
  loadMoreError: boolean
  active: number
}

const initialSearchState: SearchState = {
  projects: [],
  preferredProject: null,
  nextCursor: null,
  status: 'loading',
  loadingMore: false,
  loadMoreError: false,
  active: -1,
}

export function ProjectCandidatePicker({
  id,
  ariaLabelledBy,
  purpose,
  userCode,
  value,
  onChange,
}: {
  id: string
  ariaLabelledBy?: string
  purpose: 'bot-destination' | 'agent-approval'
  userCode?: string
  value: ProjectCandidateOption | null
  onChange: (project: ProjectCandidateOption | null) => void
}) {
  const { t, locale } = useT()
  const listId = useId()
  const generation = useRef(0)
  const defaultedScope = useRef<string | null>(null)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState(initialSearchState)
  const [mode, setMode] = useState<'compact' | 'search' | null>(null)
  const [preferredProjectId, setPreferredProjectId] = useState<string | null>(
    null,
  )
  const [open, setOpen] = useState(false)
  const [retryVersion, setRetryVersion] = useState(0)
  const { projects, nextCursor, status, loadingMore, loadMoreError, active } =
    search
  const applyPreferredDefault = useEffectEvent(
    (project: ProjectCandidateOption | null) => {
      if (!value && project) onChange(project)
    },
  )

  const close = () => {
    setOpen(false)
    setSearch((state) => ({ ...state, loadMoreError: false }))
  }

  // useFetcher forwards thrown loader/transport errors to the route
  // ErrorBoundary, while this picker must keep them in its inline error state.
  // react-doctor-disable-next-line no-fetch-in-effect
  useEffect(() => {
    const current = ++generation.current
    const controller = new AbortController()
    const timer = window.setTimeout(
      () => {
        void fetchPage({ purpose, userCode, query, signal: controller.signal })
          .then((page) => {
            if (generation.current !== current) return
            const combined = prependPreferred(page)
            setSearch({
              ...page,
              projects: combined,
              status: 'ready',
              loadingMore: false,
              loadMoreError: false,
              active: combined.length ? 0 : -1,
            })
            if (!query) {
              setPreferredProjectId(page.preferredProject?.id ?? null)
              setMode(
                !page.nextCursor &&
                  combined.length <= PROJECT_CANDIDATE_SEARCH_THRESHOLD
                  ? 'compact'
                  : 'search',
              )
              const scope = `${purpose}:${userCode ?? ''}`
              if (defaultedScope.current !== scope) {
                defaultedScope.current = scope
                applyPreferredDefault(page.preferredProject)
              }
            }
          })
          .catch(() => {
            if (controller.signal.aborted || generation.current !== current)
              return
            setSearch((state) => ({ ...state, status: 'error' }))
          })
      },
      query ? 250 : 0,
    )
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [purpose, query, retryVersion, userCode])

  const retry = () => {
    generation.current += 1
    setSearch(initialSearchState)
    setRetryVersion((current) => current + 1)
  }

  const loadMore = () => {
    if (!nextCursor || loadingMore) return
    const current = generation.current
    setSearch((state) => ({
      ...state,
      loadingMore: true,
      loadMoreError: false,
    }))
    void fetchPage({ purpose, userCode, query, cursor: nextCursor })
      .then((page) => {
        if (generation.current !== current) return
        setSearch((state) => {
          const ids = new Set(state.projects.map((project) => project.id))
          return {
            ...state,
            projects: [
              ...state.projects,
              ...page.projects.filter((project) => !ids.has(project.id)),
            ],
            nextCursor: page.nextCursor,
          }
        })
      })
      .catch(() => {
        if (generation.current === current) {
          setSearch((state) => ({ ...state, loadMoreError: true }))
        }
      })
      .finally(() => {
        if (generation.current === current) {
          setSearch((state) => ({ ...state, loadingMore: false }))
        }
      })
  }

  const choose = (project: ProjectCandidateOption) => {
    onChange(project)
    if (mode === 'search') close()
  }

  if (status === 'loading' && mode === null) {
    return (
      <p className="text-muted-foreground text-sm" aria-live="polite">
        {t('projectPicker.loading')}
      </p>
    )
  }

  if (status === 'error' && mode === null) {
    return <PickerError onRetry={retry} />
  }

  if (status === 'ready' && projects.length === 0 && !query) {
    return <EmptyProjects onRetry={retry} />
  }

  if (mode === 'compact') {
    return (
      <CompactProjectList
        ariaLabelledBy={ariaLabelledBy}
        projects={projects}
        value={value}
        preferredProjectId={preferredProjectId}
        onChange={onChange}
      />
    )
  }

  return (
    <div
      className="flex flex-col gap-[var(--spacing-2)]"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close()
      }}
    >
      <Input
        id={id}
        aria-labelledby={ariaLabelledBy}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && status === 'ready' && active >= 0
            ? `${listId}-${active}`
            : undefined
        }
        aria-autocomplete="list"
        placeholder={t('projectPicker.placeholder')}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          generation.current += 1
          setQuery(event.target.value)
          setSearch(initialSearchState)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
            if (status === 'ready' && projects.length > 0) {
              setSearch((state) => ({
                ...state,
                active: Math.min(projects.length - 1, state.active + 1),
              }))
            }
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            if (status === 'ready' && projects.length > 0) {
              setSearch((state) => ({
                ...state,
                active: Math.max(0, state.active - 1),
              }))
            }
          } else if (
            event.key === 'Enter' &&
            open &&
            status === 'ready' &&
            active >= 0 &&
            projects[active]
          ) {
            event.preventDefault()
            choose(projects[active])
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}
      />
      {value ? (
        <div className="border-border rounded-lg border px-3 py-2">
          <ProjectCandidateLabel
            project={value}
            locale={locale}
            preferred={preferredProjectId === value.id}
          />
        </div>
      ) : null}
      <SearchResults
        open={open}
        listId={listId}
        search={search}
        value={value}
        preferredProjectId={preferredProjectId}
        onChoose={choose}
        onRetry={retry}
        onLoadMore={loadMore}
      />
      <span className="sr-only" aria-live="polite">
        {status === 'ready'
          ? t('projectPicker.count', { count: projects.length })
          : ''}
      </span>
    </div>
  )
}

function SearchResults({
  open,
  listId,
  search,
  value,
  preferredProjectId,
  onChoose,
  onRetry,
  onLoadMore,
}: {
  open: boolean
  listId: string
  search: SearchState
  value: ProjectCandidateOption | null
  preferredProjectId: string | null
  onChoose: (project: ProjectCandidateOption) => void
  onRetry: () => void
  onLoadMore: () => void
}) {
  const { t, locale } = useT()
  const { projects, nextCursor, status, loadingMore, loadMoreError, active } =
    search
  return (
    <>
      {open ? (
        <div
          id={listId}
          role="listbox"
          className="border-border max-h-64 overflow-y-auto rounded-lg border p-1"
        >
          {status === 'loading' ? (
            <p className="text-muted-foreground p-3 text-sm">
              {t('projectPicker.loading')}
            </p>
          ) : status === 'error' ? (
            <PickerError onRetry={onRetry} compact />
          ) : projects.length === 0 ? (
            <p className="text-muted-foreground p-3 text-sm">
              {t('projectPicker.noMatches')}
            </p>
          ) : (
            projects.map((project, index) => (
              <button
                key={project.id}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={value?.id === project.id}
                tabIndex={-1}
                className={cn(
                  'min-h-11 w-full rounded-md px-3 py-2 text-left outline-none',
                  index === active && 'bg-muted',
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onChoose(project)}
              >
                <ProjectCandidateLabel
                  project={project}
                  locale={locale}
                  preferred={preferredProjectId === project.id}
                />
              </button>
            ))
          )}
        </div>
      ) : null}
      {open && nextCursor ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loadingMore}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onLoadMore}
        >
          {loadingMore ? t('projectPicker.loading') : t('projectPicker.more')}
        </Button>
      ) : null}
      {loadMoreError ? (
        <div className="flex items-center gap-[var(--spacing-2)]" role="alert">
          <span className="text-destructive text-sm">
            {t('projectPicker.error')}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onLoadMore}
          >
            {t('projectPicker.retry')}
          </Button>
        </div>
      ) : null}
    </>
  )
}

function CompactProjectList({
  ariaLabelledBy,
  projects,
  value,
  preferredProjectId,
  onChange,
}: {
  ariaLabelledBy?: string
  projects: ProjectCandidateOption[]
  value: ProjectCandidateOption | null
  preferredProjectId: string | null
  onChange: (project: ProjectCandidateOption) => void
}) {
  const { t, locale } = useT()
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  return (
    <div className="flex flex-col gap-[var(--spacing-2)]">
      <div
        role="group"
        className="grid gap-[var(--spacing-2)]"
        aria-label={ariaLabelledBy ? undefined : t('projectPicker.listLabel')}
        aria-labelledby={ariaLabelledBy}
      >
        {projects.map((project, index) => {
          const selected = value?.id === project.id
          return (
            <button
              key={project.id}
              ref={(element) => {
                buttons.current[index] = element
              }}
              type="button"
              aria-pressed={selected}
              className={cn(
                'border-border bg-background min-h-11 w-full rounded-lg border px-3 py-2 text-left outline-none',
                'hover:bg-muted focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 active:translate-y-px',
                selected && 'border-ring bg-muted',
              )}
              onClick={() => onChange(project)}
              onKeyDown={(event) => {
                const forwards =
                  event.key === 'ArrowDown' || event.key === 'ArrowRight'
                const backwards =
                  event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                let next = index
                if (event.key === 'Home') next = 0
                else if (event.key === 'End') next = projects.length - 1
                else if (forwards) next = (index + 1) % projects.length
                else if (backwards) {
                  next = (index - 1 + projects.length) % projects.length
                } else return
                event.preventDefault()
                buttons.current[next]?.focus()
              }}
            >
              <ProjectCandidateLabel
                project={project}
                locale={locale}
                preferred={preferredProjectId === project.id}
              />
            </button>
          )
        })}
      </div>
      <span className="sr-only" aria-live="polite">
        {t('projectPicker.count', { count: projects.length })}
      </span>
    </div>
  )
}

export function ProjectCandidateLabel({
  project,
  locale,
  preferred = false,
}: {
  project: ProjectCandidateOption
  locale: string
  preferred?: boolean
}) {
  const { t } = useT()
  const formatter = useMemo(() => new Intl.DateTimeFormat(locale), [locale])
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="truncate text-sm font-medium">{project.name}</span>
        {preferred ? (
          <span className="text-muted-foreground text-xs font-normal">
            {t('projectPicker.preferred')}
          </span>
        ) : null}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <ProjectScopeChip baseVisibility={project.baseVisibility} />
        <span className="text-muted-foreground text-xs">
          {t('projectPicker.updated', {
            date: formatter.format(new Date(project.updatedAt)),
          })}
        </span>
      </span>
    </span>
  )
}

function PickerError({
  onRetry,
  compact = false,
}: {
  onRetry: () => void
  compact?: boolean
}) {
  const { t } = useT()
  return (
    <div
      role="alert"
      className={cn(
        'flex items-center gap-[var(--spacing-2)]',
        compact ? 'p-2' : 'flex-wrap',
      )}
    >
      <span className="text-destructive text-sm">
        {t('projectPicker.error')}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {t('projectPicker.retry')}
      </Button>
    </div>
  )
}

function EmptyProjects({ onRetry }: { onRetry: () => void }) {
  const { t } = useT()
  return (
    <div className="border-border flex flex-col items-start gap-[var(--spacing-2)] rounded-lg border p-3">
      <p className="text-sm font-medium">{t('projectPicker.emptyTitle')}</p>
      <p className="text-muted-foreground text-sm">
        {t('projectPicker.emptyBody')}
      </p>
      <div className="flex flex-wrap gap-[var(--spacing-2)]">
        <Button asChild type="button" size="sm">
          <a href="/projects?create=1" target="_blank" rel="noreferrer">
            {t('projectPicker.create')}
          </a>
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('projectPicker.retry')}
        </Button>
      </div>
    </div>
  )
}

function prependPreferred(page: Page): ProjectCandidateOption[] {
  if (!page.preferredProject) return page.projects
  return [
    page.preferredProject,
    ...page.projects.filter(
      (project) => project.id !== page.preferredProject?.id,
    ),
  ]
}

async function fetchPage(input: {
  purpose: 'bot-destination' | 'agent-approval'
  userCode?: string
  query: string
  cursor?: string
  signal?: AbortSignal
}): Promise<Page> {
  const params = new URLSearchParams({ purpose: input.purpose, q: input.query })
  if (input.userCode) params.set('user_code', input.userCode)
  if (input.cursor) params.set('cursor', input.cursor)
  const response = await fetch(`/api/project-candidates?${params}`, {
    headers: { accept: 'application/json' },
    signal: input.signal,
  })
  if (!response.ok) throw new Error(`project candidates: ${response.status}`)
  return (await response.json()) as Page
}
