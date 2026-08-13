import { memo, useEffect, useRef } from 'react'
import { Link, useLocation, useViewTransitionState } from 'react-router'
import {
  IconEye,
  IconMessage,
  IconPin,
  IconPinFilled,
  IconStack2 as Layers,
} from '@tabler/icons-react'
import { IconButton } from '~/components/app/icon-button'
import { useFileLabels } from '../+hooks/use-file-labels'
import { AuthorAvatar } from '~/components/app/author-avatar'
import { BotBadge } from '~/components/app/user-kind-badge'
import { ExtTag } from '~/components/app/ext-tag'
import { CopyUrlButton, copyShareableUrl } from './copy-url-button'
import type { FileRowData } from './file-data'
import { FileTypeIcon } from '~/components/app/file-type-icon'
import { VisibilityChip } from '~/components/app/visibility-chip'
import { displayTitle } from '~/lib/display-title'
import { currentGalleryReturnTo } from '~/lib/viewer-return'
import { versionBadgeLabel } from '~/lib/version-badge'
import { useT } from '~/hooks/use-t'
import { cn } from '~/lib/utils'
import { ShareablePeek } from '~/components/app/peek-card'
import { FileRowMenu } from './file-row-menu'
import {
  fileTableColumns,
  fileTableColumnsActions,
  filesTableColumns,
  filesTableColumnsActions,
  groupedFileTableColumns,
  groupedFileTableColumnsActions,
  groupedFilesTableColumns,
  groupedFilesTableColumnsActions,
  projectFileColumns,
  homeCompactFilesColumns,
  homeCompactLostAccessColumns,
} from './file-list-styles'
import { fileHasUnread, unreadNewCommentLabel } from './unread-motion'

const rowClassName = cn(
  'group border-divider relative box-border grid min-h-15.5 items-center gap-4 border-b px-3 text-sm',
  'hover:bg-accent last:border-b-0',
  'max-wide:min-h-16',
)

// 狭幅 2 列の末尾列幅は行アクション (⋯) の有無で択一適用する。同じ variant の
// grid-cols を重ねると生成 CSS の順序勝ちになるため、両方を同時に付けない。
const mobileColsClassName = 'max-wide:grid-cols-[minmax(0,1fr)_40px]'
const mobileColsActionsClassName = 'max-wide:grid-cols-[minmax(0,1fr)_76px]'

const rowLinkClassName =
  'absolute inset-y-0 left-0 right-12 z-1 rounded-[var(--r-sm)] text-inherit no-underline max-wide:right-13'

// アクション列 (コピー + ⋯) 有効時はオーバーレイの右端逃がしを列幅に合わせる。
const rowLinkActionsClassName =
  'absolute inset-y-0 left-0 right-22 z-1 rounded-[var(--r-sm)] text-inherit no-underline'

// Home's media and container queries overlap below 780px; important keeps the
// padding-free 40px action reserve independent of generated CSS order.
const homeCompactRowLinkClassName =
  'max-stack:!right-10 @max-[theme(--breakpoint-stack)]:right-13 @min-[theme(--breakpoint-stack)]:right-22'

const rowCopyClassName =
  'relative z-2 justify-self-end group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:hover)]:opacity-0'

const fileCellClassName =
  'relative z-0 inline-flex min-w-0 items-center gap-3 pointer-events-none'

const titleCellClassName = 'flex min-w-0 flex-col gap-1 overflow-hidden'

const nameClassName = 'font-medium text-foreground'

const projectClassName =
  'inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground'

const commentPreviewClassName =
  'mt-0.5 flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground max-wide:flex-col max-wide:gap-0.5'

const mobileMetaClassName =
  'hidden max-wide:grid max-wide:min-w-0 max-wide:grid-cols-[auto_minmax(0,1fr)] max-wide:items-center max-wide:gap-x-2 max-wide:gap-y-1 max-wide:text-xs max-wide:text-muted-foreground'

// grow + basis-23 (92px) so a long owner name shrinks and truncates instead of
// overflowing into the copy column, matching the original rule's intent.
const mobileOwnerClassName =
  'inline-flex min-w-0 grow basis-23 items-center gap-1 truncate'

const desktopCellClassName =
  'relative z-0 truncate text-muted-foreground pointer-events-none max-wide:hidden'

const authorClassName =
  'relative z-0 inline-flex min-w-0 items-center gap-1.5 overflow-hidden text-muted-foreground pointer-events-none max-wide:hidden'

