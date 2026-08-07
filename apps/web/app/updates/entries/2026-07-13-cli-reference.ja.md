---
title: Artifact Share CLI の公開リファレンス
date: 2026-07-13
products: [cli, web]
kind: new
details: private-mobile-design-handoff
---

移動中にモバイルの開発環境とエージェントで作った設計文書を、あとから PC で引き継げます。
この CLI 環境の利用者設定で `home_audience` を `private` に設定すると、毎回共有範囲を指定しなくても、作業中の文書を意図せず社内全員へ共有することを防げます。

新しい CLI リファレンスで、ターミナルからファイルを共有、更新、読み取り、コメント、整理する方法を案内します。
JSON 出力、設定、投稿先、復旧方法もまとめ、利用者とエージェントが必要なコマンドをすぐ見つけられるようにしました。

投稿先を指定しない `share` は home に投稿されます。
個人の安全な既定値には利用者設定を使い、`--scope effective` で実効値を確認します。
`--scope repository` は参加者全員が合意した方針に限って使います。
