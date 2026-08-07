---
title: YouTube videos now play in shared pages
date: 2026-08-03
products: [web]
kind: improve
---

Official YouTube videos embedded in shared HTML, Markdown, and static sites can now play directly in Viewer, including in fullscreen. Production records and explanatory material can show videos in context instead of separating them into external links.

Only official embed iframes from `https://www.youtube.com` and `https://www.youtube-nocookie.com` are allowed. Other external iframes remain blocked. The Permissions Policy delegates fullscreen only to `self` and these two origins; no other browser permissions are expanded.

This change does not add a new embedding interface or custom Markdown syntax. It enables official iframes that authors already include in their shared pages.
