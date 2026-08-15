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

export function ProjectCandidatePicker({
  purpose,
  userCode,
  value,
  onChange,
}: {
  purpose: 'bot-destination' | 'agent-approval'
  userCode?: string
  value: ProjectCandidateOption | null
  onChange: (project: ProjectCandidateOption | null) => void
}) {
  const { t, locale } = useT()
  const inputId = useId()
  const listId = useId()
  const generation = useRef(0)
  const [query, setQuery] = useState('')
  const [projects, setProjects] = useState<ProjectCandidateOption[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  useEffect(() => {
    const current = ++generation.current
    const controller = new AbortController()
    const timer = window.setTimeout(
      () => {
        setStatus('loading')
        void fetchPage({
          purpose,
          userCode,
          query,
          signal: controller.signal,
        })
          .then((page) => {
            if (generation.current !== current) return
            setProjects(page.projects)
            setNextCursor(page.nextCursor)
            setActive(page.projects.length ? 0 : -1)
            setStatus('ready')
          })
          .catch(() => {
            if (controller.signal.aborted || generation.current !== current)
              return
            setStatus('error')
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
    setLoadingMore(true)
    void fetchPage({
      purpose,
      userCode,
      query,
      cursor: nextCursor,
    })
      .then((page) => {
        if (generation.current !== current) return
        setProjects((existing) => {
          const ids = new Set(existing.map((project) => project.id))
          return [
            ...existing,
            ...page.projects.filter((project) => !ids.has(project.id)),
          ]
        })
        setNextCursor(page.nextCursor)
      })
      .finally(() => {
        if (generation.current === current) setLoadingMore(false)
      })
  }

  const choose = (project: ProjectCandidateOption) => {
    onChange(project)
    setOpen(false)
  }

  return (
    <div className="flex flex-col gap-[var(--spacing-2)]">
      <Input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && active >= 0 ? `${listId}-${active}` : undefined
        }
        aria-autocomplete="list"
        placeholder={t('projectPicker.placeholder')}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
            setActive((index) => Math.min(projects.length - 1, index + 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((index) => Math.max(0, index - 1))
          } else if (event.key === 'Enter' && open && active >= 0) {
            event.preventDefault()
            choose(projects[active]!)
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }
        }}
      />
      {value ? <ProjectLabel project={value} locale={locale} selected /> : null}
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
                <ProjectLabel project={project} locale={locale} />
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
          onClick={loadMore}
        >
          {loadingMore ? t('projectPicker.loading') : t('projectPicker.more')}
        </Button>
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
  selected = false,
}: {
  project: ProjectCandidateOption
  locale: string
  selected?: boolean
}) {
  const formatter = useMemo(() => new Intl.DateTimeFormat(locale), [locale])
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-sm font-medium">{project.name}</span>
      <span className="text-muted-foreground text-xs">
        {selected ? '✓ ' : ''}…{project.id.slice(-8)} · {project.baseVisibility}{' '}
        · {formatter.format(new Date(project.updatedAt))}
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
