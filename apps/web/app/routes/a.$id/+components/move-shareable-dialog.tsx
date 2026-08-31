import { useEffect, useEffectEvent, useReducer, useRef } from 'react'
import { useFetcher, useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
  IconCheck,
  IconFileDescription,
  IconHome,
  IconSearch,
  IconStack2 as Layers,
} from '@tabler/icons-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import { searchFieldClassName } from '~/components/app/search-field'
import { dialogNoteWarnClassName } from './dialog-note-styles'
import {
  INBOX_VALUE,
  createMoveShareableDialogState,
  getEffectiveMoveSelection,
  getFilteredMoveProjects,
  getMoveAudienceNote,
  getSelectableMoveValues,
  isMoveDestinations,
  moveShareableDialogReducer,
} from './move-shareable-dialog-state'

const moveAudienceNoteKeys = {
  unchanged: { key: 'move.reassure', warn: false },
  unchangedProject: { key: 'move.audienceUnchangedProject', warn: false },
  projectPrivateWarning: {
    key: 'move.audienceWarnProjectPrivate',
    warn: true,
  },
  projectWorkspaceWarning: {
    key: 'move.audienceWarnProjectWorkspace',
    warn: true,
  },
  projectInboxWarning: { key: 'move.audienceWarnInbox', warn: true },
} as const

interface MoveShareableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  shareableId: string
  shareableTitle: string
  homeOwnerName: string
  // visibility='project' の成果物は所属プロジェクトの関係者を参照するため、
  // 移動で見える範囲が変わる。移動先に応じて警告を出す。
  isProjectAudience: boolean
  onReviewVisibility?: () => void
  /** 一覧文脈: 成功時に viewer への navigate の代わりに呼ぶ (revalidate 等)。 */
  onMoved?: () => void
}

