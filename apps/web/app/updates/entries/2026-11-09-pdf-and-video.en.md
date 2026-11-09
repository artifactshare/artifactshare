---
title: Share PDFs and MP4 videos
date: 2026-11-09
products: [web, cli]
kind: new
notice: true
---

You can now share PDFs and MP4 videos the same way as HTML and Markdown. Hand over a document or a screen recording as it is, and the people you share it with read or play it on the shared page. Comments work as before.

On the web, choose the file and upload it. From CLI 0.23.0, share one with `artifactshare share report.pdf` and update it to the next version at the same URL with `update`.

<!-- more -->

In a PDF, the page list shows thumbnails to jump to a page, and search finds text in the document (Ctrl+F or Cmd+F on the PDF opens it too). Display settings choose between one page at a time and continuous pages, and set the size. A password-protected PDF does not open, and the shared page says so.

Videos never play on their own. The player has play and pause, back 10 seconds, seeking, playback speed and full screen, plus volume on computers; phones use the device volume. On iPhone, full screen uses the device's own player.

Both can be downloaded as the original file. A file can be shared when its name ends in `.pdf` or `.mp4` and its contents are in that format, up to the same 25 MiB limit as other files. The CLI's `append`, `preview` and `artifacts get` text readback do not support PDFs or videos.
