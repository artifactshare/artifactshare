import {
  IconChevronDown,
  IconChevronUp,
  IconChartBar,
  IconCopy,
  IconDots as Ellipsis,
  IconHome,
  IconMessage,
  IconStack2 as Layers,
} from '@tabler/icons-react'
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { toast } from 'sonner'
import { useT } from '~/hooks/use-t'
import { signInToCurrentPage } from '~/lib/auth-client'
import { copyShareUrl } from '~/lib/clipboard'
import { isOrgWorkspace, type UserInfo } from '~/lib/user'
import { shortVisibilityLabelKey } from '~/lib/visibility-labels'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip'
import { Button } from '~/components/ui/button'
import {
  artifactSupportsComments,
  type ArtifactType,
} from '~/lib/artifact-type'
import { useRemoveArtifact } from '../+hooks/use-remove-artifact'
import { AuthorAvatar } from '~/components/app/author-avatar'
import { UserKindBadge } from '~/components/app/user-kind-badge'
import { AppTopbar } from '~/components/app/app-topbar'
import { AvatarMenu } from '~/components/app/avatar-menu'
import { useAnalyticsConsent } from '~/components/app/analytics-consent-provider'
import { BrandMark } from '~/components/app/brand-mark'
import { ExtTag } from '~/components/app/ext-tag'
import { FileTypeIcon } from '~/components/app/file-type-icon'
import { IconButton } from '~/components/app/icon-button'
import { cn } from '~/lib/utils'
import { ViewerNav } from '~/components/app/viewer-nav'
import { MoveShareableDialog } from './move-shareable-dialog'
import { RemoveConfirmDialog } from './remove-confirm-dialog'
import { VisibilityChip } from '~/components/app/visibility-chip'
import { VisibilityDialog } from './visibility-dialog'
import { displayTitle } from '~/lib/display-title'
import {
  availableVisibilitiesFor,
  isVisibility,
  type EditableVisibility,
  type ProjectBaseVisibility,
  type Visibility,
} from '~/lib/shareable-types'
import { formatRelative } from '~/lib/datetime'
import type { GrantEntry } from '~/services/shareables.server'
import { viewerReturnTo } from '~/lib/viewer-return'
import { useEditTitle } from '../+hooks/use-edit-title'

interface ViewerPresence {
  id: string
  name: string
  image: string | null
  initial: string
}

const emptyPresence: ReadonlyArray<ViewerPresence> = []

const topbarClassName =
  'relative gap-1.5 px-2 transition-[min-height,opacity,translate] duration-[var(--duration-fast)] ease-[ease,ease,ease] motion-reduce:transition-none max-phone:grid max-phone:grid-cols-[auto_minmax(0,1fr)_auto] max-phone:grid-rows-[auto_auto] max-phone:items-center max-phone:gap-x-viewer-topbar-gap max-phone:gap-y-0.5 max-phone:px-2'
// 展開/折りたたみで衝突する高さ・余白・可視性は ternary で単一ソース化する
// (utility と arbitrary property は tailwind-merge で畳まれず、media variant は
//  非 responsive な上書きに後勝ちするため、両方を同時に出すと沈黙事故になる)
const expandedTopbarClassName =
  'h-auto min-h-topbar-expanded border-b-border py-0 max-phone:min-h-topbar-compact max-phone:py-1.5'
const collapsedTopbarClassName =
  'invisible h-0 min-h-0 overflow-hidden border-b-transparent py-0 opacity-0 -translate-y-1.5'
const titleClassName =
  'flex min-w-0 flex-auto flex-col gap-0.5 max-w-[var(--max-width-viewer-title)] max-nav:max-w-none max-nav:flex-1 max-phone:col-start-2 max-phone:row-span-2 max-phone:self-center max-phone:gap-px'
const titleRowClassName = 'flex min-w-0 items-center gap-1.5'
const headingClassName =
  'm-0 min-w-0 flex-1 [font:inherit] max-phone:overflow-hidden'
const nameClassName =
  'line-clamp-2 overflow-hidden text-sm leading-(--lh-snug) font-medium break-all max-phone:block max-phone:w-full max-phone:max-w-full max-phone:truncate max-phone:break-normal'
const editableNameClassName =
  'h-auto min-h-0 justify-start rounded-[var(--r-sm)] p-0 px-1 py-px -m-px text-left text-sm leading-(--lh-snug) font-medium whitespace-normal text-inherit hover:bg-accent focus-visible:border-transparent [&_svg]:hidden'
const titleInputClassName =
  'h-7 w-[var(--width-viewer-title-input)] min-w-title-input-min rounded-[var(--r-sm)] border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 max-phone:w-full max-phone:min-w-0'
const metaClassName =
  'inline-flex min-w-0 items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground max-phone:max-w-full max-phone:gap-1'
const projectClassName =
  'inline-flex min-w-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground no-underline hover:text-foreground max-phone:max-w-[var(--max-width-viewer-project)] max-phone:shrink-0 [&_svg]:shrink-0 [&_svg]:text-link [&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis'
const actionsClassName =
  'ml-auto inline-flex min-w-0 shrink-0 items-center justify-end gap-1.5 max-phone:col-start-3 max-phone:row-span-2 max-phone:self-stretch max-phone:gap-1'
