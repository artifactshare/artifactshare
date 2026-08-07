import { Link } from 'react-router'
import { IconHome as House, IconStack2 as Layers } from '@tabler/icons-react'
import type { ProjectBlock } from './home-view'
import {
  sectionClassName,
  sectionCountClassName,
  sectionHeadClassName,
  sectionTitleClassName,
  seeAllClassName,
} from './file-list-styles'
import { FileTypeIcon } from '~/components/app/file-type-icon'
import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'
import { displayTitle } from '~/lib/display-title'
import { cn } from '~/lib/utils'

interface ProjectBlocksProps {
  blocks: ProjectBlock[]
}

export function ProjectBlocks({ blocks }: ProjectBlocksProps) {
  const { t } = useT()
  const projectCount = blocks.filter((b) => b.kind === 'project').length

  return (
    <section className={sectionClassName}>
      <div className={sectionHeadClassName}>
        <span className={sectionTitleClassName}>
          {t('project.projects')}
          <span className={sectionCountClassName}>
            {t('home.countSuffix', { n: projectCount })}
          </span>
        </span>
        <Link className={seeAllClassName} to="/projects">
          {t('home.allProjects')}
        </Link>
      </div>

      {blocks.map((block) => (
        <ProjectBlockCard key={block.id ?? 'inbox'} block={block} />
      ))}
    </section>
  )
}

function ProjectBlockCard({ block }: { block: ProjectBlock }) {
  const { t, tPlural, locale } = useT()
  const isInbox = block.kind === 'inbox'
  const subParts = [tPlural('home.fileCount', block.fileCount)]
  if (block.fileUpdatedAt) {
    subParts.push(
      t('home.updatedAt', {
        time: formatRelative(block.fileUpdatedAt, locale),
      }),
    )
  }

  return (
    <div className="border-border bg-card mb-3.5 overflow-hidden rounded-[var(--r-lg)] border shadow-[var(--shadow-sm)]">
      <div className="border-divider bg-muted flex items-center gap-2.5 border-b px-3.5 py-3">
        <span
          className={cn(
            'inline-flex size-[var(--project-mark-size)] shrink-0 items-center justify-center rounded-[var(--r-md)]',
            isInbox
              ? 'bg-chip-muted text-muted-foreground'
              : 'bg-link-soft text-link',
          )}
          aria-hidden="true"
        >
          {isInbox ? <House size={16} /> : <Layers size={16} />}
        </span>
        <div>
          <div className="text-foreground text-sm font-semibold">
            {isInbox ? t('home.inboxLabel') : block.name}
          </div>
          <div className="text-muted-foreground text-xs">
            {subParts.join(' · ')}
          </div>
        </div>
        {!isInbox && block.id ? (
          <Link
            className={cn(seeAllClassName, 'ml-auto')}
            to={`/projects/${block.id}`}
          >
            {t('home.seeAll')}
          </Link>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        {block.recentFiles.map((f) => (
          <MiniFileRow key={f.id} f={f} />
        ))}
      </div>
    </div>
  )
}

function MiniFileRow({ f }: { f: ProjectBlock['recentFiles'][number] }) {
  const { locale } = useT()
  const title = displayTitle({
    name: f.fileName,
    derivedTitle: f.derivedTitle,
    titleOverride: f.titleOverride,
  })
  const modified = f.modifiedTime
    ? formatRelative(f.modifiedTime, locale)
    : null

  return (
    <Link
      to={`/a/${f.id}`}
      className="border-divider hover:bg-accent flex min-h-11 items-center gap-2.5 border-b px-3.5 py-2.25 text-inherit no-underline last:border-b-0"
    >
      <FileTypeIcon renderType={f.renderType} size="sm" />
      <span
        className="text-foreground min-w-0 flex-1 truncate text-sm font-medium"
        title={title}
      >
        {title}
      </span>
      {modified ? (
        <span className="text-muted-foreground w-18 shrink-0 text-right text-xs whitespace-nowrap">
          {modified}
        </span>
      ) : null}
    </Link>
  )
}