interface FileRowProps {
  data: FileRowData
  showOwner?: boolean
  hideMobileOwner?: boolean
  inlineOwner?: boolean
  /** 狭幅で既存どおり共有範囲チップを隠す。表示語の選択は変えない。 */
  hideMobileVisibility?: boolean
  /** 'project' はプロジェクト詳細の行: チップ・更新日を出さず
   * タイトル + 所有者 + 閲覧/コメント数だけにする (企画の compact 規則)。 */
  variant?: 'default' | 'project'
  /** 「vN に更新」バッジ (project variant のみ)。null で非表示。 */
  versionBadge?: string | null
  /** 行末に足す操作 (⋯ メニューなど)。project variant のみ。 */
  menu?: React.ReactNode
  /** ホバープレビュー。対応する一覧だけ true を渡す。 */
  peekEnabled?: boolean
  /** 行アクション (⋯)。true で常設ケバブを出す。 */
  menuEnabled?: boolean
  /** オーナー行のメニュー項目の実行先。未指定ならコピーのみのメニューになる。 */
  onAction?: (action: 'rename' | 'move' | 'visibility' | 'remove') => void
  /** プロジェクト文脈のピン留め (hover 直接ボタン + メニュー項目)。 */
  onPinToggle?: () => void
  pinned?: boolean
  /** 一覧の数値出し分け: 閲覧は常時、コメントは 1 件以上のみ。
   * 渡さない経路 (フラグ off) は従来の「N · M」連結のまま。 */
  richStats?: boolean
  /** 一括選択。オーナー行のみ渡す。checkbox は overlay より上に置く。 */
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  /** 未読ドットと版・コメントのサブ行。 */
  unreadBadges?: boolean
  /** 閲覧日の見せ方。grouped は行内時刻を省き、with-preview は最新コメントも表示する。 */
  recencyPresentation?: 'row' | 'grouped' | 'grouped-with-preview'
  now?: string
  homeCompact?: boolean
}

