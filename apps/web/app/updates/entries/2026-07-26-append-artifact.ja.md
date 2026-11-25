---
title: 既存の内容を再送せずに追記できるようにしました
date: 2026-07-26
products: [cli, mcp]
kind: new
---

Artifact Share CLI 0.8.2 の `artifactshare append <target> <path>` とリモート MCP の `append_artifact` で、単一ファイルの末尾に内容を追記し、同じ共有リンクのまま新しいバージョンを作れるようになりました。Markdown では現在の本文の末尾に、HTML では `</body>` があればその直前、なければ末尾に追加します。改行や区切り文字は自動で入りません。

別の更新が先に反映されていた場合は、その更新を上書きせず `version_conflict` と現在のバージョン ID を返します。やり直すと最新版へ追記できます。なお、静的サイトは対象外です。全文を置き換えたいときは、CLI の `update` か MCP の `update_artifact` を使います。
