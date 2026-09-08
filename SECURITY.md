# Security Policy

This document describes Artifact Share's public security boundaries and how to report a vulnerability. It does not disclose internal infrastructure or storage details.

## Protected assets and actors

Artifact Share protects shared files and versions, account and workspace data, access grants, authentication and API credentials, integration credentials, billing state, and service availability.

Relevant actors include unauthenticated viewers; holders of link-sharing URLs; workspace members, admins, and owners; artifact owners and explicitly granted viewers; holders of CLI or API bearer tokens; OAuth and device-authorization clients; realtime connections; external AI services and connectors; MCP widget hosts; external integrations such as Slack; payment webhook senders; and TechTalk, Inc. as the service operator. There is no separate operator privilege exposed through the product's user authorization model.

## Trust boundaries

- A link-sharing URL or token is bearer authorization: possession grants the access encoded by it and does not verify the recipient's identity. A normal viewer token is exchanged once and subsequent bundle requests use a short-lived, artifact-scoped cookie. An embed token may be reused until it expires so an approved host can render the same widget again.
- Workspace membership, owner or admin authority, artifact ownership, project membership, and explicit email grants are separate authorization boundaries. One does not imply the others.
- CLI and API bearer tokens act with the permissions of the account that issued them. OAuth and device-authorization clients receive only the access approved through their authorization flow. Realtime connections are authenticated and remain subject to resource authorization.
- When a user explicitly selects content and an operation involving an external AI service or connector, Artifact Share sends the data needed for that operation to the selected destination. That destination's terms and security practices then apply.
- For artifacts shared by link and publicly reachable without sign-in, anonymous view spikes, recognized advertising click parameters, a publish burst in a new Free workspace, or a manual check requested by the file owner, workspace owner, or workspace admin may trigger an automated review. The review sends the text extracted from the shared file itself (which may contain whatever personal data the file's author put in it), its external link hostnames, the trigger kind and details, the sharer's account age in days, and the workspace plan tier to an AI provider: Workers AI on Cloudflare by default, or an alternative provider only when configured by the operator; Artifact Share adds no account identifiers of its own. Trigger details are the advertising parameter name; view count and window length; a manual-request marker; or observed publication count, configured new-workspace age threshold, and configured limit. The result is used only to notify the operator and never changes the artifact automatically.
- Under the default thresholds, the service applies a publication limit to Free workspaces less than 14 days old and refuses another publication when it observes 20 counted files in the rolling 24-hour window. Each file counts once based on its most recent change to link visibility, or its creation with link visibility. Publication history remains counted for the rest of that 24-hour window when a file is made private, hidden, or deleted, so those actions do not restore a slot. A concurrent publication may be refused even when an earlier preflight saw room, because the final decision is made with the publication. Callers should honor the returned retry duration before trying again. Existing links remain available. Reaching the limit can start a `publish_burst` review, but enforcement does not depend on the review starting or succeeding, and its result does not lift the limit. Workspace link policies start with a 30-day default and no maximum expiry, and can set finite defaults and maximums from 1 to 365 days or allow no expiration.
- A human operator may pause or resume link sharing after a review or report. Pausing blocks anonymous URL-only access while the owner and explicitly granted viewers retain access; the owner receives the reason by email and can appeal from the file page. Artifact Share stores the submitted appeal text with the file's event history. Operators receive the first 300 Unicode code points in an alert, or the full appeal when it is shorter. Resuming sends another owner notice. The automated review never pauses, hides, or throttles a link by itself.
- Artifact content is served from a sandbox origin. Artifact Share does not send the app session cookie or user credentials to that origin. Short-lived, artifact-scoped bundle tokens or cookies authorize delivery. Content Security Policy and network allowlists restrict network access, and `frame-ancestors` limits embedding to Artifact Share and approved MCP host sandboxes. These controls reduce risk but do not guarantee complete isolation of arbitrary content.
- Integrations such as Slack authorize their own installations and apply Artifact Share access checks before disclosing protected file content. Payment webhooks are authenticated by the payment provider's signature and processed idempotently.
- Deleting content removes it from normal product access. It does not guarantee immediate physical erasure from backups. The published privacy policy governs retention and deletion commitments.

## What we cannot guarantee

No system can guarantee that arbitrary uploaded content is harmless, that a bearer URL reached only its intended recipient, or that an external service will handle data under Artifact Share's controls. Do not place secrets in public or link-shared content, and review the destination before sending content to an integration or external AI service.

## Link-viewer trial control

Viewer and Open Graph image requests share a Cloudflare Workers Rate Limiting binding keyed by the Cloudflare-provided client IP. The initial limit is 300 requests per 60 seconds per Cloudflare location. A rejected request returns `429` with `Retry-After: 60` before artifact lookup.

The limiter is an abuse and database-load backstop, not the bearer credential itself. Binding failures fail open so an infrastructure fault does not revoke working share links; the application logs the binding failure without the requested URL. Local requests without the Cloudflare client-IP header or binding are not limited.

## Report a vulnerability privately

Use GitHub Private Vulnerability Reporting for this repository. If that channel is unavailable, email `support@artifactshare.com`.

Include:

- the affected revision or released version;
- the affected configuration or feature;
- the security impact; and
- a minimal reproduction that is safe to run.

Do not test against another person's data, a workspace you are not authorized to use, or a production environment you do not own. Do not publish exploit details in an issue, proposal, pull request, or social media post. We may ask for additional information while we validate and address the report.
