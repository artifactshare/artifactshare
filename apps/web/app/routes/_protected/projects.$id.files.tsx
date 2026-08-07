import { useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { IconStack2 as Layers } from '@tabler/icons-react'
import type { Route } from './+types/projects.$id.files'
import { PageBreadcrumb } from '~/components/app/page-breadcrumb'
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { Button } from '~/components/ui/button'
import { Topbar } from '../_home/+components/topbar'
import { BottomTabBar } from '../_home/+components/bottom-tab-bar'
import { FileRow } from '../_home/+components/file-row'
import {
  FileRowDialogs,
  useFileRowActions,
} from '../_home/+components/file-row-dialogs'
import { BulkBar } from '../_home/+components/bulk-bar'
import { useBulkActions } from '../_home/+hooks/use-bulk-actions'
import { toFileRowData, type FileRowData } from '../_home/+components/file-data'
import { fileTableListClassName } from '../_home/+components/file-list-styles'
import { UploadArtifactDialog } from '../_home/+components/upload-artifact-dialog'
import {
  listMainClassName,
  focusReturnTargetClassName,
} from '~/components/app/page-shell-styles'
import { versionBadgeLabel } from '~/lib/version-badge'
import { AppMoreLink } from '~/components/app/app-more-link'
import { AppDividerList } from '~/components/app/app-divider-list'
import { AppEmptyState } from '~/components/app/app-empty-state'
import {
  AppPageHeader,
  AppPageHeaderActions,
  AppPageHeaderMain,
  AppPageHeaderMeta,
  AppPageHeaderTitle,
  AppPageHeaderTitleRow,
} from '~/components/app/app-page-header'
import { AppSectionHeader } from '~/components/app/app-section-header'
import {
  loadProjectSubpageContext,
  projectFileRowsQuery,
  projectSubpageVisibleFilter,
  type ProjectSubpageContext,
} from './+lib/project-subpage.server'
import { groupByDay } from '~/lib/datetime'
import { useViewerCalendar } from '~/hooks/use-viewer-calendar'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { useT } from '~/hooks/use-t'
import { cn } from '~/lib/utils'

const PAGE_SIZE = 50

type FilesCursor = { createdAt: string; id: string }

type LoaderData = {
  ctx: ProjectSubpageContext
  files: FileRowData[]
  total: number
  nextCursor: FilesCursor | null
  now: string
}

function parseCursor(value: string | null): FilesCursor | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as FilesCursor
    if (typeof parsed?.createdAt === 'string' && typeof parsed?.id === 'string')
      return parsed
  } catch {
    // 壊れたカーソルは先頭ページとして扱う
  }
  return undefined
}

export async function loader({
  params,
  request,
  context,
}: Route.LoaderArgs): Promise<LoaderData> {
  const user = requireUser(context)
  const projectId = params.id
  if (!projectId) throw new Response('Not found', { status: 404 })
  const db = createDb()
  const ctx = await loadProjectSubpageContext(db, user, projectId)
  const visible = projectSubpageVisibleFilter(ctx, user)
  const cursor = parseCursor(new URL(request.url).searchParams.get('cursor'))
  let query = projectFileRowsQuery(db, ctx.projectId).where(visible)
  if (cursor) {
    query = query.where((eb) =>
      eb.or([
        eb('shareables.created_at', '<', cursor.createdAt),
        eb.and([
          eb('shareables.created_at', '=', cursor.createdAt),
          eb('shareables.id', '<', cursor.id),
        ]),
      ]),
    )
  }
  const [rows, totalRow] = await Promise.all([
    query
      .orderBy('shareables.created_at', 'desc')
      .orderBy('shareables.id', 'desc')
      .limit(PAGE_SIZE)
      .execute(),
    db
      .selectFrom('shareables')
      .select((eb) => eb.fn.count<number>('shareables.id').as('count'))
      .where('shareables.container_id', '=', ctx.projectId)
      .where(visible)
      .executeTakeFirst(),
  ])
  const last = rows.at(-1)
  return {
    ctx,
    files: rows.map((row) =>
      toFileRowData(row, user.id, {
        externalContext: {
          workspaceHd: ctx.workspaceHd,
          selfEmail: ctx.createdByEmail,
        },
      }),
    ),
    total: Number(totalRow?.count ?? 0),
    nextCursor:
      rows.length === PAGE_SIZE && last
        ? { createdAt: last.created_at ?? '', id: last.id }
        : null,
    now: new Date().toISOString(),
  }
}

const EMPTY_PAGES: LoaderData[] = []

