---
title: Link sharing is now available on Free
date: 2026-09-07
products: [web, cli, mcp, agent]
kind: new
notice: true
details: guides-link-sharing
---

Free workspaces can now choose link sharing for each file. Anyone with the share link can view the file without signing in to Artifact Share. Expiration works the same as on Plus: the workspace default is 30 days, and no expiration is available when the workspace policy allows it.

In the browser, choose "Anyone with the link" in the who-can-view dialog. In the CLI, pass `--visibility link`; in MCP, set `visibility` to `link`.

<!-- more -->

On the shared page, recipients see an ⓘ next to the creator's name. It explains that the file was shared by an Artifact Share user and offers a way to report suspicious content. The shared page carries no permanent notice.

Abuse protection lives in the system and in operations rather than in that notice. A Free workspace younger than 14 days can turn at most 20 files into link shares per day; when the limit is reached, the save is refused and works again after the window passes. When a report or an automatic check calls for a look, the operators may pause link sharing for a file. The owner is emailed the reason and can appeal from the file's page, and the owner and the people it was shared with directly can still open it while it is paused.

Plus and Team workspaces have no such limit. Uploads from external members remain a Plus and Team feature. A workspace that has paused link sharing in its settings can use it again once the owner resumes it there.

If you subscribed to Plus for link sharing and no longer need the other Plus features, you can return to Free. The workspace owner opens Settings, then Billing, chooses "Open customer portal", and cancels the subscription. Plus stays active until the end of the current period, then the workspace switches to Free. Files and share links stay as they are. The storage and project limits return to those of Free, and new uploads are refused while the workspace is over the Free storage limit.
