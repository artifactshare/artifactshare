import { latestViewerHash } from '~/lib/viewer-hash'
import type { ComponentPropsWithRef } from 'react'
import { useViewerHash, viewerSignInHref } from '~/hooks/use-viewer-hash'
import { Button } from '~/components/ui/button'

const className =
  'text-foreground hover:bg-accent border-border bg-card h-8 rounded-[var(--r-md)] px-3 text-sm font-medium'

export function AnonymousViewerSignInControl({
  href,
  label,
  shouldLoadAnalytics,
}: {
  href: string
  label: string
  shouldLoadAnalytics: boolean
}) {
  if (shouldLoadAnalytics) {
    return (
      <Button asChild variant="outline" size="default" className={className}>
        <ViewerSignInLink href={href} label={label} />
      </Button>
    )
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="default"
      className={className}
      // A previously loaded Google linker can keep decorating anchors after
      // consent is withdrawn, so navigate without exposing an href to it.
      onClick={() =>
        window.location.assign(viewerSignInHref(href, latestViewerHash()))
      }
    >
      {label}
    </Button>
  )
}

function ViewerSignInLink({
  href,
  label,
  ...props
}: ComponentPropsWithRef<'a'> & { href: string; label: string }) {
  const hash = useViewerHash()
  return (
    <a {...props} href={viewerSignInHref(href, hash)}>
      {label}
    </a>
  )
}
