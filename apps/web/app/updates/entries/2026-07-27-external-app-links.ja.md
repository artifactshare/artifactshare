---
title: 共有ページの外部アプリリンクを開けるように
date: 2026-07-27
products: [web]
kind: improve
---

Artifact Share Viewer に表示された共有 HTML、Markdown、静的サイトで、ページ内の `cursor:`、`vscode:`、`codex:`、`claude:`、`claude-cli:` リンクを対応アプリで開けるようになりました。共有ファイルから Cursor の MCP 設定や VS Code のファイルや設定を開き、Codex、Claude、Claude Code で新しい作業を始められます。外部アプリは自動では起動せず、閲覧者がページに元からあるリンクを実際にクリックし、ブラウザの外部アプリ起動確認で許可した場合だけ開きます。Viewer に新しいボタンを追加する変更ではなく、許可リスト外の URL スキームは引き続き遮断します。
