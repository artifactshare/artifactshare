---
title: 共有ページ内で YouTube 動画を再生できるようにしました
date: 2026-08-03
products: [web]
kind: improve
---

共有された HTML、Markdown、静的サイトに埋め込まれた公式の YouTube 動画を、共有ページの中でそのまま再生できるようになりました。全画面再生にも対応しているため、制作記録や説明資料から外部リンクへ飛ばさず、文脈の中で動画を見せられます。

許可されるのは `https://www.youtube.com` と `https://www.youtube-nocookie.com` の公式埋め込み iframe だけで、ほかの外部 iframe は引き続き遮断します。全画面表示の権限も `self` とこの 2 つのオリジンだけに限り、ほかのブラウザ権限は広げません。

新しい埋め込み UI や Markdown の独自記法を追加するのではなく、共有ページに含めた公式 iframe がそのまま動くようになります。
