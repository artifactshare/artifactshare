---
title: Share a slide or a filtered dashboard view by its URL
date: 2026-10-09
products: [web, agent]
kind: new
notice: true
---

The share page URL now stays in sync with the `#` (URL fragment) of the content inside it. If a page keeps its state in the fragment, such as a slide number or a dashboard's tab and filters, the share page URL reflects what you are looking at. Send that URL and the recipient opens the same view.

For example, opening `/a/<id>#/3` starts a slide deck on slide 3. Narrowing a dashboard by date or channel changes the URL to something like `#from=2026-07-01&media=video`. Copy link includes the current fragment too.

<!-- more -->

This works for HTML, Markdown, and folder shares (static sites). In Markdown, table-of-contents links to headings are reflected as well. Pages need no Artifact Share-specific code: read and write `location.hash` as usual, or change the fragment with `history.replaceState`.

The share page does not add history entries, so Back works as before. When a share requires sign-in, you return to the same fragment after signing in.

Only the fragment is synced. Pages that keep state in the query (`?tab=`) or the path are not covered. In folder shares, the URL updates only while the entry page is open and stays unchanged while you are on another page. The CLI local preview is not covered.
