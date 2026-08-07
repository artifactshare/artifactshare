import { fetchPrivateMobileDesignHandoffOgImage } from '~/services/og-image-worker.server'

export function loader() {
  return fetchPrivateMobileDesignHandoffOgImage('en')
}
