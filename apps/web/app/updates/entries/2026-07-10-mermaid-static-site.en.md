---
title: Static site shares can include Mermaid diagrams
date: 2026-07-10
products: [web, cli]
kind: new
---

Upload a folder that contains HTML with Mermaid code blocks and Artifact Share renders the diagrams in the shared site view.

<!-- more -->

## How to try it

1. Add a `.html` file with a fenced `mermaid` code block.
2. Share the folder with `artifactshare share ./your-site`.
3. Open the shared URL and confirm the diagram appears in the browser preview.

Mermaid is rendered at view time, so you do not need a separate build step before sharing.
