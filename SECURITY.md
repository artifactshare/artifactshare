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
- Artifact content is served from a sandbox origin. Artifact Share does not send the app session cookie or user credentials to that origin. Short-lived, artifact-scoped bundle tokens or cookies authorize delivery. Content Security Policy and network allowlists restrict network access, and `frame-ancestors` limits embedding to Artifact Share and approved MCP host sandboxes. These controls reduce risk but do not guarantee complete isolation of arbitrary content.
- Integrations such as Slack authorize their own installations and apply Artifact Share access checks before disclosing protected file content. Payment webhooks are authenticated by the payment provider's signature and processed idempotently.
- Deleting content removes it from normal product access. It does not guarantee immediate physical erasure from backups. The published privacy policy governs retention and deletion commitments.

## What we cannot guarantee

No system can guarantee that arbitrary uploaded content is harmless, that a bearer URL reached only its intended recipient, or that an external service will handle data under Artifact Share's controls. Do not place secrets in public or link-shared content, and review the destination before sending content to an integration or external AI service.

## Report a vulnerability privately

Use GitHub Private Vulnerability Reporting for this repository. If that channel is unavailable, email `support@artifactshare.com`.

Include:

- the affected revision or released version;
- the affected configuration or feature;
- the security impact; and
- a minimal reproduction that is safe to run.

Do not test against another person's data, a workspace you are not authorized to use, or a production environment you do not own. Do not publish exploit details in an issue, proposal, pull request, or social media post. We may ask for additional information while we validate and address the report.
