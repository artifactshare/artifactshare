import { fetchUpdatesEntryOgImage } from '~/services/og-image-worker.server'
import { getVisibleUpdateBySlug } from '~/services/updates-visibility.server'

export async function loader({ params }: { params: { slug?: string } }) {
  const slug = params.slug
  if (!slug) {
    throw new Response('Not found', { status: 404 })
  }

  const entry = await getVisibleUpdateBySlug(slug, 'ja')
  if (!entry) {
    throw new Response('Not found', { status: 404 })
  }

  return fetchUpdatesEntryOgImage(entry.title, 'ja', slug)
}
