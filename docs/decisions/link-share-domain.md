# Link-shared artifacts use per-ID subdomains

Anonymous link viewing is served from `artifactshare.link`, with one artifact ID per subdomain. Account, workspace, sign-in, and owner-management pages remain on `artifactshare.com`.

## The address-bar origin is isolated per artifact

Safe Browsing and similar systems can attach a warning to the URL shown in the address bar. When every anonymous artifact uses `artifactshare.com/a/<id>`, one abusive artifact can therefore affect the product, sign-in, and workspace origin.

A link-shared artifact now opens at `https://<id>.artifactshare.link/`. The domain is intended for registration in the Public Suffix List, so browsers and reputation systems can treat each ID subdomain as a separate site. The viewer accepts only an exact ten-character artifact ID in the hostname.

## Execution uses a separate registrable domain

HTML, rendered Markdown, and static sites execute only in the sandbox Worker at
`https://a-<id>--v-<hex-version>.artifactshareusercontent.com/` (authenticated)
or `https://l-<id>--v-<hex-version>.artifactshareusercontent.com/` (anonymous link).
The app Worker serves the unchanged per-ID link viewer shell. The label prefix
selects the expected authorization kind; it does not grant access. Version IDs
are UTF-8 encoded as hex and labels must round-trip within the DNS 63-byte limit.
Static bundles retain root-relative paths and immutable version identities.

Both the viewer token and bundle authority bind the authorization kind, exact
execution hostname, artifact, workspace, version, principal, and expiry. Invalid
presented authority fails closed. An authenticated token or cookie is never
converted to anonymous authority. Ordinary authenticated viewer tokens retain
one-time nonce consumption and the matching-bundle reload exception. Embed-token
verification remains supported on authenticated hosts only, with its existing
reusable semantics and separate ancestors; the MCP card issues no embed content.

The bundle cookie is `__Host-as_bnd`, with `Secure; HttpOnly; Path=/; SameSite=None;
Partitioned`, no Domain, and a ten-minute maximum lifetime. The app authentication
cookie is unchanged; existing sessions do not require re-login. Signed bundle
payloads carry `typ: 'bnd'`; viewer and embed tokens cannot be used as cookies
to bypass the token exchange. Every asset
request, including one with a valid bundle cookie, rechecks current access in D1
and resolves the immutable manifest. Anonymous access also requires the current
published version. Only a link execution host permits missing authority to enter
the anonymous access-check path; invalid or expired host-cookie authority is
refused. The obsolete `as_bnd` cookie is ignored, never accepted as authority:
a sibling can write a parent-domain cookie with that name, so its presence must
not deny an otherwise authorized request. The browser cookie expires five
seconds before the signed ten-minute limit to avoid blocking a fresh viewer
token at the server's rounded expiry boundary.

The execution domain is a separate site from both viewers. Documents, assets,
errors, and probes use CORP `cross-origin`, while server authorization remains
mandatory. CSP ancestors allow only the app for authenticated delivery or the exact
per-ID viewer for link delivery. Probe CORS uses that same distinction. Messages
must match the current frame origin and frame window.

Partitioned cookies are the only authority mechanism for authenticated static-site
assets and navigation. Supported cookie policies are Chromium with third-party
cookie restriction, Firefox default Total Cookie Protection
(`network.cookie.cookieBehavior=5`), and Safari 26.2 or later (and 18.4), which
support partitioned cookies. Safari 18.5 through 26.1 and browsers that block all
cross-site cookies show the explanation page for private static sites.
The automated suite detects partitioned-cookie support per engine by setting a
cookie in a cross-site frame and checking whether the next navigation returns it.
Every engine verifies either private static-site delivery or the explanation page,
as well as single-file HTML, Markdown, and anonymous link delivery.
The browser suite records the detected capability and each measured engine,
exact version, settings, and outcome. Firefox's ordinary-cookie control proves
partitioning across top-level sites; Chromium and WebKit controls prove blocking.
A same-site `.localhost` run cannot establish cross-site behavior.

