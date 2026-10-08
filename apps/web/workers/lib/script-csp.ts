export const EXTERNAL_SCRIPT_CSP_SOURCES =
  'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://esm.sh https://cdn.tailwindcss.com'

export const STATIC_SITE_SCRIPT_DIRECTIVES = [
  // Blob workers inherit this policy. importScripts uses script-src, not
  // script-src-elem; reuse the existing CDNs without enabling JavaScript eval.
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${EXTERNAL_SCRIPT_CSP_SOURCES}`,
  "worker-src 'self' blob:",
]
