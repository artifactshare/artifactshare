import { fetchHomeOgImage } from '~/services/og-image-worker.server'

// The Japanese home Open Graph card, referenced from /ja page metadata.
export function loader() {
  return fetchHomeOgImage('ja')
}
