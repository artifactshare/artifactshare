---
title: Wider lists make long file names readable
date: 2026-07-17
products: [web]
kind: improve
---

The Home, Recently Viewed, Projects, and Project Detail list pages now use more of the available width. The name column takes up the remaining space, so long file names no longer get cut off.

<!-- more -->

List pages used to cap out at around 790px, regardless of window width. The name column never grew, so file names sharing a common prefix — like a fiscal period or department code — got truncated and were hard to tell apart.

We reworked the file list table so the name column now fills the remaining width. Long file names stay readable even on a typical laptop screen.

View count and comment count are now combined into a single "Views & Comments" column.

On narrow screens, where the table collapses into a stacked layout, who can view (shared with specific people, project, everyone in the workspace, etc.) now uses the same chip style as the table, so it looks consistent across the switch. The stacked layout still kicks in below the width where a table no longer fits, and we adjusted that breakpoint so there's no longer a middle width where the layout looks broken.
