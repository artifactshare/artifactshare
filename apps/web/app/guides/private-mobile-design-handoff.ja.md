# モバイルの設計文書を非公開のまま PC へ引き継ぐ

> モバイルで作った設計文書を、自分だけが見える状態で共有し、PC で続きを進める手順です。

やることは 2 つだけです。

1. モバイルのエージェントに `share ./design.md --home --visibility private` で投稿してもらう。
2. 返ってきた共有リンクを PC で開いて、続きを進める。

## `--visibility private` を付けた投稿は自分にしか見えない

モバイル側のエージェントに、次のコマンドで投稿してもらいます。

```bash
npx --yes @artifactshare/cli share ./design.md --home --visibility private
```

共有範囲は投稿ごとに指定できます。`--visibility private` を付けた投稿を見られるのは自分だけです。指定しない場合の既定はワークスペース公開になり、同じワークスペースのメンバーにも見えます。

投稿に成功すると共有リンクが返ります。引き継ぎに必要なのはこの URL だけです。

## PC では URL を開くだけで続きを進められる

返ってきた URL を PC のブラウザで開くか、PC のエージェントに `open <artifact-url>` を渡します。PC での編集や実装も、モバイルで作った文書と同じファイルのまま続けられます。

## 毎回 private にしたいなら既定値を変える

home へ投稿するたびに `--visibility private` を付けるのが手間なら、既定の共有範囲を private に変えておけます。

```bash
npx --yes @artifactshare/cli config set home_audience private --scope user
```

この設定を入れると、この CLI 環境からの新しい home 投稿は、指定しなくても private になります。設定は端末ごとに保存され、Artifact Share アカウントには同期されません。PC からも home 投稿をするなら、PC 側でも同じコマンドを実行しておきます。

## 非公開にならないときはリポジトリ設定が優先されている

既定値を変えたのにワークスペース公開になってしまう場合は、リポジトリ側の `home_audience` 設定が端末側の設定より優先されています。実際に適用されている値は次のコマンドで確かめられます。

```bash
npx --yes @artifactshare/cli config get home_audience --scope effective
```

リポジトリ設定はそのリポジトリを使う全員に効くため、書き換えるときは関係者と合意してからにしてください。

コマンドの詳細は [CLI リファレンス](https://artifactshare.com/ja/guides/cli) を、製品の変更情報は [Updates](https://artifactshare.com/ja/updates) をご覧ください。
