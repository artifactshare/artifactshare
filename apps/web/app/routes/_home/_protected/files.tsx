import { useMemo, useRef } from 'react'
import {
  redirect,
  useNavigate,
  useNavigation,
  useOutletContext,
} from 'react-router'
import type { Route } from './+types/files'
import { toFileRowData, type FileRowData } from '../+components/file-data'
import { FileRow } from '../+components/file-row'
import {
  FileRowDialogs,
  useFileRowActions,
} from '../+components/file-row-dialogs'
import { BulkBar } from '../+components/bulk-bar'
import { useBulkActions } from '../+hooks/use-bulk-actions'
import { EmptyState } from '../+components/empty-state'
import {
  fileTableListClassName,
  homeSectionClassName,
  fileDateHeadingClassName,
} from '../+components/file-list-styles'
import type { HomeLayoutContext } from '../_layout'
import { PageBreadcrumb } from '~/components/app/page-breadcrumb'
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { useViewerCalendar } from '~/hooks/use-viewer-calendar'
import { useT } from '~/hooks/use-t'
import { groupByDay } from '~/lib/datetime'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { recentQuery } from '~/lib/recent-query'
import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'
import { IconPlus } from '@tabler/icons-react'
import {
  AppPageHeader,
  AppPageHeaderActions,
  AppPageHeaderMain,
  AppPageHeaderTitle,
  AppPageHeaderTitleRow,
} from '~/components/app/app-page-header'
import { AppDividerList } from '~/components/app/app-divider-list'

type LoaderData = {
  files: FileRowData[]
  total: number
  page: number
}
export const filesDateHeaderKey = 'table.created' as const

export function filesUrl({
  page = 1,
  hash = '',
}: { page?: number; hash?: string } = {}) {
  const p = new URLSearchParams()
  if (page > 1) p.set('page', String(page))
  return `/files${p.toString() ? `?${p}` : ''}${hash}`
}

export async function loader({
  url,
  context,
}: Route.LoaderArgs): Promise<LoaderData> {
  const user = requireUser(context)
  const { page: requestedPage } = recentQuery(url.searchParams)
  const canonical = filesUrl({
    page: requestedPage,
  })
  if (`${url.pathname}${url.search}` !== canonical) throw redirect(canonical)
  const db = createDb()
  const base = db
    .selectFrom('shareables')
    .innerJoin('users', 'users.id', 'shareables.owner_user_id')
    .leftJoin(
      'artifact_containers as containers',
      'containers.id',
      'shareables.container_id',
    )
    .where('shareables.workspace_id', '=', user.workspaceId)
    .where('shareables.owner_user_id', '=', user.id)
  const filtered = base
  const total = Number(
    (
      await filtered
        .select((eb) => eb.fn.countAll<number>().as('total'))
        .executeTakeFirst()
    )?.total ?? 0,
  )
  const lastPage = Math.max(1, Math.ceil(total / 20))
  if (requestedPage > lastPage) throw redirect(filesUrl({ page: lastPage }))
  const rows = await filtered
    .select((eb) => [
      'shareables.id',
      'shareables.name',
      'shareables.derived_title',
      'shareables.title_override',
      'shareables.artifact_kind',
      'shareables.owner_user_id',
      'users.email as owner_email',
      'users.name as owner_name',
      'users.image as owner_image',
      'shareables.visibility',
      'shareables.view_count',
      'shareables.created_at as modified_at',
      'containers.id as project_id',
      'containers.name as project_name',
      'containers.kind as project_kind',
      eb
        .selectFrom('comment_threads')
        .select((sqb) => sqb.fn.count<number>('comment_threads.id').as('count'))
        .whereRef('comment_threads.shareable_id', '=', 'shareables.id')
        .as('comment_count'),
    ])
    .orderBy('shareables.created_at', 'desc')
    .orderBy('shareables.id', 'asc')
    .offset((requestedPage - 1) * 20)
    .limit(20)
    .execute()
  return {
    files: rows.map((r) =>
      toFileRowData(r, user.id, {
        includeProject: true,
        externalContext: { workspaceHd: user.hd, selfEmail: user.email },
      }),
    ),
    total,
    page: requestedPage,
  }
}

