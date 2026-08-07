# Share a link that opens without sign-in

Link sharing lets anyone with the URL view a file without signing in to Artifact Share. A link can have an end date or, when the workspace policy allows it, no expiration.

## Start with Who can view on the web

1. Open **Who can view** for the file.
2. Select **Anyone with the link**.
3. Under **Link expiration**, choose an end date. If **No expiration** is shown, you can select it instead.
4. Select **Save**, then send the share link to the recipient.

The latest end date you can select is set by the workspace policy. New links start with the workspace default. The initial default is 30 days, and the initial maximum is 90 days. If an owner or admin has changed these settings, the workspace settings apply.

## After expiration, the URL alone no longer grants access

After the end date, a person who only has the URL can no longer view the file. The publisher, admins, explicitly granted viewers, and anyone else with separate access can still open it.

Publishers and admins can see that the link has expired and view its current expiration. To share it by link again, republish it with a new end date or no expiration, within the current workspace policy.

Existing links also stop working for URL-only access when a Team admin disables link sharing across the workspace. Enabling link sharing again does not automatically republish links that have already expired.

## Availability and controls differ by plan

- Free does not include link sharing or uploads from external members. Their settings remain visible but cannot be changed.
- Plus lets people select link sharing for each file. The owner can set the default expiration for new links and the maximum expiration people may choose. Uploads from external members are also available. Plus does not include workspace-wide switches for link sharing or uploads from external members.
- Team lets owners and admins manage the expiration policy and enable or disable link sharing and uploads from external members across the workspace. In a new Team workspace, link sharing is disabled and uploads from external members are enabled.

The default and maximum expiration can be any whole number from 1 to 365 days. The default can be set to **No expiration**, and the maximum can be set to **No limit**. A no-expiration default is available only when the maximum has no limit. Management policies can be changed only in the web settings.

## Choose a finite expiration, no expiration, or omission in MCP and the CLI

In the MCP tools `share_artifact` and `edit_artifact`, set `link_expires_at` to an RFC 3339 UTC timestamp for a finite expiration or explicitly set it to `null` for no expiration. If you omit the field when creating a file, the workspace default applies. If you omit it when editing a file, the current expiration is preserved.

In the CLI, use `--link-expires-at <RFC3339 UTC>` for a finite expiration or `--no-link-expiry` for no expiration. The two options are mutually exclusive.

MCP and CLI create, edit, and get results include `link_expires_at` as either a UTC timestamp or `null` for no expiration. Separate error codes distinguish a Free plan restriction, link sharing disabled by a Team workspace policy, and an invalid timestamp or expiration beyond the allowed maximum.

## Set who can view a file

Open a file you own, then use Who can view to choose the audience and link expiration.

[Open Artifact Share](/)
