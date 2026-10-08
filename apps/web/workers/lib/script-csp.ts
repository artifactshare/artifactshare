export const EXTERNAL_SCRIPT_CSP_SOURCES =
  'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://esm.sh https://cdn.tailwindcss.com'

export const STATIC_SITE_SCRIPT_DIRECTIVES = [
  // Blob workers inherit this policy. Existing CDNs appear in both script-src
  // and script-src-elem, allowing importScripts whichever directive an engine
  // applies. script-src-elem also lists social embed hosts; no new origin is added.
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${EXTERNAL_SCRIPT_CSP_SOURCES}`,
  "worker-src 'self' blob:",
]
