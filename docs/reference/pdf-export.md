# PDF export boundary

The print popup owns the toolbar, page rules and `window.print()`. The artifact
is embedded as a fully prepared `srcdoc` iframe with `sandbox="allow-scripts"`.
It has an opaque origin and no forms, same-origin, navigation, popup, download
or modal privileges. The frame CSP denies connections, nested frames, objects,
forms and base changes. Only its fresh nonce-authorized measurement helper can
execute. Passive content is restricted to embedded data URLs. Both chrome and content embed the same LINE Seed JP Japanese and Latin WOFF2
faces (regular 400 and bold 700) from the existing pinned `@fontsource/line-seed-jp`
package. No runtime font host, OS-only fallback or asset proxy is required.
The font module is dynamically imported only during PDF preparation and excluded
from the server build. Toolbar controls retain their system font.
Build imports must be embedded WOFF2 data URIs, each bounded to 2 MiB; the four
fixed fonts are separate from the artifact resource budget. The package's SIL
Open Font License attribution is retained in both distributed stylesheets.
Both CSPs permit only data fonts. The frame's font readiness/error checks and
measurement deadline apply to these fonts as well as artifact fonts.

Preparation keeps raw markup in a template-owned, disconnected tree. SVG is
sanitized in place there. Source markup and styles never enter the application
or popup document. Markdown diagrams retain the shared strict Mermaid renderer,
its 20,000-character and 16-diagram limits, and sanitized SVG output.
A separate network-denied opaque preparation realm runs only the trusted Mermaid
bundle and its adapter. Artifact-derived temporary rendering DOM stays in that
realm. Image materialization calls the parent acquisition closure, fixed to the
authorized artifact, version and canonical path. That closure rejects application
origin URLs, credentialed URLs and redirects; external images use anonymous HTTPS
CORS acquisition under the same budgets, cancellation and cleanup as other assets.
The preparation realm has no direct network authority and cannot select an
artifact, version or application operation. The final print-content frame remains
measurement-only: it cannot request resources or actions.

Authenticated acquisition uses only the fixed source and asset endpoints for the
selected artifact and exact source version. Asset lookups also constrain version
ownership and canonical file paths. Source rechecks and asset requests use
`no-store` and reject redirects; responses, including errors, use `no-store`.
Access and current version are checked again after storage acquisition and before
every print, including repeats and documents without artifact-owned assets.

External display resources are embedded through anonymous HTTPS CORS fetches,
with credentials omitted, no referrer and redirects refused. Current application
origin URLs and URLs containing credentials are rejected. CORS, MIME or decoding
failures fail preparation; there is no credentialed arbitrary-URL proxy or
unrestricted HTTPS grant in the frame CSP. Local query strings do not alter
immutable file lookup or the trusted version parameter. Fragments are preserved
on embedded resources; external query strings retain their usual meaning.

CSS imports are recursively rewritten relative to their own stylesheet paths,
including root-relative references. Import conditions remain intact. Cycles fail
explicitly. Limits are 12 nested resource levels, 128 acquisitions/inline resource
references, 32 MiB of source and acquired bytes, and 64 MiB of expanded embedded
resource references. Each validated Mermaid image acquisition charges its embedded
URI and grants one consumable reference credit to the acquiring diagram. During
the subsequent document pass, only surviving, validated image references in that
diagram's inserted SVG can use its credits to avoid double charging. Credits from
fallback or dropped output, and any unused credits, cannot subsidize literal
images or another diagram. All ordinary artifact literal images and extra or
unmatched references count toward the inline-reference and expanded-byte limits.
Cached acquisition does not exempt repeated embedded bytes. Initial PDF preparation has
a 30-second deadline. Each measurement has a 10-second deadline; each repeat
print has a 40-second deadline, excluding time spent in the native print dialog.
Artifact print media types are applied during preparation, including stylesheet and picture source
`media` attributes and imported media conditions. Screen-only rules stay inactive;
feature queries and negation remain intact. Thus print-only expansion is present
before measurement and repeat printing; ordinary HTML downloads keep their media
rules. The initial layout viewport is 900 × 760 pixels. Viewport-relative lengths in
CSS declaration values (including `vh`, `dvh`, `svh`, `lvh`, `vw`, `vmin` and
`vmax`) use that fixed basis, so extending the frame to fit a full document does
not keep enlarging a viewport-height hero or its padding. This reference height
is independent of the 760-pixel paper allowance. Short content still uses its
intrinsic height. Media feature conditions remain responsive to the sized frame.
After each iframe resize, fonts and layout are awaited and measured again.
Printing requires a stable height within eight passes; non-converging viewport
layouts fail explicitly instead of printing clipped content. Images are decoded, fonts are awaited, and measurement follows two animation
frames. Invalid or missing measurements fail rather than printing a partial
result. Closing or navigating the popup aborts preparation.

