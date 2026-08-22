import { useMemo, useState } from 'react'
import { Link, useFetcher } from 'react-router'
import type { SharedProjectSummary } from '~/services/projects.server'
import type { listProjectsForIndex } from '~/services/project-membership.server'
import { ProjectMark } from '~/components/app/project-mark'
import { ProjectNewBadge } from '~/components/app/project-new-badge'
import { ProjectScopeChip } from '~/components/app/visibility-chip'
import { ExtTag } from '~/components/app/ext-tag'
import { Button } from '~/components/ui/button'
import { formatRelative } from '~/lib/datetime'
import { useT } from '~/hooks/use-t'
import { cn } from '~/lib/utils'
import { AppSectionHeader } from '~/components/app/app-section-header'
import { AppDividerList } from '~/components/app/app-divider-list'
import { AppMoreLink } from '~/components/app/app-more-link'

const SECTION_LIMIT = 10

type IndexRow = Awaited<ReturnType<typeof listProjectsForIndex>>[number]

const rowClassName =
  'border-divider hover:bg-accent flex min-h-15.5 items-center gap-3 border-b px-3 py-2 text-inherit no-underline last:border-b-0'

function RedesignProjectRow({
  row,
  sharedFrom,
  trailing,
}: {
  row: {
    id: string
    name: string
    description: string | null
    baseVisibility: 'workspace' | 'private'
    fileCount: number
    updatedAt: string | null
    archivedAt: string | null
    hasExternal: boolean
  }
  sharedFrom?: string | null
  trailing?: React.ReactNode
}) {
  const { t, locale } = useT()
  const meta = [
    row.description,
    t('project.fileCount', { count: row.fileCount }),
    row.updatedAt
      ? t('project.fileUpdated', {
          time: formatRelative(row.updatedAt, locale),
        })
      : null,
    sharedFrom,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      data-slot="project-row"
      className={cn(rowClassName, 'max-phone:items-start relative')}
    >
      <ProjectMark id={row.id} name={row.name} />
      <span className="max-phone:overflow-hidden pointer-events-none relative z-0 min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <strong className="max-phone:whitespace-normal max-phone:break-words truncate font-semibold">
            {row.name}
          </strong>
          {row.baseVisibility === 'private' ? (
            <ProjectScopeChip
              baseVisibility="private"
              className="px-2 py-0.5 text-xs leading-tight"
            />
          ) : null}
          {row.hasExternal ? (
            <ExtTag label={t('project.externalChip')} />
          ) : null}
          {row.archivedAt ? (
            <span className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-xs">
              {t('project.archivedChip')}
            </span>
          ) : null}
        </span>
        <span className="text-muted-foreground max-phone:whitespace-normal max-phone:break-words mt-0.5 block truncate text-xs">
          {meta}
        </span>
      </span>
      <Link
        // アーカイブ済み詳細は 404 のため、行はアーカイブ一覧 (復元の入口) へ
        to={row.archivedAt ? '/projects/archived' : `/projects/${row.id}`}
        className="absolute inset-0 z-0 rounded-[var(--r-sm)]"
        aria-label={row.name}
      />
      {trailing ? (
        <span className="max-phone:mt-0.5 relative z-1 shrink-0">
          {trailing}
        </span>
      ) : null}
    </div>
  )
}

function BoundedSection({
  title,
  count,
  note,
  children,
  visible,
  onExpand,
  remaining,
}: {
  title: string
  count: number
  note?: string
  children: React.ReactNode
  visible: boolean
  onExpand: () => void
  remaining: number
}) {
  const { t } = useT()
  if (count === 0) return null
  return (
    <section>
      <AppSectionHeader
        title={title}
        meta={note ?? t('project.sectionMeta', { count })}
        className="mt-7"
      />
      <AppDividerList>{children}</AppDividerList>
      {!visible && remaining > 0 ? (
        <AppMoreLink
          as="button"
          type="button"
          className="mt-2"
          onClick={onExpand}
        >
          {t('project.moreProjects', { count: remaining })}
        </AppMoreLink>
      ) : null}
    </section>
  )
}

