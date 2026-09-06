# Link-shared artifacts use per-ID subdomains

Anonymous link viewing is served from `artifactshare.link`, with one artifact ID per subdomain. Account, workspace, sign-in, and owner-management pages remain on `artifactshare.com`.

## The address-bar origin is isolated per artifact

Safe Browsing and similar systems can attach a warning to the URL shown in the address bar. When every anonymous artifact uses `artifactshare.com/a/<id>`, one abusive artifact can therefore affect the product, sign-in, and workspace origin.

A link-shared artifact now opens at `https://<id>.artifactshare.link/`. The domain is intended for registration in the Public Suffix List, so browsers and reputation systems can treat each ID subdomain as a separate site. The viewer accepts only an exact ten-character artifact ID in the hostname.

## Static content keeps the ID and version in its hostname

Artifact content is served from `https://<id>--v-<hex-version>.artifactshare.link/`. Static bundles use root-relative paths, so the artifact identity cannot be moved into a path prefix without changing uploaded content. Including the version also preserves the existing immutable, version-scoped sandbox identity.

Authenticated and non-link viewing continues to use `*.sandbox.artifactshare.com`. The link-domain content path accepts anonymous link tokens only and does not issue or read the authenticated bundle cookie.

## Sibling content origins use cross-origin resource policy

Once `artifactshare.link` is on the Public Suffix List, `<id>.artifactshare.link` and `<id>--v-<version>.artifactshare.link` are different sites. A `Cross-Origin-Resource-Policy: same-site` response would therefore prevent the viewer from loading its content. Link-domain content uses `Cross-Origin-Resource-Policy: cross-origin`; access is still limited to current `link` visibility, and the existing CSP, iframe sandbox, referrer policy, and token checks remain in force.

## Old anonymous links redirect without being cached

An anonymous request to `https://artifactshare.com/a/<id>` redirects permanently to the per-ID viewer only after the current anonymous display check succeeds. The response also sends `Cache-Control: private, no-store`. This prevents a browser from retaining the redirect after the visitor signs in, so an owner can still use the original app URL for management. Expired or otherwise unavailable links keep the existing unavailable response and do not redirect.

The `artifactshare.link` and `www.artifactshare.link` apexes redirect to the Artifact Share landing page. Other paths on an ID viewer host are denied unless the viewer shell explicitly needs them.
