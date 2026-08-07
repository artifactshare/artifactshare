import type { ReactNode } from 'react'

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="max-stack:flex-col max-stack:items-start flex items-center justify-between gap-4">
      <div>
        <h1 className="text-foreground font-emphasis m-0 text-3xl leading-(--lh-tight)">
          {title}
        </h1>
        {description ? (
          <p className="text-muted-foreground m-0 leading-(--lh-loose)">
            {description}
          </p>
        ) : null}
      </div>
      {actions}
    </div>
  )
}
