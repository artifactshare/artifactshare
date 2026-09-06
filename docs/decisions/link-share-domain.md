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

View spikes also occur for legitimate viral artifacts, and model judgments can be wrong or unavailable. Neither a trigger nor a judgment changes visibility, hides content, throttles traffic, or creates another artifact state. The operator investigates the alert and, when necessary, uses the existing visibility control to change the artifact to `private`. Existing anonymous tokens and content requests then fail their live visibility checks.

### Non-goals

- No pre-publication content classification or pattern scan.
- No LLM call without one of the three triggers.
- No automatic suspension, hiding, or throttling.
- No storage of referrer URLs, query values, IP addresses, or user agents.