const compactActionClassName =
  'max-phone:h-touch-target max-phone:w-compact-action-width max-phone:p-0'

interface ViewerChromeProps {
  artifact: {
    id: string
    storageKey: string
    name: string
    derivedTitle: string | null
    titleOverride: string | null
    ownerId: string
    ownerName: string | null
    ownerEmail: string | null
    bridgeRequesterLabel?: string | null
    ownerImage: string | null
    ownerInitial: string
    ownerIsExternal?: boolean
    ownerKind?: 'human' | 'bot'
    modifiedTime: string | null
    viewCount: number
    canReplaceFile?: boolean
    canViewHistory?: boolean
    canChangeVisibility?: boolean
    canMove?: boolean
    visibility?: Visibility
    workspaceHd?: string | null
    workspaceMsTenantId?: string | null
    availableVisibilities?: ReadonlyArray<EditableVisibility>
    projectBaseVisibility?: ProjectBaseVisibility | null
    grants?: ReadonlyArray<GrantEntry>
    defaultReturnTo?: string
    projectId?: string | null
    projectName?: string | null
    linkExpiresAt?: string | null
    linkExpired?: boolean
    linkSharingAvailable?: boolean
    linkExpiryDefaultDays?: number | null
    linkExpiryMaxDays?: number | null
    canReopenExpiredLink?: boolean
    // ok / static_site の現行バージョン表示時のみ loader が true を渡す。
    // 個人ワークスペースや資格なしでは false / 省略 (入口なし)。
    showViewerListMetaEntry?: boolean
    // loader 時点の閲覧した人数 (社内のみ)。パネルヘッダーは API 値を使う。
    viewerListCount?: number
  }
  user: UserInfo | null
  renderType: ArtifactType | null
  onHistoryOpenChange?: (
    open: boolean,
    options?: { returnFocusTo?: HTMLElement | null },
  ) => void
  commentCount?: number
  presence?: ReadonlyArray<ViewerPresence>
  onCommentsOpen?: (returnFocusTo?: HTMLElement | null) => void
  viewerListOpen?: boolean
  onViewerListEntrySelect?: (
    from: 'meta' | 'menu',
    returnFocusTo: HTMLElement | null,
  ) => void
  onCopyMarkdown?: () => void
  onDownloadHtml?: () => void
  onDownloadMarkdown?: () => void
  onDownloadPdf?: () => void
  onAccessRequestsOpen?: () => void
  accessRequestsOpen?: boolean
  onAccessRequestsOpenChange?: (open: boolean) => void
  collapsible?: boolean
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}

function useViewerAccessRequest(location: ReturnType<typeof useLocation>) {
  const navigate = useNavigate()
  const requestId = new URLSearchParams(location.search).get('access-request')
  const dismiss = () => {
    const params = new URLSearchParams(location.search)
    params.delete('access-request')
    void navigate(
      {
        pathname: location.pathname,
        search: params.size > 0 ? `?${params.toString()}` : '',
      },
      { replace: true },
    )
  }
  return { requestId, dismiss }
}

