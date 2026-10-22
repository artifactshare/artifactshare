# Resource sources in static sites

Folder shares use the same external image, stylesheet, and font sources as
single-file HTML. Images allow HTTPS alongside self, data, and blob sources.
Both static-site style directives allow jsDelivr, cdnjs, and unpkg alongside
self, inline styles, and Google Fonts stylesheets. The social embed style source
remains only in `style-src-elem`. Font files allow jsDelivr alongside self, data,
and `fonts.gstatic.com`; cdnjs and unpkg are not permitted font-file sources.
Single-file HTML and Markdown policies remain unchanged.

The static-site policy controls script origins and does not claim to block
outbound HTTPS GET. Existing open paths include HTTPS media through `media-src`,
frames navigating themselves to arbitrary URLs, popups escaping the sandbox,
and WebRTC outside `connect-src`. The fixed script CDN list, service-worker
refusal, and `form-action 'none'` remain intact. JavaScript `eval` and
`new Function` stay blocked: `'unsafe-eval'` is absent, while the existing
`'wasm-unsafe-eval'` permission remains.

External image hosts may receive the sandbox origin under the unchanged
`Referrer-Policy: strict-origin`. This is accepted for static sites as it already
is for single-file HTML. Authorization, version isolation, other CSP directives,
and Permissions-Policy remain unchanged. JavaScript and XML assets receive the
same resource permissions through the shared policy builder; XML retains its
additional self frame ancestor. Policies are rebuilt per response, so no cache
purge is needed. Remote availability, headers, and font CORS requirements still
apply.