export default function ProjectFiles({ loaderData }: Route.ComponentProps) {
  const { t, locale } = useT()
  const { hydrated, timeZone, now } = useViewerCalendar()
  const fetcher = useFetcher<LoaderData>()
  const rowActions = useFileRowActions()
  const busy = fetcher.state !== 'idle'
  const [uploadOpen, setUploadOpen] = useState(false)
  // 追加読み込みは「初期 loader データ + 追加ページ」で持ち、render 中に導出する
  // (ホームの動きの履歴と同じ adjust-state-during-render パターン)。
  const [acc, setAcc] = useState<{ base: LoaderData; pages: LoaderData[] }>({
    base: loaderData,
    pages: [],
  })
  if (acc.base !== loaderData) setAcc({ base: loaderData, pages: [] })
  if (
    fetcher.state === 'idle' &&
    fetcher.data &&
    acc.base === loaderData &&
    !acc.pages.includes(fetcher.data)
  ) {
    setAcc((current) => ({
      ...current,
      pages: [...current.pages, fetcher.data!],
    }))
  }
  const pages = acc.base === loaderData ? acc.pages : EMPTY_PAGES
  const seen = new Set<string>()
  const files: FileRowData[] = []
  for (const page of [loaderData, ...pages]) {
    for (const file of page.files) {
      if (seen.has(file.id)) continue
      seen.add(file.id)
      files.push(file)
    }
  }
  const bulk = useBulkActions(files.map((f) => f.id))
  const lastPage = pages.at(-1)
  const nextCursor = (lastPage ?? loaderData).nextCursor
  const remaining = Math.max(0, loaderData.total - files.length)
  const groups = hydrated
    ? groupByDay(files, (f) => f.createdTime ?? '', locale, now, timeZone)
    : [{ key: '', heading: '', items: files }]
  const { ctx } = loaderData
  const loadMore = () => {
    if (busy || !nextCursor) return
    fetcher.load(
      `/projects/${ctx.projectId}/files?cursor=${encodeURIComponent(
        JSON.stringify(nextCursor),
      )}`,
    )
  }
  return (
    <>
      <Topbar
        workspaceName={ctx.workspaceName}
        user={ctx.user}
        joinedProjects={ctx.joinedNav}
      />
      <main
        className={cn(listMainClassName, focusReturnTargetClassName)}
        tabIndex={-1}
        aria-busy={busy}
      >
        <PageBreadcrumb aria-label={t('project.location')}>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/">{t('tb.home')}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/projects">{t('project.projects')}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to={`/projects/${ctx.projectId}`}>{ctx.projectName}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{t('project.filesPageTitle')}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </PageBreadcrumb>
        <AppPageHeader>
          <AppPageHeaderMain>
            <AppPageHeaderTitleRow>
              <Layers size={16} className="text-link" aria-hidden="true" />
              <AppPageHeaderTitle>
                {t('project.filesPageTitle')}
              </AppPageHeaderTitle>
            </AppPageHeaderTitleRow>
            <AppPageHeaderMeta>
              {t('project.fileCount', { count: loaderData.total })} ·{' '}
              {t('project.createdOrder')}
            </AppPageHeaderMeta>
          </AppPageHeaderMain>
          {ctx.canUpload ? (
            <AppPageHeaderActions>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => setUploadOpen(true)}
              >
                {t('tb.addFile')}
              </Button>
            </AppPageHeaderActions>
          ) : null}
        </AppPageHeader>
        {files.length === 0 ? (
          <AppEmptyState
            icon={<Layers size={16} />}
            title={t('project.noFilesTitle')}
            body={
              ctx.archived
                ? t('project.archivedNoFilesBody')
                : t('project.noFilesBody')
            }
          />
        ) : (
          groups.map((group, index) => (
            <div key={`${group.key}-${index}`}>
              {group.heading ? (
                <AppSectionHeader title={group.heading} variant="group" />
              ) : null}
              <AppDividerList className={fileTableListClassName}>
                {group.items.map((file) => (
                  <FileRow
                    key={file.id}
                    data={file}
                    variant="project"
                    versionBadge={versionBadgeLabel(file, loaderData.now, (v) =>
                      t('project.versionBadge', { version: v }),
                    )}
                    menuEnabled
                    peekEnabled
                    onAction={(action) => rowActions.open(action, file)}
                    selectable
                    selected={bulk.selected.includes(file.id)}
                    onToggleSelect={() => bulk.toggle(file.id)}
                  />
                ))}
              </AppDividerList>
            </div>
          ))
        )}
        {nextCursor ? (
          <AppMoreLink
            as="button"
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0"
            disabled={busy}
            onClick={loadMore}
          >
            {t('project.moreFiles', { count: remaining })}
          </AppMoreLink>
        ) : null}
      </main>
      {ctx.canUpload ? (
        <UploadArtifactDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          defaultVisibility={ctx.defaultVisibility}
          workspaceHd={ctx.workspaceHd}
          availableVisibilities={ctx.availableVisibilities}
          linkSharingAvailable={ctx.linkSharingAvailable}
          user={ctx.user}
          destination={{
            containerId: ctx.projectId,
            label: ctx.projectName,
            baseVisibility: ctx.projectBaseVisibility,
            shareDefaults: ctx.shareDefaults,
          }}
        />
      ) : null}
      <FileRowDialogs active={rowActions.active} onClose={rowActions.close} />
      <BulkBar
        bulk={bulk}
        files={files}
        homeOwnerName={ctx.user.name ?? ctx.user.email}
      />
      <BottomTabBar />
    </>
  )
}