export function MoveShareableDialog({
  open,
  onOpenChange,
  shareableId,
  shareableTitle,
  homeOwnerName,
  isProjectAudience,
  onReviewVisibility,
  onMoved,
}: MoveShareableDialogProps) {
  const { t } = useT()
  const navigate = useNavigate()
  const destinationsFetcher = useFetcher()
  const fetcherLoad = destinationsFetcher.load
  const fetcherReset = destinationsFetcher.reset
  const fetcherState = destinationsFetcher.state
  const fetcherData = destinationsFetcher.data
  const endpoint = `/api/shareables/${encodeURIComponent(shareableId)}/move`
  // Home is shown as "{name} のホーム" across the app; match it here.
  const homeLabel = homeOwnerName
    ? t('project.homeTitle', { name: homeOwnerName })
    : t('move.inbox')

  const [state, dispatch] = useReducer(
    moveShareableDialogReducer,
    null,
    createMoveShareableDialogState,
  )
  const closeAfterLoadFailure = useEffectEvent(() => {
    onOpenChange(false)
  })
  const radioRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const loadStartedRef = useRef(false)

  useEffect(() => {
    if (!open) return
    loadStartedRef.current = false
    dispatch({ type: 'opened' })
    fetcherReset()
    fetcherLoad(endpoint)
  }, [open, endpoint, fetcherLoad, fetcherReset])

  useEffect(() => {
    if (!open || !state.loading) return
    if (fetcherState === 'loading') {
      loadStartedRef.current = true
      return
    }
    if (fetcherState !== 'idle' || !loadStartedRef.current) return
    if (isMoveDestinations(fetcherData)) {
      dispatch({ type: 'loaded', destinations: fetcherData })
      return
    }
    closeAfterLoadFailure()
  }, [open, state.loading, fetcherState, fetcherData])

  const { destinations, query, selected, submitting } = state

  const currentName = destinations
    ? destinations.inbox?.isCurrent
      ? homeLabel
      : (destinations.projects.find((p) => p.isCurrent)?.name ?? null)
    : null

  const filteredProjects = getFilteredMoveProjects(destinations, query)

  // Selectable rows in render order (the current container is disabled). Drives
  // roving focus so arrow keys move between options.
  const selectableValues = getSelectableMoveValues(
    destinations,
    filteredProjects,
  )
  const rovingValue =
    selected && selectableValues.includes(selected)
      ? selected
      : (selectableValues[0] ?? null)

  // Search can hide the selected project. Only allow confirming a destination
  // that is currently visible, so a move never targets an off-screen row.
  const effectiveSelected = getEffectiveMoveSelection(
    selected,
    destinations,
    filteredProjects,
  )

  const audienceNote = getMoveAudienceNote(
    effectiveSelected,
    filteredProjects,
    isProjectAudience,
  )
  const audienceNoteDef = audienceNote
    ? moveAudienceNoteKeys[audienceNote]
    : null
  const audienceNoteText = audienceNoteDef ? t(audienceNoteDef.key) : null
  const audienceNoteWarn = audienceNoteDef?.warn ?? false

  const handleRadioKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    value: string,
  ) => {
    const isPrev = event.key === 'ArrowUp' || event.key === 'ArrowLeft'
    const isNext = event.key === 'ArrowDown' || event.key === 'ArrowRight'
    if (!isPrev && !isNext) return
    event.preventDefault()
    const index = selectableValues.indexOf(value)
    if (index < 0) return
    const len = selectableValues.length
    const nextIndex = isNext ? (index + 1) % len : (index - 1 + len) % len
    const nextValue = selectableValues[nextIndex]
    dispatch({ type: 'select', value: nextValue })
    radioRefs.current[nextValue]?.focus()
  }

  // Roving props apply to every row; the disabled current row ignores tabIndex,
  // focus, and keydown, so it needs no special case.
  const rovingProps = (value: string) => ({
    tabIndex: rovingValue === value ? 0 : -1,
    buttonRef: (el: HTMLButtonElement | null) => {
      radioRefs.current[value] = el
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) =>
      handleRadioKeyDown(event, value),
  })

  const submit = async () => {
    if (!effectiveSelected) return
    dispatch({ type: 'set-submitting', submitting: true })
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination: effectiveSelected }),
      })
      if (!res.ok) {
        toast.error(t('toast.moveFailed'))
        return
      }
      const body = (await res.json()) as { containerName: string }
      // The inbox's internal container name is not user-facing; show home label.
      const name =
        effectiveSelected === INBOX_VALUE ? homeLabel : body.containerName
      const reviewAction =
        effectiveSelected !== INBOX_VALUE && onReviewVisibility
          ? {
              action: {
                label: t('vw.changeVisibility'),
                onClick: onReviewVisibility,
              },
            }
          : undefined
      toast.success(t('toast.moved', { name }), reviewAction)
      onOpenChange(false)
      if (onMoved) {
        onMoved()
        return
      }
      // The artifact changed containers, so the captured "back" target is stale.
      // Replace the entry without nav state and revalidate, letting the viewer's
      // back link follow the refreshed location (the new project, or home).
      // preventScrollReset keeps the reader's position in the document.
      navigate(`/a/${encodeURIComponent(shareableId)}`, {
        replace: true,
        preventScrollReset: true,
      })
    } catch {
      toast.error(t('toast.moveFailed'))
    } finally {
      dispatch({ type: 'set-submitting', submitting: false })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-modal="true" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('move.title')}</DialogTitle>
        </DialogHeader>

        <div className="bg-muted/40 flex min-w-0 items-center gap-2.5 rounded-md border p-2.5">
          <IconFileDescription
            className="text-muted-foreground size-5 shrink-0"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{shareableTitle}</div>
            {currentName ? (
              <div className="text-muted-foreground truncate text-xs">
                {t('move.current')}: {currentName}
              </div>
            ) : null}
          </div>
        </div>

        {destinations ? (
          <>
            {destinations.projects.length > 0 ? (
              <div
                className={searchFieldClassName}
                style={{ maxWidth: 'none', marginLeft: 0 }}
              >
                <IconSearch size={14} strokeWidth={2} aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) =>
                    dispatch({
                      type: 'set-query',
                      value: e.currentTarget.value,
                    })
                  }
                  placeholder={t('move.search')}
                  aria-label={t('move.search')}
                />
              </div>
            ) : null}

            <div
              role="radiogroup"
              aria-label={t('move.destinations')}
              className="-mx-1 max-h-72 overflow-y-auto px-1"
            >
              {destinations.inbox !== null ? (
                <DestinationRow
                  {...rovingProps(INBOX_VALUE)}
                  icon={<IconHome className="size-4" aria-hidden="true" />}
                  name={homeLabel}
                  hint={t('move.inboxHint')}
                  isCurrent={destinations.inbox.isCurrent}
                  isSelected={selected === INBOX_VALUE}
                  onSelect={() =>
                    dispatch({ type: 'select', value: INBOX_VALUE })
                  }
                />
              ) : null}
              {filteredProjects.map((p) => (
                <DestinationRow
                  {...rovingProps(p.containerId)}
                  key={p.containerId}
                  icon={<Layers size={16} aria-hidden="true" />}
                  name={p.name}
                  hint={t('move.fileCount', { count: p.fileCount })}
                  isCurrent={p.isCurrent}
                  isSelected={selected === p.containerId}
                  onSelect={() =>
                    dispatch({ type: 'select', value: p.containerId })
                  }
                />
              ))}
              {query.trim() && filteredProjects.length === 0 ? (
                <p className="text-muted-foreground px-2 py-7 text-center text-sm">
                  {t('move.noHits')}
                </p>
              ) : null}
            </div>
            {!query.trim() && selectableValues.length === 0 ? (
              <NoMoveDestinations />
            ) : null}
          </>
        ) : (
          <div className="h-40" aria-hidden="true" />
        )}

        {audienceNoteText ? (
          <p
            className={
              audienceNoteWarn
                ? dialogNoteWarnClassName
                : 'text-muted-foreground'
            }
          >
            {audienceNoteText}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t('move.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={!effectiveSelected || submitting}
          >
            {t('move.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NoMoveDestinations() {
  const { t } = useT()
  return (
    <p
      className="text-muted-foreground px-2 py-7 text-center text-sm"
      role="status"
    >
      {t('move.noDestinations')}
    </p>
  )
}

interface DestinationRowProps {
  icon: React.ReactNode
  name: string
  hint: string
  isCurrent: boolean
  isSelected: boolean
  onSelect: () => void
  tabIndex?: number
  buttonRef?: (el: HTMLButtonElement | null) => void
  onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}

function DestinationRow({
  icon,
  name,
  hint,
  isCurrent,
  isSelected,
  onSelect,
  tabIndex,
  buttonRef,
  onKeyDown,
}: DestinationRowProps) {
  const { t } = useT()
  return (
    <button
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={isSelected}
      disabled={isCurrent}
      tabIndex={tabIndex}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={`flex w-full items-center gap-2.5 rounded-md border p-2 text-left ${
        isSelected
          ? 'border-link bg-link-soft'
          : 'hover:bg-muted/60 border-transparent'
      } ${isCurrent ? 'cursor-default' : ''}`}
    >
      <span
        className={`grid size-8 shrink-0 place-items-center rounded-md ${
          isSelected
            ? 'bg-link-soft text-link'
            : 'bg-muted text-muted-foreground'
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-sm font-medium ${
            isCurrent ? 'text-muted-foreground' : ''
          }`}
        >
          {name}
        </span>
        <span className="text-muted-foreground block truncate text-xs">
          {hint}
        </span>
      </span>
      {isCurrent ? (
        <span className="text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold">
          {t('move.current')}
        </span>
      ) : isSelected ? (
        <IconCheck className="text-link size-4.5 shrink-0" aria-hidden="true" />
      ) : null}
    </button>
  )
}
