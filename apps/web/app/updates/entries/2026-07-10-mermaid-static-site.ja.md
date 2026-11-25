---
title: 静的サイトの共有で Mermaid 図を表示できるようにしました
date: 2026-07-10
products: [web, cli]
kind: new
---

Mermaid のコードブロックを含む HTML をフォルダごと共有すると、共有ページで図が描画されるようになりました。

<!-- more -->

## 試し方

1. `mermaid` のコードブロックを含む `.html` ファイルを用意します。
2. `artifactshare share ./your-site` でフォルダを共有します。
3. 共有リンクを開き、ブラウザ上で図が表示されることを確認します。

Mermaid は閲覧時に描画するため、共有前にビルドする必要はありません。
