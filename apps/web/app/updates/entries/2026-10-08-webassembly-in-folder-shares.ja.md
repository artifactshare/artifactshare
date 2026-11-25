---
title: フォルダ共有で WebAssembly を動かせるようにしました
date: 2026-10-08
products: [web, cli, agent]
kind: new
notice: true
---

フォルダ共有（静的サイト）で、WebAssembly と Worker を使えるようにしました。DuckDB-WASM のようなブラウザ内分析エンジンを jsDelivr から読み込み、フォルダに同梱した Parquet などのデータをその場で SQL 集計できます。サーバーを立てずに、手元で触って絞り込めるデータダッシュボードを共有できます。

サンプルとして、気象庁の 158 地点・約 150 年分の月別値（20 万行）を可視化したダッシュボードを公開しました。年を動かすたびにブラウザ内で SQL が走ります。サンプルの URL とソースコードは [artifactshare/examples](https://github.com/artifactshare/examples) にあります。

<!-- more -->

フォルダには `.wasm` と `.parquet` も含められます。ファイル数とサイズの上限はこれまでと同じです。データだけを更新すれば同じ URL のまま新しいバージョンになり、バージョンが増え続ける場合は残すバージョンの数も設定できます。

DuckDB-WASM の拡張機能（Parquet の読み込みなど）は `extensions.duckdb.org` から読み込まれます。JavaScript の `eval` と `new Function` は引き続き使えず、通信先も許可された範囲に限られます。単一ファイルの HTML と Markdown の扱いは変わりません。

ブラウザ内で集計する仕組みのため、ダッシュボードを閲覧できる人は同梱したデータファイルそのものも取得できます。閲覧者ごとに見せる範囲を切り分ける必要があるデータには向きません。

エージェントには同梱のスキルが読み込み方を案内します。データの URL は `new URL('data/rows.parquet', location.href).href` のように、ページを基準にした絶対 URL で渡してください。
