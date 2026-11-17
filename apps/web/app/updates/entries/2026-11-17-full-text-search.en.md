---
title: Search text inside files
date: 2026-11-17
products: [web, mcp, cli]
kind: new
details: guides-search
---

Search now finds body text in HTML and Markdown files, including HTML and Markdown pages in static sites, as well as titles. Results can be narrowed by owner, project, and period on the web, through MCP `list_artifacts`, and through CLI `artifacts list`.

<!-- more -->

Search uses the current published version. PDF and video files match by title and description; PDF body text and video speech are not included.

Results include eligible files you own, files shared directly with you, and files shared with you through a workspace or project. Files you can open only through admin rights do not appear. Files in archived projects are excluded by default.

For files available to you only through link sharing, search includes only those you have already opened while signed in, while the link is unexpired, not suspended, and permitted by the workspace link policy. Ownership or a direct share can independently make a file discoverable without a previous visit. Restricted agent and bot credentials further limit results to their readable project range.
