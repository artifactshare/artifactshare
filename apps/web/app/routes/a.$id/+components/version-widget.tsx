import { retentionSummary } from './retention-copy'
import type {
  NewCommentMessage,
  ViewerRevisitContext,
} from '~/lib/viewer-revisit'
import {
  IconChevronRight,
  IconHistory as HistoryIcon,
  IconX,
} from '@tabler/icons-react'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { IconButton } from '~/components/app/icon-button'
import { useT } from '~/hooks/use-t'
import { cn } from '~/lib/utils'
import { ReplaceVersionDropzone } from './replace-version-dropzone'
import type { VersionRow } from './version-history-types'
import { VersionRows } from './version-rows'

interface VersionWidgetProps {
  hidden?: boolean
  versions: ReadonlyArray<VersionRow>
  retention?: {
    limit: number | null
    editable: boolean
    publisherManaged?: boolean
    extraProtectedCurrentVersion?: boolean
  }
  canViewHistory?: boolean
  canReplaceFile?: boolean
  onSubmit?: (files: File[]) => void
  replaceMode?: 'single' | 'static_site'
  uploading?: boolean
  hasNewerVersion?: boolean
  onShowLatest?: () => void
  onOpenHistory: (returnFocusTo?: HTMLElement | null) => void
  revisitContext?: ViewerRevisitContext | null
  onCommentsOpen?: (
    returnFocusTo?: HTMLElement | null,
    requestedFilter?: 'all',
    newCommentMessages?: ReadonlyArray<NewCommentMessage>,
  ) => void
}

