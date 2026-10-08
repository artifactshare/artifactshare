---
title: フォルダ共有で WebAssembly が動き、ブラウザの中で SQL を実行できるようになりました
date: 2026-10-08
products: [web, cli, agent]
kind: new
notice: true
---

フォルダ共有（静的サイト）で、WebAssembly と Worker を使えるようになりました。DuckDB-WASM のようなブラウザ内の分析エンジンを jsDelivr から読み込み、フォルダに同梱した Parquet などのデータを、その場で SQL で集計できます。サーバーを用意せずに、触って絞り込めるデータダッシュボードを共有できます。

サンプルとして、気象庁の 158 地点・約 150 年分の月別値（20 万行）を可視化したダッシュボードを公開しました。年を動かすたびに、ブラウザの中で SQL が実行されます。サンプルの URL とソースコードは [artifactshare/examples](https://github.com/artifactshare/examples) にあります。

<!-- more -->

フォルダには `.wasm` と `.parquet` のファイルも入れられます。ファイル数とサイズの上限は、これまでと同じです。データだけを差し替えて更新すると新しい版になり、URL は変わりません。版が増え続ける場合は、残す版の数も設定できます。

DuckDB-WASM の拡張機能（Parquet の読み込みなど）は `extensions.duckdb.org` から読み込まれます。JavaScript の `eval` と `new Function` は引き続き使えず、通信できる相手も決められた範囲に限られます。単一ファイルの HTML と Markdown の扱いは変わりません。

ブラウザの中で集計するため、ダッシュボードを閲覧できる人は、同梱したデータファイルそのものも取得できます。見せる範囲を人ごとに変える必要があるデータには向きません。

エージェントには、同梱のスキルが読み込み方を案内します。データの URL は `new URL('data/rows.parquet', location.href).href` のように、ページを基準にした絶対 URL で渡してください。