export function ViewerChrome({
  artifact,
  user,
  renderType,
  onHistoryOpenChange,
  commentCount = 0,
  presence = emptyPresence,
  onCommentsOpen,
  viewerListOpen = false,
  onViewerListEntrySelect,
  onCopyMarkdown,
  onDownloadHtml,
  onDownloadMarkdown,
  onDownloadPdf,
  onAccessRequestsOpen,
  accessRequestsOpen,
  onAccessRequestsOpenChange,
  collapsible = true,
  collapsed = false,
  onCollapsedChange,
}: ViewerChromeProps) {
  const translator = useT()
  const { t, tPlural, locale } = translator
  const remove = useRemoveArtifact(artifact.id)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [visibilityOpen, setVisibilityOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const location = useLocation()
  const returnTo = viewerReturnTo(location.state, artifact.defaultReturnTo)
  const { requestId: accessRequestId, dismiss: dismissAccessRequest } =
    useViewerAccessRequest(location)

  const currentVisibility = isVisibility(artifact.visibility)
    ? artifact.visibility
    : null
  const commentsAvailable =
    artifactSupportsComments(renderType) && onCommentsOpen !== undefined
  const canChangeVisibility =
    user !== null &&
    artifact.canChangeVisibility === true &&
    currentVisibility !== null
  // title 編集は visibility 編集の可否とは独立して owner のみ許可。
  // 将来 editableVisibility が無い visibility が増えても owner なら編集可。
  const canEditTitle = user !== null && artifact.canChangeVisibility === true
  const canMove = user !== null && artifact.canMove === true
  const {
    bridgeRequesterLabel,
    ownerLabel,
    bridgeAttributionProps,
    hideOwnerOnPhone,
  } = viewerBridgeAttribution(artifact, user)
  const modifiedLabel = artifact.modifiedTime
    ? formatRelative(artifact.modifiedTime, locale)
    : null
  const viewCountLabel = tPlural('card.viewCount', artifact.viewCount)
  const showViewerListEntry =
    user !== null &&
    artifact.showViewerListMetaEntry === true &&
    onViewerListEntrySelect !== undefined
  // {n} は閲覧回数 (匿名・社外込み)、vw.viewerListCount の値は m = 閲覧した
  // 人数 (社内のみ)。「 · 」ごと単一テキストノードに連結し、可視文字列と
  // アクセシブルネームを文字単位で対応させる (aria-hidden セパレータ不使用)。
  const viewerListEntryText = showViewerListEntry
    ? `${viewCountLabel} · ${tPlural('vw.viewerListCount', artifact.viewerListCount ?? 0)}`
    : null
  const historyLabel = t(
    artifact.canReplaceFile ? 'vw.versionHistory' : 'vw.versionHistoryReadonly',
  )
  const title = displayTitle(artifact)
  const editTitle = useEditTitle(
    artifact.id,
    artifact.titleOverride ?? artifact.derivedTitle,
  )
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  const titleButtonRef = useRef<HTMLButtonElement | null>(null)
  const moreButtonRef = useRef<HTMLButtonElement | null>(null)
  const viewerListEntryRef = useRef<HTMLButtonElement | null>(null)
  const commentsButtonRef = useRef<HTMLButtonElement | null>(null)
  const previousEditingRef = useRef(editTitle.isEditing)

  useLayoutEffect(() => {
    const wasEditing = previousEditingRef.current
    previousEditingRef.current = editTitle.isEditing
    if (editTitle.isEditing) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
      return
    }
    if (wasEditing) titleButtonRef.current?.focus()
  }, [editTitle.isEditing])

  return (
    <>
      <AppTopbar
        id="viewer-topbar"
        className={cn(
          topbarClassName,
          collapsed ? collapsedTopbarClassName : expandedTopbarClassName,
        )}
        aria-labelledby="viewer-heading"
      >
        <ViewerNav
          anonymous={user === null}
          className="max-phone:row-span-2 max-phone:self-center"
        />
        {/* dense title/meta cluster: gap-0.5 / gap-px is the intended rhythm */}
        <div data-gap-audit-exempt className={titleClassName}>
          <div className={titleRowClassName}>
            <FileTypeIcon renderType={renderType} size="sm" />
            {canEditTitle ? (
              editTitle.isEditing ? (
                <h1 id="viewer-heading" className={headingClassName}>
                  <input
                    ref={titleInputRef}
                    className={titleInputClassName}
                    type="text"
                    value={editTitle.value}
                    maxLength={200}
                    aria-label={t('vw.editTitleInputLabel')}
                    placeholder={t('vw.titleEditPlaceholder')}
                    onChange={(event) =>
                      editTitle.change(event.currentTarget.value)
                    }
                    onBlur={() => {
                      void editTitle.submit()
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void editTitle.submit()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        editTitle.cancel()
                      }
                    }}
                  />
                </h1>
              ) : (
                <h1 id="viewer-heading" className={headingClassName}>
                  <Button
                    ref={titleButtonRef}
                    type="button"
                    variant="ghost"
                    className={cn(nameClassName, editableNameClassName)}
                    title={title}
                    aria-label={t('vw.editTitleLabel', { title })}
                    onClick={editTitle.start}
                  >
                    {title}
                  </Button>
                </h1>
              )
            ) : (
              <h1 id="viewer-heading" className={headingClassName}>
                <span className={nameClassName} title={title}>
                  {title}
                </span>
              </h1>
            )}
          </div>
          <ViewerMeta
            artifact={artifact}
            canMove={canMove}
            hideOwnerAtViewer={Boolean(bridgeRequesterLabel)}
            hideOwnerOnPhone={hideOwnerOnPhone}
            modifiedLabel={modifiedLabel}
            viewCountLabel={viewCountLabel}
            viewerListEntryText={viewerListEntryText}
            viewerListOpen={viewerListOpen}
            viewerListEntryRef={viewerListEntryRef}
            onViewerListEntrySelect={onViewerListEntrySelect}
            ownerLabel={ownerLabel}
            returnTo={returnTo}
            moveOpen={moveOpen}
            onMoveOpen={() => setMoveOpen(true)}
            t={t}
          />
          <BridgeAttribution {...bridgeAttributionProps} variant="compact" />
        </div>
        <BridgeAttribution {...bridgeAttributionProps} variant="phone" />
        <div className="max-viewer:hidden flex-1" />
        <ViewerActions
          accessRequestId={accessRequestId}
          artifactCanViewHistory={artifact.canViewHistory}
          canChangeVisibility={canChangeVisibility}
          commentCount={commentCount}
          commentsAvailable={commentsAvailable}
          commentsButtonRef={commentsButtonRef}
          currentVisibility={currentVisibility}
          historyLabel={historyLabel}
          moreButtonRef={moreButtonRef}
          presence={presence}
          canMove={canMove}
          onCommentsOpen={onCommentsOpen}
          showViewerListMenuItem={showViewerListEntry}
          onViewerListEntrySelect={onViewerListEntrySelect}
          onHistoryOpenChange={onHistoryOpenChange}
          onMoveOpen={() => setMoveOpen(true)}
          onRemoveOpen={() => setConfirmOpen(true)}
          onVisibilityOpen={() => setVisibilityOpen(true)}
          onCopyMarkdown={onCopyMarkdown}
          onDownloadHtml={onDownloadHtml}
          onDownloadMarkdown={onDownloadMarkdown}
          onDownloadPdf={onDownloadPdf}
          onAccessRequestsOpen={onAccessRequestsOpen}
          accessRequestsOpen={accessRequestsOpen}
          onAccessRequestsOpenChange={onAccessRequestsOpenChange}
          onAccessRequestDismiss={dismissAccessRequest}
          translator={translator}
          topbarCollapsed={collapsed}
          user={user}
        />

        {user && currentVisibility ? (
          <div className="max-phone:col-span-2 max-phone:col-start-2 max-phone:row-start-3 max-phone:flex max-phone:items-center max-phone:pt-0.5 hidden min-w-0">
            <VisibilityChip
              visibility={currentVisibility}
              label={t(shortVisibilityLabelKey(currentVisibility))}
              aria-label={
                canChangeVisibility
                  ? `${t(shortVisibilityLabelKey(currentVisibility))} · ${t('vw.changeVisibility')}`
                  : undefined
              }
              className="max-w-full"
              data-regression-responsive="mobile-only"
              onClick={
                canChangeVisibility ? () => setVisibilityOpen(true) : undefined
              }
            />
          </div>
        ) : null}

        {user ? (
          <>
            <RemoveConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              onConfirm={remove}
            />
          </>
        ) : null}
        {canChangeVisibility ? (
          <ViewerVisibilityDialog
            artifact={artifact}
            open={visibilityOpen}
            onOpenChange={setVisibilityOpen}
            currentVisibility={currentVisibility}
          />
        ) : null}
        {canMove ? (
          <MoveShareableDialog
            open={moveOpen}
            onOpenChange={setMoveOpen}
            shareableId={artifact.id}
            shareableTitle={title}
            homeOwnerName={artifact.ownerName ?? artifact.ownerEmail ?? ''}
            isProjectAudience={currentVisibility === 'project'}
            onReviewVisibility={
              canChangeVisibility ? () => setVisibilityOpen(true) : undefined
            }
          />
        ) : null}
      </AppTopbar>
      {user && artifact.linkExpired ? (
        <ExpiredLinkBanner
          shareableId={artifact.id}
          canReopen={artifact.canReopenExpiredLink === true}
          canOpenDialog={canChangeVisibility}
          onOpenDialog={() => setVisibilityOpen(true)}
        />
      ) : null}
      {collapsible ? (
        <ViewerChromeCollapseToggle
          collapsed={collapsed}
          expandLabel={t('vw.expandChrome')}
          collapseLabel={t('vw.collapseChrome')}
          onToggle={() => onCollapsedChange?.(!collapsed)}
        />
      ) : null}
    </>
  )
}

