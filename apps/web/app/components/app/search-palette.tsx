import {
  IconFile,
  IconHistory,
  IconSearch,
  IconStack2,
} from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { useFetcher, useNavigate } from 'react-router'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '~/components/ui/command'
import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'

interface PaletteResults {
  ownFiles: {
    id: string
    title: string
    createdAt: string
    containerKind: string
    containerName: string
  }[]
  recent: { id: string; title: string; viewedAt: string; ownerName: string }[]
  projects: {
    id: string
    name: string
    updatedAt: string | null
    fileCount: number
  }[]
}

const EMPTY: PaletteResults = { ownFiles: [], recent: [], projects: [] }

export function SearchPalette() {
  const { t } = useT()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const go = (path: string) => {
    setOpen(false)
    navigate(path)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="max-nav:hidden border-border text-muted-foreground hover:bg-accent hover:text-foreground inline-flex cursor-pointer items-center gap-2 rounded-[var(--r-sm)] border px-3 py-1 text-sm"
      >
        <IconSearch size={14} aria-hidden="true" />
        {t('pal.search')}
        <kbd className="bg-muted text-muted-foreground rounded px-1 text-xs">
          ⌘K
        </kbd>
      </button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t('pal.search')}
        description={t('pal.placeholder')}
        shouldFilter={false}
      >
        <PaletteBody go={go} />
      </CommandDialog>
    </>
  )
}

// ダイアログが開いている間だけ mount される (useFetcher は data router 必須のため、
// トップバー単体レンダのテストでも安全)。fetcher.data は次の応答まで前回値を保ち、
// 新しい load が前の in-flight を打ち切るので古い応答が上書きすることもない。
function PaletteBody({ go }: { go: (path: string) => void }) {
  const { t, tPlural, locale } = useT()
  const [query, setQuery] = useState('')
  const fetcher = useFetcher<PaletteResults>()
  const load = fetcher.load
  const results = fetcher.data ?? EMPTY

  useEffect(() => {
    const timer = setTimeout(() => {
      void load(`/api/search-palette?q=${encodeURIComponent(query)}`)
    }, 200)
    return () => clearTimeout(timer)
  }, [query, load])

  const isEmpty =
    results.ownFiles.length === 0 &&
    results.recent.length === 0 &&
    results.projects.length === 0

  return (
    <>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t('pal.placeholder')}
      />
      <CommandList>
        {isEmpty && query.trim() !== '' ? (
          <CommandEmpty>{t('pal.empty', { q: query.trim() })}</CommandEmpty>
        ) : null}
        {results.ownFiles.length > 0 ? (
          <CommandGroup heading={t('home.myFiles')}>
            {results.ownFiles.map((file) => (
              <CommandItem
                key={`own-${file.id}`}
                value={`own-${file.id}`}
                onSelect={() => go(`/a/${file.id}`)}
              >
                <IconFile aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{file.title}</span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {file.containerKind === 'inbox'
                    ? t('tb.home')
                    : file.containerName}
                  {' · '}
                  {formatRelative(file.createdAt, locale)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {results.recent.length > 0 ? (
          <CommandGroup heading={t('tb.recent')}>
            {results.recent.map((file) => (
              <CommandItem
                key={`recent-${file.id}`}
                value={`recent-${file.id}`}
                onSelect={() => go(`/a/${file.id}`)}
              >
                <IconHistory aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{file.title}</span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {file.ownerName}
                  {' · '}
                  {formatRelative(file.viewedAt, locale)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {results.projects.length > 0 ? (
          <CommandGroup heading={t('tb.projects')}>
            {results.projects.map((project) => (
              <CommandItem
                key={`project-${project.id}`}
                value={`project-${project.id}`}
                onSelect={() => go(`/projects/${project.id}`)}
              >
                <IconStack2 className="text-link" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {tPlural('tb.fileCount', project.fileCount)}
                  {project.updatedAt
                    ? ` · ${formatRelative(project.updatedAt, locale)}`
                    : ''}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
      <div className="max-phone:hidden text-muted-foreground flex items-center gap-3 border-t px-3 py-2 text-xs">
        <span>
          <kbd className="bg-muted rounded px-1">↑↓</kbd> {t('pal.hintMove')}
        </span>
        <span>
          <kbd className="bg-muted rounded px-1">↵</kbd> {t('pal.hintOpen')}
        </span>
        <span>
          <kbd className="bg-muted rounded px-1">esc</kbd> {t('pal.hintClose')}
        </span>
      </div>
    </>
  )
}
