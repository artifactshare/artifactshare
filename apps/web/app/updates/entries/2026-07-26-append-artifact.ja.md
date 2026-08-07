---
title: 既存の内容を再送せずに追記
date: 2026-07-26
products: [cli, mcp]
kind: new
---

Artifact Share CLI 0.8.2 の `artifactshare append <target> <path>` とリモート MCP の `append_artifact` は、単一ファイルへ内容を追記し、同じ共有リンクで新版を作ります。Markdown では現在の source の末尾、HTML では `body` の閉じタグがあればその直前、なければ末尾へ追加します。改行や区切りは加えません。

別の更新が先に反映された場合は、その更新を保持したまま `version_conflict` と現在の version ID を返します。再実行すると最新版へ追記します。static site は対象外です。全文を置き換える場合は、CLI の `update` または MCP の `update_artifact` を使います。