export function VersionWidget({
  hidden = false,
  versions,
  canViewHistory = true,
  retention,
  canReplaceFile = false,
  onSubmit,
  replaceMode = 'single',
  uploading = false,
  hasNewerVersion = false,
  onShowLatest,
  onOpenHistory,
  revisitContext,
  onCommentsOpen,
}: VersionWidgetProps) {
  const { locale, t } = useT()
  const popoverId = useId()
  const popoverTitleId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [localDropActive, setLocalDropActive] = useState(false)
  const [dismissedVersionFor, setDismissedVersionFor] = useState<string | null>(
    null,
  )
  const [dismissedCommentsFor, setDismissedCommentsFor] = useState<
    string | null
  >(null)
  const currentVersion = versions.find((version) => version.isCurrent)
  const displayedVersion =
    versions.find((version) => version.isDisplayed) ?? currentVersion
  const currentLabel = displayedVersion ? `v${displayedVersion.ordinal}` : 'v-'
  const { showVersionClue, showCommentClue } = versionRevisitClues(
    revisitContext,
    dismissedVersionFor,
    dismissedCommentsFor,
    hasNewerVersion,
    currentVersion?.id,
    Boolean(onCommentsOpen),
  )
  const popoverOpen = open && !hidden

  const submitFiles = (files: FileList | File[] | null) => {
    const list = Array.from(files ?? [])
    if (list.length === 0) {
      toast.error(t('upload.error.missingFile'))
      return
    }
    onSubmit?.(list)
  }

  const closePopover = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    if (open) closeButtonRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open || hidden) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      closePopover()
    }
    function onPointerDown(event: PointerEvent) {
      const root = rootRef.current
      if (!root || root.contains(event.target as Node)) return
      closePopover()
    }
    // 成果物プレビューは iframe。本文クリックの pointerdown は親 document に
    // 届かないので onPointerDown では拾えない。代わりにフォーカスが iframe へ
    // 移ったこと (= プレビューを触った合図) で閉じる。focus はプレビューに
    // 残したいので trigger へは戻さない。
    function onWindowBlur() {
      if (document.activeElement instanceof HTMLIFrameElement) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true })
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [closePopover, hidden, open])

  if (!canViewHistory)
    return (
      <VersionActivityOnly
        hidden={hidden}
        hasNewerVersion={hasNewerVersion}
        onShowLatest={onShowLatest}
      />
    )

  return (
    <aside
      ref={rootRef}
      hidden={hidden}
      className="bottom-version-fab-bottom pointer-events-none fixed right-3 z-(--z-dropdown) flex max-w-(--width-version-panel) flex-col items-end gap-2"
      aria-label={t('vw.activityStatus')}
    >
      {popoverOpen ? (
        <div
          className="bg-background border-border pointer-events-auto flex w-[var(--width-version-panel)] origin-bottom-right flex-col gap-2 rounded-[var(--r-md)] border p-2 shadow-[var(--shadow-lg)]"
          id={popoverId}
          aria-labelledby={popoverTitleId}
        >
          <div className="flex items-center justify-between gap-2 px-0.5 pt-0 pl-2">
            <h2 id={popoverTitleId} className="m-0 text-sm font-semibold">
              {t('vw.versionHistoryReadonly')}
            </h2>
            <IconButton
              ref={closeButtonRef}
              type="button"
              icon={IconX}
              size="md"
              aria-label={t('common.close')}
              onClick={closePopover}
            />
          </div>
          <VersionHistoryPreview retention={retention} versions={versions} />
          <button
            type="button"
            className="text-foreground hover:bg-accent h-touch-target flex cursor-pointer items-center justify-between gap-2 rounded-[var(--r-sm)] border-0 bg-transparent px-2 text-left text-sm"
            onClick={() => {
              setOpen(false)
              onOpenHistory(triggerRef.current)
            }}
          >
            {t(
              retention?.editable
                ? 'vw.retentionOpenHistory'
                : 'history.viewAll',
            )}
            <IconChevronRight size={16} aria-hidden="true" />
          </button>
          {hasNewerVersion ? (
            <VersionUpdateNotice onShowLatest={onShowLatest} />
          ) : null}
          {canReplaceFile ? (
            <ReplaceVersionDropzone
              className="[&_[data-panel-dropzone]]:p-3"
              active={localDropActive}
              uploading={uploading}
              inputRef={inputRef}
              replaceMode={replaceMode}
              setLocalDropActive={setLocalDropActive}
              submitFiles={submitFiles}
              t={t}
            />
          ) : null}
        </div>
      ) : null}
      <VersionRevisitClues
        showVersionClue={showVersionClue}
        showCommentClue={showCommentClue}
        revisitContext={revisitContext}
        onVersion={() => {
          setDismissedVersionFor(revisitContext!.entryCurrentVersionId)
          setOpen(true)
        }}
        onComments={() => {
          setDismissedCommentsFor(revisitContext!.entryCurrentVersionId)
          onCommentsOpen?.(
            triggerRef.current,
            'all',
            revisitContext!.newCommentMessages,
          )
        }}
      />
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'bg-background text-muted-foreground hover:text-foreground pr-version-toggle-pad-end border-border pointer-events-auto inline-flex min-h-7 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--r-md)] border py-0 pl-2 text-sm leading-(--lh-tight) font-semibold shadow-none transition-[background,color,translate,opacity] duration-[var(--duration-fast)] ease-[ease,ease,ease,ease] active:translate-y-px [&_svg]:size-3.5',
          popoverOpen && 'text-foreground',
        )}
        aria-controls={popoverOpen ? popoverId : undefined}
        aria-expanded={popoverOpen}
        aria-label={t(
          hasNewerVersion
            ? 'vw.versionStatusWithUpdate'
            : 'vw.versionStatusWithVersion',
          { version: currentLabel },
        )}
        onClick={() => setOpen((value) => !value)}
      >
        <HistoryIcon aria-hidden="true" strokeWidth={2.5} />
        <span>{currentLabel}</span>
        {hasNewerVersion ? (
          <strong className="text-link text-xs font-semibold">
            {t('history.updateShort')}
          </strong>
        ) : null}
      </button>
    </aside>
  )
}

function VersionUpdateNotice({
  onShowLatest,
  announceSeparately = false,
}: {
  onShowLatest?: () => void
  announceSeparately?: boolean
}) {
  const { t } = useT()
  return (
    <div className="min-h-version-row border-border pointer-events-auto flex items-center justify-between gap-2 rounded-[var(--r-md)] border px-2 py-1.5 text-xs">
      <span aria-hidden={announceSeparately || undefined}>
        {t('history.updateAvailable')}
      </span>
      <button
        type="button"
        className="bg-primary text-primary-foreground h-control-sm cursor-pointer rounded-[var(--r-sm)] border-0 px-2 text-sm font-semibold"
        onClick={onShowLatest}
      >
        {t('history.showLatest')}
      </button>
    </div>
  )
}

