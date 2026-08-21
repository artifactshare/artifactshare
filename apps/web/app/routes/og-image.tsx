import { fetchHomeOgImage } from '~/services/og-image-worker.server'

// The home (apex) Open Graph card. One static image per locale, so it caches
// hard at the edge — Open Graph scrapers (Slack, X, …) fetch it occasionally.
export function loader() {
  return fetchHomeOgImage('en')
}
