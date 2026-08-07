---
title: 静的サイト共有で Mermaid 図を表示できるようになった
date: 2026-07-10
products: [web, cli]
kind: new
---

Mermaid のコードブロックを含む HTML をフォルダごと共有すると、共有サイトの閲覧画面で図が描画されます。

<!-- more -->

## 試し方

1. `mermaid` フェンス付きコードブロックを含む `.html` を用意する。
2. `artifactshare share ./your-site` でフォルダを共有する。
3. 共有リンクを開き、ブラウザ上で図が表示されることを確認する。

Mermaid は閲覧時に描画するため、共有前に別途ビルドする必要はありません。
