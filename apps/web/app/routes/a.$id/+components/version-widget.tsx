import { IconHistory as HistoryIcon, IconX } from '@tabler/icons-react'
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
  versions: ReadonlyArray<VersionRow>
  canReplaceFile?: boolean
  onSubmit?: (files: File[]) => void
  replaceMode?: 'single' | 'static_site'
  uploading?: boolean
  hasNewerVersion?: boolean
  onShowLatest?: () => void
  onOpenHistory: (returnFocusTo?: HTMLElement | null) => void
  revisitContext?: {
    entryCurrentVersionId: string
    version:
      | { kind: 'ordinal'; from: number; to: number }
      | { kind: 'fallback' }
      | null
    commentCount: number
  } | null
  onCommentsOpen?: (
    returnFocusTo?: HTMLElement | null,
    requestedFilter?: 'all',
  ) => void
}

export function VersionWidget({
  versions,
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
  const { locale, t, tPlural } = useT()
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
  const showVersionClue = Boolean(
    revisitContext?.version &&
    dismissedVersionFor !== revisitContext?.entryCurrentVersionId &&
    !hasNewerVersion &&
    revisitContext.entryCurrentVersionId === currentVersion?.id,
  )
  const showCommentClue = Boolean(
    revisitContext &&
    revisitContext.commentCount > 0 &&
    dismissedCommentsFor !== revisitContext.entryCurrentVersionId &&
    onCommentsOpen,
  )

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
    if (!open) return
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
  }, [closePopover, open])

  return (
    <aside
      ref={rootRef}
      className="bottom-version-fab-bottom pointer-events-none fixed right-3 z-(--z-dropdown) flex max-w-(--width-version-panel) flex-col items-end gap-2"
      aria-label={t('vw.activityStatus')}
    >
      {open ? (
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
          <VersionRows
            versions={versions.slice(0, 3)}
            locale={locale}
            t={t}
            density="popover"
          />
          <button
            type="button"
            className="text-muted-foreground hover:bg-accent hover:text-foreground h-touch-target cursor-pointer rounded-[var(--r-sm)] border-0 bg-transparent px-2 text-left text-sm"
            onClick={() => {
              setOpen(false)
              onOpenHistory(triggerRef.current)
            }}
          >
            {t('history.viewAll')}
          </button>
          {hasNewerVersion ? (
            <div className="min-h-version-row border-border flex items-center justify-between gap-2 rounded-[var(--r-md)] border px-2 py-1.5 text-xs">
              <span>{t('history.updateAvailable')}</span>
              <button
                type="button"
                className="bg-primary text-primary-foreground h-control-sm cursor-pointer rounded-[var(--r-sm)] border-0 px-2 text-sm font-semibold"
                onClick={onShowLatest}
              >
                {t('history.showLatest')}
              </button>
            </div>
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
      {showVersionClue || showCommentClue ? (
        <div className="pointer-events-none flex max-w-full flex-wrap justify-end gap-1.5">
          {showVersionClue ? (
            <button
              type="button"
              className="bg-background text-foreground border-border pointer-events-auto min-h-7 cursor-pointer rounded-[var(--r-md)] border px-2 text-sm shadow-sm"
              onClick={() => {
                setDismissedVersionFor(revisitContext!.entryCurrentVersionId)
                setOpen(true)
              }}
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
              type="button"
              className="bg-background text-foreground border-border pointer-events-auto min-h-7 cursor-pointer rounded-[var(--r-md)] border px-2 text-sm whitespace-nowrap shadow-sm"
              onClick={() => {
                setDismissedCommentsFor(revisitContext!.entryCurrentVersionId)
                onCommentsOpen?.(triggerRef.current, 'all')
              }}
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
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'bg-background text-muted-foreground hover:text-foreground pr-version-toggle-pad-end border-border pointer-events-auto inline-flex min-h-7 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--r-md)] border py-0 pl-2 text-sm leading-(--lh-tight) font-semibold shadow-none transition-[background,color,translate,opacity] duration-[var(--duration-fast)] ease-[ease,ease,ease,ease] active:translate-y-px [&_svg]:size-3.5',
          open && 'text-foreground',
        )}
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
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
