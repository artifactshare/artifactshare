/** Browser mutations must come from the serving shell/dialog, never an
 * opaque artifact frame. CORS controls response access, not server effects.
 * CLI clients omit Origin; this guard does not authenticate local clients. */
export function mutationOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  fetchSite?: string | string[],
): boolean {
  if (fetchSite !== undefined && typeof fetchSite !== 'string') return false
  // Reject foreign browser contexts even when Origin was omitted.
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') return false
  // Firefox can serialize the shell's Origin as null under no-referrer.
  // Fetch Metadata is browser-controlled: an opaque sandbox frame sends
  // cross-site, whereas the shell/dialog's own fetch sends same-origin.
  if (origin === 'null') return fetchSite === 'same-origin'
  return (
    origin === undefined || (host !== undefined && origin === `http://${host}`)
  )
}