function ViewerChromeCollapseToggle({
  collapsed,
  expandLabel,
  collapseLabel,
  onToggle,
}: {
  collapsed: boolean
  expandLabel: string
  collapseLabel: string
  onToggle: () => void
}) {
  return (
    <div className="relative z-[var(--z-topbar-raised)] h-0">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn(
          'bg-background text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-background aria-expanded:text-muted-foreground hover:aria-expanded:bg-muted hover:aria-expanded:text-foreground dark:border-border dark:bg-background dark:hover:bg-muted dark:aria-expanded:bg-background dark:hover:aria-expanded:bg-muted min-h-chrome-knob border-border absolute -top-px right-3 h-auto gap-0 rounded-t-none rounded-b-[var(--r-md)] border-t-0 px-3.5 py-0 text-xs font-semibold transition-colors motion-reduce:transition-none [&_svg]:size-3.5 [&_svg]:transition-transform [&_svg]:duration-[var(--duration-fast)] [&_svg]:ease-[ease] motion-reduce:[&_svg]:transition-none',
          collapsed && 'px-2 py-1 [&_svg]:rotate-180',
        )}
        aria-label={collapsed ? expandLabel : collapseLabel}
        aria-expanded={!collapsed}
        aria-controls="viewer-topbar"
        onClick={onToggle}
      >
        <span
          className={cn(
            'inline-flex items-center gap-1.5 overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-[var(--duration-fast)] ease-[ease] motion-reduce:transition-none',
            collapsed ? 'mr-1.5 max-w-4 opacity-100' : 'max-w-0 opacity-0',
          )}
          aria-hidden="true"
        >
          <BrandMark size={16} aria-hidden="true" />
        </span>
        <IconChevronUp aria-hidden="true" strokeWidth={2.5} />
      </Button>
    </div>
  )
}

function BridgeAttribution({
  requester,
  bot,
  variant,
  isExternal,
}: {
  requester?: string | null
  bot: string | null
  variant: 'compact' | 'phone'
  isExternal: boolean
}) {
  if (!requester && (variant === 'compact' || !bot)) return null

  return (
    <span
      className={cn(
        'text-muted-foreground hidden min-w-0 items-center gap-1 overflow-hidden text-xs',
        variant === 'compact'
          ? 'max-viewer:inline-flex max-phone:hidden'
          : 'max-phone:col-span-3 max-phone:col-start-1 max-phone:row-start-4 max-phone:inline-flex px-0.5',
      )}
    >
      {requester ? (
        <BridgeAttributionPopover
          requester={requester}
          bot={bot}
          isExternal={isExternal}
        />
      ) : (
        <>
          <span className="min-w-0 truncate">{bot}</span>
          <UserKindBadge kind="bot" />
        </>
      )}
    </span>
  )
}

