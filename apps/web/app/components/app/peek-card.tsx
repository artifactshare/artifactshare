import * as React from 'react'
import { useLocation } from 'react-router'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '~/components/ui/hover-card'
import { usePeekData, type ProjectData, type ShareableData } from './peek-data'
import { ProjectContent, ShareableContent } from './peek-card-content'

function Peek({
  kind,
  id,
  children,
  disabled,
}: {
  kind: 'shareable' | 'project'
  id: string
  children: React.ReactElement<any>
  disabled?: boolean
}) {
  const location = useLocation()
  const { data, load } = usePeekData<ShareableData | ProjectData>(
    kind,
    id,
    location.pathname,
  )
  const [wantOpen, setWantOpen] = React.useState(false)
  if (disabled) return children
  const trigger = React.cloneElement(children, {
    onPointerEnter: (e: React.PointerEvent) => {
      children.props.onPointerEnter?.(e)
      load()
    },
    onFocus: (e: React.FocusEvent) => {
      children.props.onFocus?.(e)
      load()
    },
  })
  return (
    <HoverCard
      open={wantOpen && data != null}
      onOpenChange={setWantOpen}
      openDelay={350}
    >
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <HoverCardContent
        className={
          kind === 'shareable'
            ? 'h-[var(--height-peek-shareable)] w-[var(--width-peek)] overflow-hidden'
            : 'h-[var(--height-peek-project)] w-[var(--width-peek)] overflow-hidden'
        }
      >
        {data ? (
          kind === 'shareable' ? (
            <ShareableContent data={data as ShareableData} />
          ) : (
            <ProjectContent data={data as ProjectData} />
          )
        ) : null}
      </HoverCardContent>
    </HoverCard>
  )
}

export const ShareablePeek = (p: {
  id: string
  children: React.ReactElement
  disabled?: boolean
}) => <Peek kind="shareable" {...p} />
export const ProjectPeek = (p: {
  id: string
  children: React.ReactElement
  disabled?: boolean
}) => <Peek kind="project" {...p} />
