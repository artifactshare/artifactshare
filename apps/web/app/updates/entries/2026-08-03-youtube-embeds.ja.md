---
title: 共有ページ内で YouTube 動画を再生できるようになりました
date: 2026-08-03
products: [web]
kind: improve
---

共有された HTML、Markdown、静的サイトに埋め込まれた公式 YouTube 動画を、Viewer の画面内で再生できるようになりました。全画面再生にも対応しています。制作記録や説明資料を外部リンクへ分けず、動画を文脈の中で見せられます。

許可されるのは、`https://www.youtube.com` と `https://www.youtube-nocookie.com` の公式埋め込み iframe だけです。ほかの外部 iframe は引き続き遮断します。Permissions Policy の全画面表示は `self` とこの 2 つのオリジンだけに委譲し、ほかのブラウザー権限は広げません。

新しい埋め込み UI や Markdown 独自記法を追加する変更ではありません。投稿者が共有ページに含めた公式 iframe がそのまま動くようになります。