function viewerBridgeAttribution(
  artifact: ViewerChromeProps['artifact'],
  user: ViewerChromeProps['user'],
) {
  const botLabel = artifact.ownerName ?? artifact.ownerEmail ?? '—'
  const bridgeRequesterLabel = artifact.bridgeRequesterLabel

  return {
    bridgeRequesterLabel,
    ownerLabel: botLabel,
    bridgeAttributionProps: {
      requester: bridgeRequesterLabel,
      bot: artifact.ownerKind === 'bot' ? botLabel : null,
      isExternal: artifact.ownerIsExternal === true,
    },
    hideOwnerOnPhone:
      user !== null || !!bridgeRequesterLabel || artifact.ownerKind === 'bot',
  }
}

function ViewerMeta({
  artifact,
  canMove,
  hideOwnerAtViewer,
  hideOwnerOnPhone,
  modifiedLabel,
  viewCountLabel,
  viewerListEntryText,
  viewerListOpen,
  viewerListEntryRef,
  onViewerListEntrySelect,
  ownerLabel,
  returnTo,
  moveOpen,
  onMoveOpen,
  t,
}: {
  artifact: ViewerChromeProps['artifact']
  canMove: boolean
  hideOwnerAtViewer: boolean
  hideOwnerOnPhone: boolean
  modifiedLabel: string | null
  viewCountLabel: string
  viewerListEntryText: string | null
  viewerListOpen: boolean
  viewerListEntryRef: RefObject<HTMLButtonElement | null>
  onViewerListEntrySelect: ViewerChromeProps['onViewerListEntrySelect']
  ownerLabel: string
  returnTo: string
  moveOpen: boolean
  onMoveOpen: () => void
  t: ReturnType<typeof useT>['t']
}) {
  const bridgeRequesterLabel = artifact.bridgeRequesterLabel
  const botLabel = artifact.ownerName ?? artifact.ownerEmail ?? '—'
  const locationLabel = artifact.projectName ?? t('home.inboxLabel')
  const moveLabel = `${locationLabel} · ${t('vw.move')}`
  const locationIcon = artifact.projectName ? (
    <Layers size={13} aria-hidden="true" />
  ) : (
    <IconHome size={13} aria-hidden="true" />
  )
  const locationContent = (
    <>
      {locationIcon}
      <span>{locationLabel}</span>
    </>
  )

  return (
    <span className={metaClassName}>
      {modifiedLabel ? (
        <span className="max-phone:hidden">{modifiedLabel}</span>
      ) : null}
      {modifiedLabel ? (
        <span className="max-phone:hidden" aria-hidden="true">
          ·
        </span>
      ) : null}
      {viewerListEntryText !== null ? (
        <button
          ref={viewerListEntryRef}
          type="button"
          data-viewer-list-entry
          className="hover:text-foreground max-phone:order-2 min-w-0 cursor-pointer overflow-hidden bg-transparent p-0 text-xs text-ellipsis whitespace-nowrap text-inherit underline-offset-2 hover:underline"
          aria-haspopup="dialog"
          aria-expanded={viewerListOpen}
          aria-label={t('vw.viewerListEntryLabel', {
            label: viewerListEntryText,
          })}
          onClick={() =>
            onViewerListEntrySelect?.('meta', viewerListEntryRef.current)
          }
        >
          {viewerListEntryText}
        </button>
      ) : (
        <span className="max-phone:order-2 min-w-0 overflow-hidden text-ellipsis">
          {viewCountLabel}
        </span>
      )}
      <span className="max-phone:hidden" aria-hidden="true">
        ·
      </span>
      {canMove ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-viewer-move-entry
          className={cn(
            projectClassName,
            'max-phone:order-first max-phone:shrink-0 -mx-1.5 shrink px-1.5 font-normal',
          )}
          title={moveLabel}
          aria-label={moveLabel}
          aria-haspopup="dialog"
          aria-expanded={moveOpen}
          onClick={onMoveOpen}
        >
          {locationContent}
          <IconChevronDown size={13} aria-hidden="true" />
        </Button>
      ) : artifact.projectName ? (
        <Link
          to={artifact.projectId ? `/projects/${artifact.projectId}` : returnTo}
          className={cn(projectClassName, 'max-phone:order-first')}
          title={artifact.projectName}
          viewTransition
        >
          {locationContent}
        </Link>
      ) : (
        <span
          className={cn(projectClassName, 'max-phone:order-first')}
          title={locationLabel}
        >
          {locationContent}
        </span>
      )}
      <span
        className="max-phone:order-first max-phone:inline hidden"
        aria-hidden="true"
      >
        ·
      </span>
      {/* Separator and owner segment share one collapsing container so the
          separator never remains as an orphan when the owner segment is
          clipped away on narrow viewports. */}
      <span
        data-viewer-owner-segment
        className={cn(
          'inline-flex min-w-0 items-center gap-1.5 overflow-hidden',
          hideOwnerAtViewer
            ? 'max-viewer:hidden'
            : hideOwnerOnPhone && 'max-phone:hidden',
        )}
      >
        <span className="max-phone:hidden" aria-hidden="true">
          ·
        </span>
        {bridgeRequesterLabel ? (
          <BridgeAttributionPopover
            requester={bridgeRequesterLabel}
            bot={artifact.ownerKind === 'bot' ? botLabel : null}
            isExternal={artifact.ownerIsExternal === true}
          />
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1">
            <AuthorAvatar
              id={artifact.ownerId}
              image={artifact.ownerImage}
              initial={artifact.ownerInitial}
              size="xs"
              loading="eager"
            />
            <span
              className="min-w-0 overflow-hidden text-ellipsis"
              title={ownerLabel}
            >
              {ownerLabel}
            </span>
            <UserKindBadge kind={artifact.ownerKind} />
            {artifact.ownerIsExternal ? (
              <ExtTag label={t('author.external')} />
            ) : null}
          </span>
        )}
        <span className="max-phone:inline hidden" aria-hidden="true">
          ·
        </span>
      </span>
    </span>
  )
}

