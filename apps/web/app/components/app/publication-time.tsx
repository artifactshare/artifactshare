import { useHydrated } from '~/hooks/use-hydrated'
import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'

/** Stable initial text across server/browser clocks, time zones, and ICU versions. */
export function PublicationTime({ publishedAt }: { publishedAt: string }) {
  const { locale } = useT()
  const hydrated = useHydrated()
  const absoluteDate = `${new Date(publishedAt).toISOString().slice(0, 19).replace('T', ' ')} UTC`
  return (
    <time dateTime={publishedAt} aria-label={absoluteDate}>
      {hydrated ? formatRelative(publishedAt, locale) : absoluteDate}
    </time>
  )
}
