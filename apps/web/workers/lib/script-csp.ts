import { EXTERNAL_SCRIPT_CSP_SOURCES } from '@artifactshare/viewer-kit/script-policy-sources'
export { EXTERNAL_SCRIPT_CSP_SOURCES } from '@artifactshare/viewer-kit/script-policy-sources'

export const STATIC_SITE_SCRIPT_DIRECTIVES = [
  // Blob workers inherit this policy. Existing CDNs appear in both script-src
  // and script-src-elem, allowing importScripts whichever directive an engine
  // applies. script-src-elem also lists social embed hosts; no new origin is added.
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${EXTERNAL_SCRIPT_CSP_SOURCES}`,
  "worker-src 'self' blob:",
]