function BridgeAttributionPopover({
  requester,
  bot,
  isExternal,
}: {
  requester: string
  bot: string | null
  isExternal: boolean
}) {
  const { t } = useT()

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          data-bridge-attribution-trigger
          className="hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 group inline-flex max-w-[var(--max-width-viewer-attribution)] min-w-0 items-center gap-0.5 rounded-[var(--r-sm)] border border-transparent bg-transparent px-1 py-0.5 text-xs text-inherit outline-none focus-visible:ring-3"
          title={requester}
          aria-label={t('vw.bridgeAttributionOpen', { requester })}
        >
          <span className="min-w-0 truncate">{requester}</span>
          <IconChevronDown
            className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label={t('vw.bridgeAttributionDetails')}
          className="bg-popover text-popover-foreground ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 z-50 w-[var(--width-viewer-attribution-popover)] origin-(--radix-popover-content-transform-origin) rounded-[var(--r-md)] p-3 shadow-md ring-1 outline-none"
        >
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs">
                {t('vw.bridgeRequestedBy')}
              </dt>
              <dd className="mt-1 flex min-w-0 items-center gap-1.5 font-medium">
                <span className="min-w-0 break-words">{requester}</span>
                {isExternal ? <ExtTag label={t('author.external')} /> : null}
              </dd>
            </div>
            {bot ? (
              <div className="border-border border-t pt-3">
                <dt className="text-muted-foreground text-xs">
                  {t('vw.bridgePublishedVia')}
                </dt>
                <dd className="mt-1 flex min-w-0 items-center gap-1.5 font-medium">
                  <span className="min-w-0 break-words">{bot}</span>
                  <UserKindBadge kind="bot" />
                </dd>
              </div>
            ) : null}
          </dl>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

function ExpiredLinkBanner({
  shareableId,
  canReopen,
  canOpenDialog,
  onOpenDialog,
}: {
  shareableId: string
  canReopen: boolean
  canOpenDialog: boolean
  onOpenDialog: () => void
}) {
  const { t } = useT()
  const [reopening, setReopening] = useState(false)

  const reopen = async () => {
    setReopening(true)
    try {
      const response = await fetch(
        `/api/shareables/${encodeURIComponent(shareableId)}/reopen`,
        { method: 'POST' },
      )
      if (!response.ok) {
        toast.error(t('visibilityDialog.link.republishError'))
        return
      }
      toast.success(t('visibilityDialog.link.republishSuccess'))
      window.location.reload()
    } catch {
      toast.error(t('visibilityDialog.link.republishError'))
    } finally {
      setReopening(false)
    }
  }

  return (
    <div className="border-warning/40 bg-warning-soft relative z-[var(--z-topbar-raised)] flex items-center justify-between gap-3 border-b px-3 py-2 text-sm">
      <span>{t('visibilityDialog.link.expired')}</span>
      {canReopen ? (
        canOpenDialog ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenDialog}
          >
            {t('visibilityDialog.link.republish')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={reopening}
            onClick={() => void reopen()}
          >
            {t('visibilityDialog.link.republish')}
          </Button>
        )
      ) : null}
    </div>
  )
}

function ViewerVisibilityDialog({
  artifact,
  open,
  onOpenChange,
  currentVisibility,
}: {
  artifact: ViewerChromeProps['artifact']
  open: boolean
  onOpenChange: (open: boolean) => void
  currentVisibility: Visibility
}) {
  return (
    <VisibilityDialog
      open={open}
      onOpenChange={onOpenChange}
      shareableId={artifact.id}
      currentVisibility={currentVisibility}
      availableVisibilities={
        artifact.availableVisibilities ??
        availableVisibilitiesFor(
          isOrgWorkspace({
            hd: artifact.workspaceHd ?? null,
            msTenantId: artifact.workspaceMsTenantId ?? null,
          }),
          'inbox',
        )
      }
      workspaceHd={artifact.workspaceHd ?? null}
      projectBaseVisibility={artifact.projectBaseVisibility ?? null}
      owner={{
        id: artifact.ownerId,
        email: artifact.ownerEmail,
        name: artifact.ownerName,
        image: artifact.ownerImage,
        initial: artifact.ownerInitial,
      }}
      grants={artifact.grants ?? []}
      linkSharingAvailable={artifact.linkSharingAvailable ?? true}
      linkExpiresAt={artifact.linkExpiresAt ?? null}
      linkExpiryDefaultDays={
        artifact.linkExpiryDefaultDays === undefined
          ? 30
          : artifact.linkExpiryDefaultDays
      }
      linkExpiryMaxDays={
        artifact.linkExpiryMaxDays === undefined
          ? 90
          : artifact.linkExpiryMaxDays
      }
      linkExpired={artifact.linkExpired ?? false}
    />
  )
}