Final print-content frame startup waits for a channel-bound acknowledgment from the nonce helper,
not an initial empty-document load event. Startup has a ten-second deadline.
The parent accepts messages only from the exact frame WindowProxy, opaque
`null` origin, unpredictable export channel and current sequence. Measurements
must be positive, finite and at most 2,000,000 pixels. Messages cannot select a
URL, artifact, version or application operation. The layout remains 900 pixels
wide, with the existing 760-pixel paper allowance and 32,000-pixel custom-page
limit. The standard-page fallback preserves the full iframe height.

## Validation and delivery

The factory validation remains:

```sh
log=$(mktemp)
( pnpm visual:compose ) > "$log" 2>&1 & side=$!
pnpm install --frozen-lockfile &&
pnpm --filter @artifactshare/web exec playwright install chromium firefox webkit &&
pnpm validate:static &&
pnpm test:behavior-browser &&
pnpm --filter @artifactshare/web build:production &&
pnpm validate:static; status=$?
wait "$side"; side_status=$?
cat "$log"; rm -f "$log"
[ "$status" -eq 0 ] && [ "$side_status" -eq 0 ]
```

Focused regressions:

```sh
pnpm --filter @artifactshare/web exec vitest --config vitest.config.ts --run \
  app/services/export-source.server.test.ts \
  'app/routes/api.shareables.$id.export-source.test.ts' \
  'app/routes/api.shareables.$id.export-asset.test.ts' \
  'app/routes/a.$id/+components/export-actions.test.ts' \
  'app/routes/a.$id/+components/export-resources.test.ts' \
  app/services/dev-screen-state.server.test.ts \
  app/routes/auth-middleware-contract.test.ts \
  app/middleware/export-no-store.test.ts
pnpm --filter @artifactshare/web exec vitest --config vitest.behavior.browser.config.ts --run \
  'app/routes/a.$id/export-pdf.behavior.browser.test.tsx' \
  app/lib/csp-reporter.behavior.browser.test.tsx
node --test scripts/check-screen-ledger.test.mjs
```

The browser suite uses actual popup preparation with synthetic cookies and an
unsafe form negative control. Redirect refusal uses a real local HTTP response in
all three engines, with a following-redirect negative control. Chromium/Firefox
also exercise an intercepted external redirect; WebKit cannot synthesize a 302
through interception and exercises external acquisition failure separately. Layout assertions add no screenshot baselines and
do not replace actual PDF inspection. The existing visual suite is unchanged.

The immutable review scope covers application/trusted-control authority,
authorized exact-snapshot/path acquisition, and complete output/lifecycle
behavior. Final-head capture, critique, native Chromium/Firefox PDF inspection,
WebKit baseline comparison and `pnpm check:scenario-routes` remain supervisor
checks before Ready. See [screen capture](screen-capture.md) for the real local
fixtures and capture commands. Recover from an export failure by closing the
popup, correcting access or resources, and starting a new export.


Percentage heights use a fixed 760px root containing height while the outer frame
expands to show all overflow. Logical viewport lengths use the root writing mode:
`vb` and `vi` (including small, large and dynamic variants) resolve against the
same 900 × 760px reference viewport. This avoids resize feedback without cutting
long content. The helper nonce is emitted directly in the serialized script tag;
DOM nonce hiding must not erase it before the frame parses its CSP.

The bundled LINE Seed JP print face replaces the former Noto Sans JP face in both
the trusted controls and artifact content. This visible font change requires the
supervisor's final PDF and capture critique; mocked font requests cannot establish
rendering fidelity.