Blocking all cross-site cookies, including partitioned cookies (Firefox
`network.cookie.cookieBehavior=1`), is unsupported for private static sites.
For navigations with `Sec-Fetch-Dest: iframe` or `document`, the sandbox exchanges
the verified `__as_token` query parameter for the bundle cookie and redirects to the same host without the
token. Ordinary artifact query parameters, including `t`, remain unchanged.
The cookie-check request preserves the artifact pathname and version and
validates the cookie binding, then removes its diagnostic query marker with a
redirect. The clean request runs current-access and manifest checks before
delivery, so artifact code never sees the marker. Without the cookie, the frame
explains in English and Japanese that the browser blocks or does not support the
required cookies and suggests updating the browser (Safari 26.2 or later) or
allowing cross-site cookies. Reloading is suggested only for an expired session.
This happens before any artifact script or relative asset executes. It neither rewrites artifact code,
import maps, or SRI nor introduces another delivery capability. Single-file HTML,
Markdown, and anonymous link content remain available with that setting. Old
execution origins are never a fallback. Clients that omit Fetch Metadata do not
receive this browser cookie-setting diagnostic; their token request uses the
direct delivery path, and subsequent assets still require the bound cookie.

URL-path capabilities are rejected as a non-cookie fallback. A capability prefix
would change the pathname visible to artifact code and break pathname-based SPA routing. Keeping relative and
root-relative resource URLs within that prefix would require rewriting import maps
and artifact resources; modifying integrity-protected resources would invalidate
Subresource Integrity (SRI) hashes. Preserving uploaded sites without those
transformations takes precedence over supporting private static sites when
partitioned cookies are blocked.

The new domain is not a public suffix. Host-prefixed authority cookies prevent
sibling authority shadowing, but artifacts can still set ordinary parent-domain
cookies and inflate sibling request headers. This availability-only risk is
accepted; host-prefixed authority cookies keep authority isolated. No Public
Suffix List submission is planned for `artifactshareusercontent.com`.

## Fail-closed cutover

Post-deploy verification polls for up to 75 seconds per invocation, starting
immediately and retrying every 2 seconds. Every attempt repeats the entire exact
stage check set, including previously passing checks. No status, marker, header,
origin, path, or host expectation is relaxed. Requests include body consumption
in their 10-second cap; both requests and retry waits are capped by the remaining
total deadline. No new attempt starts after exhaustion. Each failed attempt logs
stage, attempt, hostname, path, and observed status (or a fixed transport-error
indication), without bodies or raw transport errors. Timeout reports the last
failing check. Both deployment paths run `sandbox-ready` again immediately after
the final app deployment. This final read-only verification adds no delivery stage
or production write. Failure aborts before the next write; final verification
failure fails the job without rollback.

Delivery-stage discovery remains a single uncached, manual-redirect request with
a 10-second timeout and exact-body parsing. It is never retried by polling; fetch
or body-read failures abort before content writes. Recovery retains refusal code.

The protected production workflow first reads the app's uncached
`/__artifactshare_delivery_stage` endpoint. Only an exact successful `usercontent`
response selects steady-state deployment: deploy the sandbox, verify readiness
and legacy refusals, then deploy the final app without a refusal window.
The stage check logs its HTTP status and normalized stage; the orchestrator logs
the selected path. Response bodies are never logged. A steady-state release must
keep the sandbox compatible with the currently deployed app's token query name
and signed payload format. Introduce token-format changes in a compatibility
release that accepts both platform formats before changing the app producer;
remove the previous format only after its outstanding tokens expire. Compatibility
must not interpret ordinary artifact query parameters as delivery authority.
A network failure, unexpected status, or malformed body aborts before content writes.
Only an exact `refuse` response or a legacy endpoint 404 selects the first-transition
path, which uses the same app build twice:

1. Deploy the app with `ARTIFACT_DELIVERY_STAGE=refuse` and verify legacy
   `*.artifactshare.link` content hosts return 404. Public viewer shells remain
   available, but their iframe points to a token-free unavailable path on the new
   execution domain. Missing or unknown stage values also refuse delivery.
