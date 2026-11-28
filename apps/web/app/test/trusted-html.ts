import type { TrustedHtml } from '@artifactshare/viewer-kit/trusted-html'

// Stands in for rendered markdown in tests that assert on the surrounding
// markup rather than on the renderer.
export function trustedHtmlFixture(html: string): TrustedHtml {
  return html as TrustedHtml
}
