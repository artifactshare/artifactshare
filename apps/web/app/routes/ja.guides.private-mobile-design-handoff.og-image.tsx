import { fetchPrivateMobileDesignHandoffOgImage } from '~/services/og-image-worker.server'

export function loader() {
  return fetchPrivateMobileDesignHandoffOgImage('ja')
}