export default function Files({ loaderData }: Route.ComponentProps) {
  const layout = useOutletContext<HomeLayoutContext>()
  const rowActions = useFileRowActions()
  const bulk = useBulkActions(loaderData.files.map((f) => f.id))
  const ref = useRef<HTMLDivElement>(null)
  const nav = useNavigation()
  const navigate = useNavigate()
  const { t, locale } = useT()
  const { hydrated, timeZone, now } = useViewerCalendar()
  const groups = useMemo(
    () =>
      hydrated
        ? groupByDay(
            loaderData.files,
            (f) => f.modifiedTime ?? '',
            locale,
            now,
            timeZone,
          )
        : null,
    [hydrated, loaderData.files, locale, now, timeZone],
  )
  if (!layout.signedIn) return null
  return (
    <div ref={ref} tabIndex={-1} aria-busy={nav.state !== 'idle'}>
      <PageBreadcrumb aria-label={t('project.location')}>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">{t('tb.home')}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{t('home.myFiles')}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </PageBreadcrumb>
      <section className={homeSectionClassName}>
        <AppPageHeader>
          <AppPageHeaderMain>
            <AppPageHeaderTitleRow>
              <AppPageHeaderTitle>{t('home.myFiles')}</AppPageHeaderTitle>
            </AppPageHeaderTitleRow>
          </AppPageHeaderMain>
          {layout.selfUploadEnabled ? (
            <AppPageHeaderActions>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={layout.openUploadDialog}
              >
                <IconPlus size={14} aria-hidden="true" />
                {t('tb.addFile')}
              </Button>
            </AppPageHeaderActions>
          ) : null}
        </AppPageHeader>
      </section>
      {!loaderData.files.length ? (
        <EmptyState
          variant="files"
          onUploadClick={layout.openUploadDialog}
          showUploadAction={false}
        />
      ) : (
        <AppDividerList className={fileTableListClassName}>
          {(
            groups ?? [{ key: 'ssr', heading: '', items: loaderData.files }]
          ).map((g) => (
            <div key={g.key}>
              {g.heading && (
                <h2 className={fileDateHeadingClassName}>{g.heading}</h2>
              )}
              {g.items.map((f) => (
                <FileRow
                  key={f.id}
                  data={f}
                  showOwner={false}
                  hideMobileOwner
                  menuEnabled
                  richStats
                  hideMobileVisibility
                  onAction={(action) => rowActions.open(action, f)}
                  selectable
                  selected={bulk.selected.includes(f.id)}
                  onToggleSelect={() => bulk.toggle(f.id)}
                />
              ))}
            </div>
          ))}
        </AppDividerList>
      )}
      {loaderData.total > 20 && (
        <nav
          aria-label={t('recent.pagination')}
          className="mt-5 flex items-center justify-between text-sm"
        >
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={loaderData.page <= 1}
            onClick={() =>
              void navigate(
                filesUrl({
                  page: loaderData.page - 1,
                }),
              )
            }
          >
            {t('recent.previous')}
          </Button>
          <span>
            {t('recent.page', {
              page: loaderData.page,
              totalPages: Math.ceil(loaderData.total / 20),
            })}
          </span>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={loaderData.page * 20 >= loaderData.total}
            onClick={() =>
              void navigate(
                filesUrl({
                  page: loaderData.page + 1,
                }),
              )
            }
          >
            {t('recent.next')}
          </Button>
        </nav>
      )}
      <FileRowDialogs active={rowActions.active} onClose={rowActions.close} />
      <BulkBar
        bulk={bulk}
        files={loaderData.files}
        homeOwnerName={layout.user.name ?? layout.user.email}
      />
    </div>
  )
}