export function RedesignedProjectsIndex({
  rows,
  sharedProjects,
}: {
  rows: IndexRow[]
  sharedProjects: SharedProjectSummary[]
}) {
  const { t } = useT()
  const fetcher = useFetcher()
  const [showArchived, setShowArchived] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // 押下直後にその場で「参加中」へ変える (revalidate で節が移る)
  const [justJoined, setJustJoined] = useState<ReadonlySet<string>>(new Set())

  const sharedById = useMemo(
    () => new Map(sharedProjects.map((p) => [p.id, p])),
    [sharedProjects],
  )
  const active = rows.filter((r) => !r.archivedAt)
  const joined = active.filter((r) => r.joined)
  const joinable = active.filter((r) => !r.joined && !sharedById.has(r.id))
  const joinedIds = new Set<string>()
  for (const row of active) if (row.joined) joinedIds.add(row.id)
  const shared = sharedProjects.filter((p) => !joinedIds.has(p.id))
  const archived = rows.filter((r) => r.archivedAt && !sharedById.has(r.id))

  const join = (projectId: string) => {
    setJustJoined((current) => new Set(current).add(projectId))
    fetcher.submit({ intent: 'join-project', projectId }, { method: 'post' })
  }

  const bounded = <T extends { id: string }>(key: string, list: T[]) => ({
    items: expanded[key] ? list : list.slice(0, SECTION_LIMIT),
    visible: Boolean(expanded[key]) || list.length <= SECTION_LIMIT,
    remaining: Math.max(0, list.length - SECTION_LIMIT),
    onExpand: () => setExpanded((current) => ({ ...current, [key]: true })),
  })
  const joinedView = bounded('joined', joined)
  const joinableView = bounded('joinable', joinable)
  const sharedView = bounded('shared', shared)

  return (
    <>
      <BoundedSection
        title={t('project.joinedSection')}
        count={joined.length}
        visible={joinedView.visible}
        remaining={joinedView.remaining}
        onExpand={joinedView.onExpand}
      >
        {joinedView.items.map((row) => (
          <RedesignProjectRow
            key={row.id}
            row={row}
            sharedFrom={
              sharedById.has(row.id)
                ? t('project.sharedFrom', {
                    name: sharedById.get(row.id)!.sourceWorkspaceName,
                  })
                : null
            }
            trailing={
              row.newCount > 0 ? <ProjectNewBadge count={row.newCount} /> : null
            }
          />
        ))}
      </BoundedSection>
      <BoundedSection
        title={t('project.joinableSection')}
        count={joinable.length}
        visible={joinableView.visible}
        remaining={joinableView.remaining}
        onExpand={joinableView.onExpand}
      >
        {joinableView.items.map((row) => (
          <RedesignProjectRow
            key={row.id}
            row={row}
            trailing={
              justJoined.has(row.id) ? (
                <span className="text-muted-foreground shrink-0 text-xs">
                  {t('project.joinedLabel')}
                </span>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => join(row.id)}
                >
                  {t('project.join')}
                </Button>
              )
            }
          />
        ))}
      </BoundedSection>
      <BoundedSection
        title={t('project.sharedProjects')}
        count={shared.length}
        note={t('project.sharedProjectsNote')}
        visible={sharedView.visible}
        remaining={sharedView.remaining}
        onExpand={sharedView.onExpand}
      >
        {sharedView.items.map((project) => (
          <RedesignProjectRow
            key={project.id}
            row={{
              id: project.id,
              name: project.name,
              description: project.description,
              baseVisibility: project.baseVisibility,
              fileCount: project.fileCount,
              updatedAt: project.fileUpdatedAt,
              archivedAt: null,
              hasExternal: false,
            }}
            sharedFrom={t('project.sharedFrom', {
              name: project.sourceWorkspaceName,
            })}
          />
        ))}
      </BoundedSection>
      {archived.length > 0 || showArchived ? (
        <label className="text-muted-foreground mt-5 flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          {t('project.showArchived', { count: archived.length })}
        </label>
      ) : null}
      {showArchived && archived.length > 0 ? (
        <AppDividerList className="mt-2">
          {archived.map((row) => (
            <RedesignProjectRow key={row.id} row={row} />
          ))}
        </AppDividerList>
      ) : null}
    </>
  )
}
