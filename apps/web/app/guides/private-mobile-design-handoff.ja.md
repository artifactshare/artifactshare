# モバイルの設計文書を非公開のまま PC へ引き継ぐ

> モバイルで作った設計文書を、自分だけが見える状態で共有し、PC で続きをする手順です。

やることは 2 つだけです。

1. モバイルのエージェントに `share ./design.md --home --visibility private` で投稿してもらう。
2. 返ってきた共有リンクを PC で開いて、続きをする。

## `--visibility private` を付けた投稿は自分にしか見えない

モバイル側のエージェントに、次のコマンドで投稿してもらいます。

```bash
npx --yes @artifactshare/cli share ./design.md --home --visibility private
```

共有範囲は投稿ごとに指定できます。`--visibility private` を付けた投稿を開けるのは自分だけです。付けない場合の既定はワークスペースで、同じワークスペースの参加者にも見えます。

成功すると共有リンクが返ります。引き継ぎに必要なのはこの URL だけです。

## PC では URL を開くだけで続きができる

返ってきた URL を PC のブラウザで開くか、PC のエージェントに `open <artifact-url>` を渡します。モバイルで作った文書と PC での編集・実装は、同じファイルとしてつながります。

## 毎回 private にしたいなら既定値を変える

home 投稿のたびに `--visibility private` を付けたくない場合は、既定の共有範囲を変えられます。

```bash
npx --yes @artifactshare/cli config set home_audience private --scope user
```

以後、この CLI 環境からの新しい home 投稿は、指定なしでも private になります。設定は端末ごとに保存され、Artifact Share アカウントには同期されません。PC からも home 投稿をするなら、PC 側でも同じコマンドを実行します。

## 非公開にならないときはリポジトリ設定が優先されている

既定値を変えたのに投稿がワークスペース公開になる場合は、リポジトリ設定の `home_audience` が利用者設定より優先されています。実際に使われる値は次のコマンドで確認できます。

```bash
npx --yes @artifactshare/cli config get home_audience --scope effective
```

リポジトリ設定はそのリポジトリを使う全員に効くため、変えるときは参加者と合意してからにします。

コマンドの詳細は [CLI リファレンス](https://artifactshare.com/ja/guides/cli) を、製品の変更情報は [Updates](https://artifactshare.com/ja/updates) を参照してください。
