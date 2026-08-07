# source-available 公開境界

この文書は、監査済みの製品ソースだけを含む公開 tree の境界と検証方法を説明します。非公開の履歴、顧客・個人情報、運用情報、削除台帳、全ファイル inventory、元 commit、issue/PR の URL や番号は公開物に含めません。

## 公開文書と license

公開 tree には repository の入口である `README.md`、利用条件を定める `LICENSE`、参加方法を定める `CONTRIBUTING.md`、脆弱性報告先を定める `SECURITY.md`、外部からの proposal を受け付ける `proposals/` を収録します。`README.md` は製品、主要構成、開発参加への入口を担い、この文書は export の境界、検証方法、公開 checkout の技術的な成立条件を担います。

root の `LICENSE` は `packages/cli/` を含む公開 tree のソフトウェアと関連文書に適用されます。npm で公開された 0.9.0 以前の CLI は Apache-2.0 のままです。repository と 0.10.0 以降の CLI は source-available license の対象で、0.10.0 は未公開です。root license は日本語版が正本、英語版が参考訳です。

`proposals/` は公開 repository へ外部から寄せられる proposal の置き場です。公開前の scanner は、ここにも個人情報と非公開参照の検査を例外なく適用し、finding があれば export 全体を fail closed で停止します。

## 境界と manifest

`config/public-export-include.json` は公開対象と公開先 path を列挙する include manifest です。公開 tree はこの manifest に基づく fresh export から作られ、新しい path の未分類や rule の重複は生成時に fail closed になります。全 path の分類、削除台帳、元 repository の inventory は公開しません。

公開 root の `package.json` と `apps/web/package.json` は local build・test・preview 用で、deploy・運用 script を含めません。`apps/web/wrangler.jsonc` は local/preview 専用で、production ID、route、secret、private service、billing/analytics の実 ID を持ちません。型生成に必要な billing 値は local placeholder だけです。

公開 CI は `.github/workflows/public-ci.yml` で、GitHub-hosted runner 上の install、fixture generation、local DB setup、validate、runtime smoke を実行します。credential、self-hosted runner、deploy、publish には到達できません。

公開テストからは、private cron の設定値を読む契約テストと、OS 固有の internal visual baseline との比較だけを除外します。migration guard を含む製品ソースの単体テスト、GitHub-hosted Chromium で再現できる browser behavior test、Worker build/runtime smoke は実行します。visual test file の明示一覧は public test audit で固定し、新規 test が黙って除外されないようにします。

## fresh export の性質

公開 tree は tracked regular file の公開分類だけから生成します。symlink、submodule、untracked/ignored file、`.git`、非公開 file は対象外です。出力先にファイルが残っている場合は上書きしません。

公開 `PUBLIC-EXPORT-RECEIPT.json` は exported path、SHA-256、manifest version だけを持ちます。private receipt は、あらかじめ作成した出力先外の directory に新規ファイルとして書き、private commit と `HEAD` tree の全分類・全ファイル digest を記録します。symlink を経由した出力先内への書き込みと既存 receipt の上書きは拒否します。公開 receipt は次回 export の入力になりません。

同じ元 commit と manifest から二度 fresh export し、公開 receipt の内容が一致することを生成側で確認します。

## scan

`config/public-export-scan.json` は scanner の検出 pattern と、カテゴリ・pattern 単位の最小 allowlist を分離して管理します。scan は export directory の regular text file だけを読み、binary は安全に無視します。credential、個人・顧客データ、private network、private 文書・issue 参照、production resource/service/billing/analytics identifier、public CI の private runner/secret/deploy/publish 到達性を検出します。各カテゴリには負対照を持ち、現行 export の scan は 0 findings でなければ公開できません。

scanner を変更するときは各カテゴリの negative control を追加し、allowlist は必要な path/category/pattern だけに限定します。予約済み example domain と loopback、local binding 名の例だけを理由付きで許可します。

## 公開 tree の検証

公開 checkout では次の順に検証します。

```sh
pnpm install --frozen-lockfile
pnpm --filter @artifactshare/web exec playwright install --with-deps chrome
pnpm fixtures:build
pnpm db:apply:local
pnpm validate
pnpm test:runtime
```

`pnpm validate` は format、lint、型、単体・browser・integration test、Worker dry-run build、React Doctor、公開スキャンを含みます。`pnpm test:runtime` は local preview、scheduled handler、開発専用 sign-in route の非到達を実測します。
