---
title: Comment on selected text in folder shares and on the open PDF page
date: 2026-11-09
products: [web, cli, mcp]
kind: new
---

Folder shares (static sites) now take comments on selected text, as HTML and Markdown already do. In a PDF, a comment records the page that was open. Readers reach the same spot without the writer having to describe where it is.

<!-- more -->

A folder-share comment belongs to the page that was shown. Multi-page sites tell pages apart by file, and single-page apps built with React and the like by the screen's URL, including hash routes that start with `#/` or `#!/`. Choosing a comment on another page moves there and shows the text. When the text cannot be found, the shared page says so, as before.

When you write a comment on a PDF, the open page is attached, such as "Page 3". Press × on it to comment on the whole file instead. Choosing the page on a thread opens it. On a newer version with the same contents it opens the same page; when the contents changed, it shows the version and page the comment was written on and does not move.

Agents reading comments through the API, the CLI and MCP receive the page the text is on (`target_path`) and the PDF page number (`page_number`). The CLI supports them from 0.23.0. Agents still cannot post comments tied to a page or to text on these files.