2. Deploy the sandbox Worker, retaining old sandbox routes as refusals and owning
   `*.artifactshareusercontent.com/*`. Verify both new kinds' cross-site probe
   policy and old sandbox/link entrypoint, asset, download, and probe refusals.
3. Only after both checks pass, deploy the app with
   `ARTIFACT_DELIVERY_STAGE=usercontent` to emit fresh execution URLs and tokens.

Each stage aborts on failure. Retries check the deployed stage again; a partial
first transition remains on the refusal path until final app delivery succeeds.
Recovery must retain refusal code and must not roll back to an old content handler
or URL generator. Temporary unavailable frames occur only during that transition. A viewer left open across cutover
recovers by reloading its unchanged public URL. Automatic frame renewal does not
migrate origins. Builds and dry runs perform no production writes or readiness
requests. No DNS, certificate, or secret changes are part of this cutover.

## Old anonymous links redirect without being cached

An anonymous request to `https://artifactshare.com/a/<id>` redirects permanently to the per-ID viewer only after the current anonymous display check succeeds. The response also sends `Cache-Control: private, no-store`. This prevents a browser from retaining the redirect after the visitor signs in, so an owner can still use the original app URL for management. Expired or otherwise unavailable links keep the existing unavailable response and do not redirect.

The `artifactshare.link` and `www.artifactshare.link` apexes redirect to the Artifact Share landing page. Other paths on an ID viewer host are denied unless the viewer shell explicitly needs them.

## Abuse signals and judgment

### Decision

Artifact Share records a narrow server-side signal when an anonymous link-domain viewer load is counted by the existing view deduplication. The durable record contains the artifact and workspace identifiers, the view time, the referrer's hostname when it can be parsed as HTTP(S), and the name of a recognized advertising click parameter from the viewer URL. It never contains a referrer path or query value, the advertising parameter value, an IP address, or a user agent. Signal rows are deleted after 30 days.

Three events can request a judgment:

- the D1 signal-row count reaches the configured spike threshold within its configured window;
- a recognized advertising click parameter is present in the viewer URL;
- the artifact owner or an active workspace owner/admin explicitly requests a check, for example after an external search warning.

All triggers acquire an atomic per-artifact D1 cooldown gate before starting a Workflow. Manual checks use a shorter cooldown than automatic triggers. Trigger processing runs in the same deferred request work as view recording, so it does not extend anonymous viewer response latency.

When a trigger starts the link-abuse Workflow, it reads only the current published entrypoint of an artifact that is still shared by link and re-checks that visibility immediately before judgment. It truncates the entrypoint before scanning, removes script and style content, caps visible text at 6,000 characters, and collects at most 50 unique external hostnames from navigation and resource attributes or HTML and Markdown URL text. The judgment also receives the account age, workspace plan, trigger, and non-sensitive trigger detail.

Workers AI is the default provider and uses a JSON-schema-constrained instruction-tuned model. `LINK_ABUSE_JUDGMENT_PROVIDER=anthropic` swaps the transport to the configured Anthropic secret without changing the input or output contract. Invalid output and provider failure become a `medium` result with reason `judgment_failed`, ensuring the operator is still notified.

Every judgment is stored with its risk, concise reason, optional impersonated brand, external targets, provider, model, and time. A structured log marker sends the result to the existing Slack alert worker, which applies a per-artifact alert cooldown.

### Why judgment never stops sharing

View spikes also occur for legitimate viral artifacts, and model judgments can be wrong or unavailable. Neither a trigger nor a judgment changes visibility, hides content, throttles traffic, or creates another artifact state. The operator investigates the alert and, when necessary, pauses the link or changes its visibility to `private`. New anonymous entrypoint and asset requests then fail their current-access checks, including requests with an unexpired bundle cookie.

### Non-goals

- No pre-publication content classification or pattern scan.
- No LLM call without one of the three triggers.
- No automatic suspension, hiding, or throttling.
- No storage of referrer URLs, query values, IP addresses, or user agents.
