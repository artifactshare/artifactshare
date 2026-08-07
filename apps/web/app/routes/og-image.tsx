import { fetchHomeOgImage } from '~/services/og-image-worker.server'

// The home (apex) Open Graph card. English only, so it's a single static image
// that caches hard at the edge — Open Graph scrapers (Slack, X, …) fetch it
// occasionally.
export function loader() {
  return fetchHomeOgImage()
}