export function FileRow({
  data,
  showOwner = true,
  hideMobileOwner = false,
  inlineOwner = false,
  hideMobileVisibility = false,
  variant = 'default',
  versionBadge = null,
  menu = null,
  peekEnabled = false,
  menuEnabled = false,
  onAction,
  onPinToggle,
  pinned = false,
  richStats = false,
  selectable = false,
  selected = false,
  onToggleSelect,
  unreadBadges = false,
  recencyPresentation = 'row',
  now,
  homeCompact = false,
}: FileRowProps) {
  const translator = useT()
  const { t } = translator
  const to = `/a/${data.id}`
  const linkRef = useRef<HTMLAnchorElement | null>(null)
  const wasTransitioningRef = useRef(false)
  const location = useLocation()
  const isTransitioning = useViewTransitionState(to)
  const title = displayTitle({
    name: data.fileName,
    derivedTitle: data.derivedTitle,
    titleOverride: data.titleOverride,
  })
  const rowLinkLabel =
    unreadBadges && fileHasUnread(data)
      ? `${title} · ${t('row.unread')}`
      : title
  const groupedRecency = recencyPresentation !== 'row'
  const columnsClassName = homeCompact
    ? data.lostAccess
      ? homeCompactLostAccessColumns
      : homeCompactFilesColumns
    : showOwner
      ? groupedRecency
        ? menuEnabled
          ? groupedFileTableColumnsActions
          : groupedFileTableColumns
        : menuEnabled
          ? fileTableColumnsActions
          : fileTableColumns
      : groupedRecency
        ? menuEnabled
          ? groupedFilesTableColumnsActions
          : groupedFilesTableColumns
        : menuEnabled
          ? filesTableColumnsActions
          : filesTableColumns

  useEffect(() => {
    if (wasTransitioningRef.current && !isTransitioning) {
      linkRef.current?.focus()
    }
    wasTransitioningRef.current = isTransitioning
  }, [isTransitioning])

  return (
    <div
      data-slot="file-row"
      // Divide rows intentionally touch at their upper border; row contents
      // remain visible to the gap audit.
      data-gap-audit-allow-touch
      className={cn(
        variant === 'project'
          ? cn(rowClassName, projectFileColumns)
          : cn(
              columnsClassName,
              rowClassName,
              homeCompact
                ? ''
                : menuEnabled
                  ? mobileColsActionsClassName
                  : mobileColsClassName,
            ),
        selected && 'bg-link-soft/50 hover:bg-link-soft/50',
        homeCompact && 'max-stack:px-0',
      )}
      style={{
        viewTransitionName: isTransitioning
          ? `artifact-${data.id}-surface`
          : 'none',
      }}
    >
      {variant === 'project' ? (
        <ProjectFileRowSurface
          data={data}
          title={title}
          versionBadge={versionBadge}
        />
      ) : (
        <FileRowSurface
          data={data}
          title={title}
          showOwner={showOwner}
          hideMobileOwner={hideMobileOwner}
          inlineOwner={inlineOwner}
          hideMobileVisibility={hideMobileVisibility}
          richStats={richStats}
          unreadBadges={unreadBadges}
          recencyPresentation={recencyPresentation}
          now={now}
          homeCompact={homeCompact}
        />
      )}
      <ShareablePeek id={data.id} disabled={!peekEnabled || data.lostAccess}>
        <Link
          ref={linkRef}
          to={to}
          state={{ galleryReturnTo: currentGalleryReturnTo(location) }}
          viewTransition
          className={cn(
            menuEnabled || variant === 'project'
              ? rowLinkActionsClassName
              : rowLinkClassName,
            homeCompact && !data.lostAccess && homeCompactRowLinkClassName,
            homeCompact && data.lostAccess && '!right-0',
          )}
          aria-label={rowLinkLabel}
        />
      </ShareablePeek>
      {selectable && !data.lostAccess && data.isOwner ? (
        <label
          className={cn(
            'bg-accent max-wide:hidden absolute top-1/2 left-3 z-2 flex -translate-y-1/2 items-center justify-center rounded-[var(--r-sm)] p-1',
            selected
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          )}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            className="accent-link size-4 cursor-pointer"
            aria-label={t('bulk.selectRow', { title })}
          />
        </label>
      ) : null}
      {data.lostAccess ? null : (
        <span className="relative z-2 inline-flex items-center gap-1 justify-self-end">
          {variant === 'project' && onPinToggle ? (
            <IconButton
              type="button"
              icon={pinned ? IconPinFilled : IconPin}
              size="sm"
              className={cn(rowCopyClassName, 'max-wide:hidden')}
              aria-label={t(pinned ? 'project.unpin' : 'project.pin')}
              onClick={onPinToggle}
            />
          ) : null}
          <CopyUrlButton
            shareableId={data.id}
            className={cn(
              rowCopyClassName,
              menuEnabled && 'max-wide:hidden',
              homeCompact &&
                '@max-[theme(--breakpoint-stack)]:hidden @min-[theme(--breakpoint-stack)]:inline-flex',
            )}
          />
          {menu ??
            (menuEnabled ? (
              <FileRowMenu
                onCopyUrl={() => void copyShareableUrl(data.id, translator)}
                onAction={data.isOwner ? onAction : undefined}
                // ピンはプロジェクト側の権限 (canPin) で決まり、行のオーナーかは問わない
                onPinToggle={variant === 'project' ? onPinToggle : undefined}
                pinned={pinned}
              />
            ) : null)}
        </span>
      )}
    </div>
  )
}

interface FileRowSurfaceProps {
  data: FileRowData
  title: string
  showOwner: boolean
  hideMobileOwner: boolean
  inlineOwner: boolean
  hideMobileVisibility: boolean
  richStats: boolean
  unreadBadges: boolean
  recencyPresentation: 'row' | 'grouped' | 'grouped-with-preview'
  now?: string
  homeCompact: boolean
}

interface ProjectFileRowSurfaceProps {
  data: FileRowData
  title: string
  versionBadge: string | null
}

// プロジェクト詳細の行面: 種別アイコン + タイトル (+「vN に更新」) +
// 所有者、右端に閲覧数 (常時)・コメント数 (1 件以上)。チップ・更新日・場所は出さない。
const ProjectFileRowSurface = memo(function ProjectFileRowSurface({
  data,
  title,
  versionBadge,
}: ProjectFileRowSurfaceProps) {
  const { owner } = useFileLabels(data)
  const { t, tPlural } = useT()
  return (
    <>
      <span className={fileCellClassName}>
        <FileTypeIcon renderType={data.renderType} size="sm" />
        <span className={titleCellClassName}>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className={cn(nameClassName, 'truncate')} title={title}>
              {title}
            </span>
            {versionBadge ? (
              <span className="bg-warning-soft text-warning rounded-full px-1.5 py-0.5 text-xs whitespace-nowrap">
                {versionBadge}
              </span>
            ) : null}
          </span>
          <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1.5 text-xs">
            <AuthorAvatar
              id={data.ownerId}
              image={data.ownerImage}
              initial={data.ownerInitial}
              size="xs"
            />
            <span className="min-w-0 truncate">{owner}</span>
            {data.ownerIsBot ? <BotBadge /> : null}
            {data.ownerIsBot ? <BotBadge /> : null}
            {data.ownerIsExternal ? (
              <ExtTag label={t('author.external')} />
            ) : null}
          </span>
        </span>
      </span>
      <span className="text-muted-foreground pointer-events-none relative z-0 inline-flex items-center gap-3 text-xs">
        <span
          className="inline-flex items-center gap-1"
          aria-label={tPlural('card.viewCount', data.viewCount)}
        >
          <IconEye size={13} aria-hidden="true" />
          {data.viewCount}
        </span>
        {data.commentCount > 0 ? (
          <span
            className="max-phone:hidden inline-flex items-center gap-1"
            aria-label={tPlural('card.commentCount', data.commentCount)}
          >
            <IconMessage size={13} aria-hidden="true" />
            {data.commentCount}
          </span>
        ) : null}
      </span>
    </>
  )
})