interface ViewerActionsProps {
  accessRequestId: string | null
  artifactCanViewHistory: boolean | undefined
  canChangeVisibility: boolean
  canMove: boolean
  commentCount: number
  commentsAvailable: boolean
  commentsButtonRef: RefObject<HTMLButtonElement | null>
  currentVisibility: Visibility | null
  historyLabel: string
  moreButtonRef: RefObject<HTMLButtonElement | null>
  onCommentsOpen?: (returnFocusTo?: HTMLElement | null) => void
  showViewerListMenuItem: boolean
  onViewerListEntrySelect?: (
    from: 'meta' | 'menu',
    returnFocusTo: HTMLElement | null,
  ) => void
  onHistoryOpenChange?: (
    open: boolean,
    options?: { returnFocusTo?: HTMLElement | null },
  ) => void
  onMoveOpen: () => void
  onRemoveOpen: () => void
  onVisibilityOpen: () => void
  onCopyMarkdown?: () => void
  onDownloadHtml?: () => void
  onDownloadMarkdown?: () => void
  onDownloadPdf?: () => void
  onAccessRequestsOpen?: () => void
  accessRequestsOpen?: boolean
  onAccessRequestsOpenChange?: (open: boolean) => void
  onAccessRequestDismiss: () => void
  presence: ReadonlyArray<ViewerPresence>
  translator: ReturnType<typeof useT>
  topbarCollapsed: boolean
  user: UserInfo | null
}

