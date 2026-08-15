import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { useT } from '~/hooks/use-t'
import { cn } from '~/lib/utils'

export type ProjectCandidateOption = {
  id: string
  name: string
  baseVisibility: 'workspace' | 'private'
  updatedAt: string
}

type Page = { projects: ProjectCandidateOption[]; nextCursor: string | null }
type SearchState = Page & {
  status: 'loading' | 'ready' | 'error'
  loadingMore: boolean
  loadMoreError: boolean
  active: number
}

const initialSearchState: SearchState = {
  projects: [],
  nextCursor: null,
  status: 'loading',
  loadingMore: false,
  loadMoreError: false,
  active: -1,
}

export function ProjectCandidatePicker({
  id,
  purpose,
  userCode,
  value,
  onChange,
}: {
  id: string
  purpose: 'bot-destination' | 'agent-approval'
  userCode?: string
  value: ProjectCandidateOption | null
  onChange: (project: ProjectCandidateOption | null) => void
}) {
  const { t, locale } = useT()
  const listId = useId()
  const generation = useRef(0)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState(initialSearchState)
  const [open, setOpen] = useState(false)
  const { projects, nextCursor, status, loadingMore, loadMoreError, active } =
    search

  const close = () => {
    setOpen(false)
    setSearch((state) => ({ ...state, loadMoreError: false }))
  }

  useEffect(() => {
    const current = ++generation.current
    const controller = new AbortController()
    const timer = window.setTimeout(
      () => {
        void fetchPage({
          purpose,
          userCode,
          query,
          signal: controller.signal,
        })
          .then((page) => {
            if (generation.current !== current) return
            setSearch({
              ...page,
              status: 'ready',
              loadingMore: false,
              loadMoreError: false,
              active: page.projects.length ? 0 : -1,
            })
          })
          .catch(() => {
            if (controller.signal.aborted || generation.current !== current)
              return
            setSearch((state) => ({ ...state, status: 'error' }))
          })
      },
      query ? 200 : 0,
    )
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [purpose, query, userCode])

  const loadMore = () => {
    if (!nextCursor || loadingMore) return
    const current = generation.current
    setSearch((state) => ({
      ...state,
      loadingMore: true,
      loadMoreError: false,
    }))
    void fetchPage({
      purpose,
      userCode,
      query,
      cursor: nextCursor,
    })
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
    close()
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
        <ProjectLabel
          project={value}
          locale={locale}
          visibilityLabel={t(
            `projectPicker.visibility.${value.baseVisibility}`,
          )}
          selected
        />
      ) : null}
      {open ? (
        <div
          id={listId}
          role="listbox"
          className="border-border max-h-64 overflow-y-auto rounded-md border p-1"
        >
          {status === 'loading' ? (
            <p className="text-muted-foreground p-3 text-sm">
              {t('projectPicker.loading')}
            </p>
          ) : status === 'error' ? (
            <p role="alert" className="text-destructive p-3 text-sm">
              {t('projectPicker.error')}
            </p>
          ) : projects.length === 0 ? (
            <p className="text-muted-foreground p-3 text-sm">
              {t('projectPicker.empty')}
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
                  'w-full rounded-sm px-3 py-2 text-left',
                  index === active && 'bg-accent',
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(project)}
              >
                <ProjectLabel
                  project={project}
                  locale={locale}
                  visibilityLabel={t(
                    `projectPicker.visibility.${project.baseVisibility}`,
                  )}
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
          onClick={loadMore}
        >
          {loadingMore ? t('projectPicker.loading') : t('projectPicker.more')}
        </Button>
      ) : null}
      {loadMoreError ? (
        <p role="alert" className="text-destructive text-sm">
          {t('projectPicker.error')}
        </p>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {status === 'ready'
          ? t('projectPicker.count', { count: projects.length })
          : ''}
      </span>
    </div>
  )
}

function ProjectLabel({
  project,
  locale,
  visibilityLabel,
  selected = false,
}: {
  project: ProjectCandidateOption
  locale: string
  visibilityLabel: string
  selected?: boolean
}) {
  const formatter = useMemo(() => new Intl.DateTimeFormat(locale), [locale])
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-sm font-medium">{project.name}</span>
      <span className="text-muted-foreground text-xs">
        {selected ? '✓ ' : ''}…{project.id.slice(-8)} · {visibilityLabel} ·{' '}
        {formatter.format(new Date(project.updatedAt))}
      </span>
    </span>
  )
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