const FileRowSurface = memo(function FileRowSurface({
  data,
  title,
  showOwner,
  hideMobileOwner,
  inlineOwner,
  hideMobileVisibility,
  richStats,
  unreadBadges,
  recencyPresentation,
  now,
  homeCompact,
}: FileRowSurfaceProps) {
  const { owner, modified, activity, visibility } = useFileLabels(data)
  const { t, tPlural } = useT()

  const versionMotionLabel =
    unreadBadges && now
      ? versionBadgeLabel(data, now, (version) =>
          t('project.versionBadge', { version }),
        )
      : null
  const unreadCommentLabel = unreadBadges
    ? unreadNewCommentLabel(data.unreadCommentCount ?? 0, t, tPlural)
    : null
  const motionSubline =
    unreadBadges && (versionMotionLabel || unreadCommentLabel)
  const showUnreadDot = unreadBadges && fileHasUnread(data)

  const motionSegments = [versionMotionLabel, unreadCommentLabel].filter(
    (segment): segment is string => Boolean(segment),
  )
  const projectSublineTitle = [
    inlineOwner ? owner : null,
    ...motionSegments,
    data.projectName,
    data.contextualWorkspaceLabel,
  ]
    .filter((segment): segment is string => Boolean(segment))
    .join(' · ')

  const compactOnly = homeCompact
    ? data.lostAccess
      ? 'hidden'
      : '@max-[theme(--breakpoint-stack)]:hidden'
    : ''
  return (
    <>
      <span className={fileCellClassName}>
        {showUnreadDot ? (
          <span
            className="bg-link size-2 shrink-0 rounded-full"
            aria-hidden="true"
          />
        ) : null}
        <FileTypeIcon renderType={data.renderType} size="sm" />
        <span className={titleCellClassName}>
          <span
            className={cn(
              nameClassName,
              homeCompact ? 'line-clamp-2' : 'truncate',
            )}
            title={title}
          >
            {title}
          </span>
          {data.projectName || motionSubline || inlineOwner ? (
            <span className={projectClassName} title={projectSublineTitle}>
              {inlineOwner ? (
                <>
                  <AuthorAvatar
                    id={data.ownerId}
                    image={data.ownerImage}
                    initial={data.ownerInitial}
                    size="xs"
                  />
                  <span className="truncate">{owner}</span>
                  {data.ownerIsBot ? <BotBadge /> : null}
                  {data.ownerIsBot ? <BotBadge /> : null}
                  {data.ownerIsExternal ? (
                    <ExtTag label={t('author.external')} />
                  ) : null}
                </>
              ) : null}
              {motionSubline ? (
                <span
                  className={cn(
                    'min-w-0 truncate',
                    !inlineOwner && 'max-wide:hidden',
                  )}
                >
                  {inlineOwner ? <span aria-hidden="true"> · </span> : null}
                  {motionSegments.join(' · ')}
                </span>
              ) : null}
              {data.projectName ? (
                <>
                  {inlineOwner || motionSubline ? (
                    <span
                      className={cn(
                        !inlineOwner && motionSubline && 'max-wide:hidden',
                      )}
                      aria-hidden="true"
                    >
                      {' '}
                      ·{' '}
                    </span>
                  ) : null}
                  <Layers
                    size={13}
                    className="text-link flex-none"
                    aria-hidden="true"
                  />
                  <span className="truncate">{data.projectName}</span>
                  {data.contextualWorkspaceLabel ? (
                    <>
                      <span aria-hidden="true"> · </span>
                      <span className="text-faint min-w-0 truncate">
                        {data.contextualWorkspaceLabel}
                      </span>
                    </>
                  ) : null}
                </>
              ) : null}
            </span>
          ) : null}
          {recencyPresentation === 'grouped-with-preview' &&
          data.latestUnreadComment?.body ? (
            <span className={commentPreviewClassName}>
              <span className="text-link inline-flex shrink-0 items-center gap-1">
                <IconMessage size={13} aria-hidden="true" />
                <span>{t('row.newComment')}</span>
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere] break-words">
                  {data.latestUnreadComment.authorName ? (
                    <span className="max-wide:max-w-1/3 inline-block truncate align-bottom">
                      {data.latestUnreadComment.authorName}
                    </span>
                  ) : null}
                  {data.latestUnreadComment.authorName ? ': ' : null}
                  {data.latestUnreadComment.body}
                </span>
                {(data.unreadCommentRemainingCount ?? 0) > 0 ? (
                  <span className="text-link whitespace-nowrap">
                    {t('row.moreComments', {
                      count: data.unreadCommentRemainingCount ?? 0,
                    })}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
          <span
            className={cn(
              mobileMetaClassName,
              homeCompact &&
                '@max-[theme(--breakpoint-stack)]:grid @min-[theme(--breakpoint-stack)]:hidden',
            )}
            data-regression-responsive="mobile-only"
          >
            <VisibilityChip
              visibility={data.visibility}
              label={visibility}
              className={hideMobileVisibility ? 'max-wide:hidden' : undefined}
            />
            {recencyPresentation === 'row' ? (
              <span className="min-w-0 flex-none truncate">
                {modified ?? '—'}
              </span>
            ) : null}
            {richStats ? (
              <span
                className="inline-flex flex-none items-center gap-1"
                aria-label={tPlural('card.viewCount', data.viewCount)}
              >
                <IconEye size={13} aria-hidden="true" />
                {data.viewCount}
              </span>
            ) : null}
            {!inlineOwner && !hideMobileOwner ? (
              <span className={cn(mobileOwnerClassName, 'col-span-2')}>
                <AuthorAvatar
                  id={data.ownerId}
                  image={data.ownerImage}
                  initial={data.ownerInitial}
                  size="xs"
                />
                <span className="min-w-0 truncate">{owner}</span>
                {data.ownerIsBot ? <BotBadge /> : null}
                {data.ownerIsBot ? <BotBadge /> : null}
                {data.ownerIsExternal ? (
                  <ExtTag label={t('author.external')} />
                ) : null}
              </span>
            ) : null}
            {!inlineOwner &&
            !hideMobileOwner &&
            unreadBadges &&
            motionSegments.length > 0 ? (
              // 既存セルの列位置を動かさないよう、動きは 2 列ぶんの独立行にする
              <span className="col-span-2 min-w-0 truncate">
                {motionSegments.join(' · ')}
              </span>
            ) : null}
          </span>
        </span>
      </span>
      <VisibilityChip
        visibility={data.visibility}
        label={visibility}
        className={cn(
          'max-wide:hidden pointer-events-none relative z-0 justify-self-start',
          compactOnly,
        )}
        data-regression-responsive="desktop-only"
      />
      {recencyPresentation === 'row' ? (
        <span
          className={cn(desktopCellClassName, 'text-left', compactOnly)}
          data-regression-responsive="desktop-only"
        >
          {modified ?? '—'}
        </span>
      ) : null}
      <span
        className={cn(desktopCellClassName, compactOnly)}
        data-regression-responsive="desktop-only"
      >
        {richStats ? (
          <span className="inline-flex items-center gap-3">
            <span
              className="inline-flex items-center gap-1"
              aria-label={tPlural('card.viewCount', data.viewCount)}
            >
              <IconEye size={13} aria-hidden="true" />
              {data.viewCount}
            </span>
            {data.commentCount > 0 ? (
              <span
                className="inline-flex items-center gap-1"
                aria-label={tPlural('card.commentCount', data.commentCount)}
              >
                <IconMessage size={13} aria-hidden="true" />
                {data.commentCount}
              </span>
            ) : null}
          </span>
        ) : (
          activity
        )}
      </span>
      {showOwner && !(homeCompact && inlineOwner) ? (
        <span
          className={cn(authorClassName, compactOnly)}
          data-regression-responsive="desktop-only"
        >
          <AuthorAvatar
            id={data.ownerId}
            image={data.ownerImage}
            initial={data.ownerInitial}
            size="xs"
          />
          <span className="min-w-0 truncate">{owner}</span>
          {data.ownerIsBot ? <BotBadge /> : null}
          {data.ownerIsExternal ? (
            <ExtTag label={t('author.external')} />
          ) : null}
        </span>
      ) : null}
    </>
  )
})