function ViewerActions({
  accessRequestId,
  artifactCanViewHistory,
  canChangeVisibility,
  canMove,
  commentCount,
  commentsAvailable,
  commentsButtonRef,
  currentVisibility,
  historyLabel,
  moreButtonRef,
  onCommentsOpen,
  showViewerListMenuItem,
  onViewerListEntrySelect,
  onHistoryOpenChange,
  onMoveOpen,
  onRemoveOpen,
  onVisibilityOpen,
  onCopyMarkdown,
  onDownloadHtml,
  onDownloadMarkdown,
  onDownloadPdf,
  onAccessRequestsOpen,
  accessRequestsOpen,
  onAccessRequestsOpenChange,
  onAccessRequestDismiss,
  presence,
  translator,
  topbarCollapsed,
  user,
}: ViewerActionsProps) {
  const { openBanner } = useAnalyticsConsent()
  const { t } = translator
  const historyOpeningRef = useRef(false)

  return (
    <div className={actionsClassName}>
      {presence.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="max-phone:max-w-presence-max max-phone:overflow-hidden flex h-7 min-w-0 shrink-0 items-center px-1"
              aria-label={t('vw.livePresence')}
            >
              {presence.slice(0, 4).map((member, index) => (
                <AuthorAvatar
                  key={member.id}
                  id={member.id}
                  image={member.image}
                  initial={member.initial}
                  size="sm"
                  loading="eager"
                  className={cn(
                    'outline-card outline outline-2',
                    index > 0 && '-ml-avatar-overlap',
                  )}
                />
              ))}
              {presence.length > 4 ? (
                <span
                  className="text-muted-foreground -ml-avatar-overlap bg-muted outline-card inline-flex h-5 min-w-5 items-center justify-center rounded-[var(--r-full)] px-1 text-xs font-semibold outline-2"
                  aria-hidden="true"
                >
                  +{presence.length - 4}
                </span>
              ) : null}
            </div>
          </TooltipTrigger>
          <TooltipContent>
            {presence.map((member) => member.name).join(', ')}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {user && currentVisibility ? (
        <VisibilityChip
          visibility={currentVisibility}
          label={t(shortVisibilityLabelKey(currentVisibility))}
          aria-label={
            canChangeVisibility
              ? `${t(shortVisibilityLabelKey(currentVisibility))} · ${t('vw.changeVisibility')}`
              : undefined
          }
          className="max-phone:hidden"
          data-regression-responsive="desktop-only"
          onClick={canChangeVisibility ? onVisibilityOpen : undefined}
        />
      ) : null}
      {user && commentsAvailable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={commentsButtonRef}
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                'text-muted-foreground hover:bg-accent hover:text-foreground px-comment-actions-inline [&_svg]:size-icon-comment h-7 gap-1.5 rounded-[var(--r-sm)] text-sm',
                'max-viewer:w-auto max-viewer:min-w-8 max-viewer:justify-center max-viewer:px-1.5 max-viewer:[&>span:first-of-type]:hidden',
                'max-phone:relative',
                compactActionClassName,
              )}
              aria-label={t('comments.entry')}
              onClick={() => onCommentsOpen?.(commentsButtonRef.current)}
            >
              <IconMessage aria-hidden="true" />
              <span>{t('comments.entry')}</span>
              {commentCount > 0 ? (
                <span className="max-phone:absolute max-phone:-top-1 max-phone:right-[var(--offset-badge-nudge)] max-phone:h-4 max-phone:min-w-4 max-phone:px-1 max-phone:text-[length:var(--text-size-2xs)] h-count-badge min-w-count-badge px-comment-badge-inline text-link inline-flex items-center justify-center rounded-[var(--r-full)] bg-[color-mix(in_srgb,var(--link)_14%,transparent)] text-xs font-semibold">
                  {commentCount}
                </span>
              ) : null}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('comments.entry')}</TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="sm"
            className={cn(
              'bg-primary text-primary-foreground hover:bg-primary-hover h-7 gap-1.5 rounded-[var(--r-sm)] px-3 text-sm font-medium active:scale-97',
              'max-viewer:w-8 max-viewer:justify-center max-viewer:p-0 max-viewer:[&_span]:hidden',
              compactActionClassName,
            )}
            aria-label={t('vw.copyUrl')}
            onClick={() => {
              const url = new URL(window.location.href)
              url.searchParams.delete('access-request')
              void copyShareUrl(url.toString(), translator)
            }}
          >
            <IconCopy size={14} strokeWidth={2} aria-hidden="true" />
            <span>{t('vw.copyUrl')}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('vw.copyUrl')}</TooltipContent>
      </Tooltip>
      {user ? (
        <>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    ref={moreButtonRef}
                    type="button"
                    icon={Ellipsis}
                    size="md"
                    className={compactActionClassName}
                    data-viewer-more-menu-trigger
                    aria-label={t('vw.more')}
                  />
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent sideOffset={24}>{t('vw.more')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              align="end"
              className="w-60"
              onCloseAutoFocus={(event) => {
                if (!historyOpeningRef.current) return
                historyOpeningRef.current = false
                event.preventDefault()
              }}
            >
              {onCopyMarkdown ||
              onDownloadHtml ||
              onDownloadMarkdown ||
              onDownloadPdf ? (
                <>
                  <DropdownMenuLabel>{t('vw.exportGroup')}</DropdownMenuLabel>
                  {onCopyMarkdown ? (
                    <DropdownMenuItem onSelect={() => onCopyMarkdown()}>
                      {t('vw.copyMarkdown')}
                    </DropdownMenuItem>
                  ) : null}
                  {onDownloadHtml ? (
                    <DropdownMenuItem onSelect={() => onDownloadHtml()}>
                      {t('vw.downloadHtml')}
                    </DropdownMenuItem>
                  ) : null}
                  {onDownloadMarkdown ? (
                    <DropdownMenuItem onSelect={() => onDownloadMarkdown()}>
                      {t('vw.downloadMarkdown')}
                    </DropdownMenuItem>
                  ) : null}
                  {onDownloadPdf ? (
                    <DropdownMenuItem onSelect={() => onDownloadPdf()}>
                      {t('vw.downloadPdf')}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                </>
              ) : null}
              {canChangeVisibility ? (
                <DropdownMenuItem onSelect={() => onVisibilityOpen()}>
                  {t('vw.changeVisibility')}
                </DropdownMenuItem>
              ) : null}
              {artifactCanViewHistory ? (
                <DropdownMenuItem
                  data-viewer-history-menu-item
                  onSelect={() => {
                    historyOpeningRef.current = true
                    onHistoryOpenChange?.(true, {
                      returnFocusTo: moreButtonRef.current,
                    })
                  }}
                >
                  {historyLabel}
                </DropdownMenuItem>
              ) : null}
              {showViewerListMenuItem ? (
                <DropdownMenuItem
                  data-viewer-list-menu-item
                  onSelect={() =>
                    onViewerListEntrySelect?.('menu', moreButtonRef.current)
                  }
                >
                  {t('vw.viewerListMenuItem')}
                </DropdownMenuItem>
              ) : null}
              {canMove ? (
                <DropdownMenuItem onSelect={() => onMoveOpen()}>
                  {t('vw.move')}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => onRemoveOpen()}
                className="text-destructive focus:text-destructive"
              >
                {t('menu.remove')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <AvatarMenu
            key={accessRequestId ?? 'account'}
            user={user}
            variant="viewer"
            topbarCollapsed={topbarCollapsed}
            initialAccessRequestId={accessRequestId}
            accessRequestsOpen={accessRequestsOpen}
            onAccessRequestsOpenChange={onAccessRequestsOpenChange}
            onAccessRequestsOpen={onAccessRequestsOpen}
            onAccessRequestDismiss={onAccessRequestDismiss}
          />
        </>
      ) : (
        <>
          <IconButton
            icon={IconChartBar}
            aria-label={t('analyticsConsent.change')}
            size="sm"
            onClick={(event) => openBanner(event.currentTarget)}
          />
          <Button
            type="button"
            variant="outline"
            size="default"
            className="text-foreground hover:bg-accent border-border bg-card h-8 rounded-[var(--r-md)] px-3 text-sm font-medium"
            onClick={signInToCurrentPage}
          >
            {t('signin.cta')}
          </Button>
        </>
      )}
    </div>
  )
}