function versionRevisitClues(
  revisitContext: VersionWidgetProps['revisitContext'],
  dismissedVersionFor: string | null,
  dismissedCommentsFor: string | null,
  hasNewerVersion: boolean,
  currentVersionId: string | undefined,
  commentsAvailable: boolean,
) {
  const showVersionClue = Boolean(
    revisitContext?.version &&
    dismissedVersionFor !== revisitContext?.entryCurrentVersionId &&
    !hasNewerVersion &&
    revisitContext.entryCurrentVersionId === currentVersionId,
  )
  const showCommentClue = Boolean(
    revisitContext &&
    revisitContext.commentCount > 0 &&
    dismissedCommentsFor !== revisitContext.entryCurrentVersionId &&
    commentsAvailable,
  )

  return { showVersionClue, showCommentClue }
}

function VersionRevisitClues({
  showVersionClue,
  showCommentClue,
  revisitContext,
  onVersion,
  onComments,
}: {
  showVersionClue: boolean
  showCommentClue: boolean
  revisitContext: VersionWidgetProps['revisitContext']
  onVersion: () => void
  onComments: () => void
}) {
  const { t, tPlural, locale } = useT()
  if (!showVersionClue && !showCommentClue) return null
  return (
    <div className="pointer-events-none flex max-w-full flex-wrap justify-end gap-1.5">
      {showVersionClue ? (
        <button
          type="button"
          className="bg-background text-foreground border-border pointer-events-auto min-h-7 cursor-pointer rounded-[var(--r-md)] border px-2 text-sm shadow-sm"
          onClick={onVersion}
        >
          {revisitContext?.version?.kind === 'ordinal' ? (
            locale === 'ja' ? (
              <>
                v{revisitContext.version.from}
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> から </span>v
                {revisitContext.version.to} に更新
              </>
            ) : (
              <>
                Updated v{revisitContext.version.from}
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> to </span>v
                {revisitContext.version.to}
              </>
            )
          ) : (
            t('vw.revisitVersionFallback')
          )}
        </button>
      ) : null}
      {showCommentClue ? (
        <button
          data-revisit-comments
          type="button"
          className="bg-background text-foreground border-border pointer-events-auto min-h-7 cursor-pointer rounded-[var(--r-md)] border px-2 text-sm whitespace-nowrap shadow-sm"
          onClick={onComments}
        >
          {tPlural('vw.revisitComments', revisitContext!.commentCount, {
            count:
              revisitContext!.commentCount > 99
                ? '99+'
                : String(revisitContext!.commentCount),
          })}
        </button>
      ) : null}
    </div>
  )
}

function VersionActivityOnly({
  hidden,
  hasNewerVersion,
  onShowLatest,
}: Pick<VersionWidgetProps, 'hidden' | 'hasNewerVersion' | 'onShowLatest'>) {
  const { t } = useT()
  return (
    <>
      <div
        className="sr-only"
        role="status"
        aria-label={t('vw.activityStatus')}
      >
        {hasNewerVersion ? t('history.updateAvailable') : null}
      </div>
      <aside
        hidden={hidden || !hasNewerVersion}
        className="bottom-version-fab-bottom bg-background pointer-events-none fixed right-3 z-(--z-dropdown) flex max-w-(--width-version-panel) flex-col items-end gap-2 rounded-[var(--r-md)]"
        aria-label={t('vw.activityStatus')}
      >
        {hasNewerVersion ? (
          <VersionUpdateNotice onShowLatest={onShowLatest} announceSeparately />
        ) : null}
      </aside>
    </>
  )
}

export function VersionHistoryPreview({
  retention,
  versions,
}: Pick<VersionWidgetProps, 'retention' | 'versions'>) {
  const { t, locale } = useT()
  const retainVersions = retention?.limit
  return (
    <>
      {retention?.editable ? (
        <p className="text-muted-foreground m-0 px-2 text-xs">
          {retentionSummary(
            retainVersions ?? null,
            retention?.publisherManaged,
            t,
            retention?.extraProtectedCurrentVersion,
          )}
        </p>
      ) : null}
      <VersionRows
        versions={versions.slice(0, 3)}
        locale={locale}
        t={t}
        density="popover"
      />
    </>
  )
}
