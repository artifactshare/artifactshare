# Share a link that opens without sign-in

Link sharing lets anyone with the URL view a file without signing in to Artifact Share. A link can have an end date or, when the workspace policy allows it, no expiration.

## Start with Who can view on the web

1. Open **Who can view** for the file.
2. Select **Anyone with the link**.
3. Under **Link expiry date**, choose an end date. If **No expiration** is shown, you can select it instead.
4. If you changed the settings, select **Save**. Once link sharing is configured, copy the `https://<id>.artifactshare.link/` URL shown in the dialog, or use **Open as a recipient** to check the anonymous view before sending it.

The recipient URL uses a dedicated subdomain for that file. Owners still open `https://artifactshare.com/a/<id>` to manage the file while signed in.

Every recipient page has a small ⓘ next to the author that explains the page was published by an Artifact Share user and offers a **Report** action. For newer accounts, clicking a link that leaves Artifact Share also shows the destination and asks the recipient to continue or cancel (opening a link in a new tab with a modifier key skips this step).

The latest end date you can select is set by the workspace policy. New links start with the workspace default. The initial setting is a 30-day default with no maximum. Changing plans does not change the expiration settings. If an owner or admin has changed these settings, the workspace settings apply.

## After expiration, the URL alone no longer grants access

After the end date, a person who only has the URL can no longer view the file. The publisher, admins, explicitly granted viewers, and anyone else with separate access can still open it.

Publishers and admins can see that the link has expired and view its current expiration. To share it by link again, republish it with a new end date or no expiration, within the current workspace policy.

Existing links also stop working for URL-only access when a Team admin disables link sharing across the workspace. Enabling link sharing again does not automatically republish links that have already expired.

## Availability and controls differ by plan

- Free lets people select link sharing for each file, with the same expiration controls as Plus. New workspaces start with no maximum, so no expiration is available without changing a setting. Existing workspaces keep their saved maximum, which an owner can change in the web settings. Uploads from external members are not included on Free.
- Plus lets people select link sharing for each file. The owner can set the default expiration for new links and the maximum expiration people may choose. Uploads from external members are also available. Plus does not include workspace-wide switches for link sharing or uploads from external members.
- Team lets owners and admins manage the expiration policy and enable or disable link sharing and uploads from external members across the workspace. In a new Team workspace, link sharing is disabled and uploads from external members are enabled.

The default and maximum expiration can be any whole number from 1 to 365 days. The default can be set to **No expiration**, and the maximum can be set to **No limit**. A no-expiration default is available only when the maximum has no limit. Management policies can be changed only in the web settings.

## Limits for new Free workspaces

A Free workspace may be subject to a publication limit while it is new. With the default thresholds, the service checks workspaces less than 14 days old before each publication and refuses the request when it observes 20 counted files in the rolling 24-hour window. A file counts once based on its most recent change to link visibility, or on its creation with link visibility. Making a file private, hiding it, or deleting it does not remove its publication history during that window, so those actions do not restore a slot. Editing a file that is already shared by link does not add a publication.

When the observed count reaches the limit, another link publication is refused. A concurrent publication may also be refused even if an earlier preflight saw room, because the final decision is made together with the publication. Existing links remain available. Publishing is possible again when the observed count drops below the limit. Web API, MCP, and CLI responses indicate a retry duration based on the oldest counted publication; honor that duration before retrying. You can use specific-people sharing at any time. Plus and Team workspaces have no equivalent limit.

Reaching the limit can also start an automated review. The publication refusal applies independently of whether that review starts or succeeds, and the review result does not lift the limit. Other automated signals can also start a review. A report alerts the operators separately; neither path changes the file or any existing link automatically.

## Review and manual pauses

An operator can pause link sharing for a file after reviewing an alert or report. The pause blocks anonymous URL-only access, while the owner and people who were given direct access can still open the file. The owner receives an email with the reason, sees the pause state on the signed-in file page, and can submit an appeal there. An operator can resume the link, and the owner receives another email. The automated review never pauses a link by itself.

## Choose a finite expiration, no expiration, or omission in MCP and the CLI

In the MCP tools `share_artifact` and `edit_artifact`, set `link_expires_at` to an RFC 3339 UTC timestamp for a finite expiration or explicitly set it to `null` for no expiration. If you omit the field when creating a file, the workspace default applies. If you omit it when editing a file, the current expiration is preserved.

In the CLI, use `--link-expires-at <RFC3339 UTC>` for a finite expiration or `--no-link-expiry` for no expiration. The two options are mutually exclusive.

MCP and CLI create, edit, and get results include `link_expires_at` as either a UTC timestamp or `null` for no expiration. Separate error codes distinguish link sharing disabled by a workspace policy, an invalid timestamp or expiration beyond the allowed maximum, and a new Free workspace that reached its rolling publication limit. For the publication limit, MCP and the web API use `link-publish-rate-limited`; the CLI maps it to `link_publish_rate_limited`. For MCP, honor the returned retry duration and follow the direction in its hint. For the CLI, `error.recovery` indicates `retry_later`; use `error.message` and `error.hint` for when to retry, and honor the returned duration. Do not retry the same link publication immediately; retry it after the indicated waiting period or window.

## Set who can view a file

Open a file you own, then use Who can view to choose the audience and link expiration.

[Open Artifact Share](/)
