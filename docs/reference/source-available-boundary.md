# source-available 公開境界

この文書は、製品ソースを管理する公開 repository の境界と検証方法を説明します。顧客・個人情報、非公開の運用情報、private issue/PR の URL や番号は含めません。

## 公開文書と license

公開 repository には入口である `README.md`、利用条件を定める `LICENSE`、参加方法を定める `CONTRIBUTING.md`、脆弱性報告先を定める `SECURITY.md`、外部からの proposal を受け付ける `proposals/` を収録します。`README.md` は製品、主要構成、開発参加への入口を担い、この文書は repository の境界、検証方法、公開 checkout の技術的な成立条件を担います。

root の `LICENSE` は `packages/cli/` を含む公開 tree のソフトウェアと関連文書に適用されます。npm で公開された 0.9.0 以前の CLI は Apache-2.0 のままです。repository と 0.10.0 以降の CLI は source-available license の対象です。0.10.0 は意図的に公開せず、0.10.1 が新しい license での最初の npm 公開版です。root license は日本語版が正本、英語版が参考訳です。

`proposals/` は公開 repository へ外部から寄せられる proposal の置き場です。scanner は、ここにも個人情報と非公開参照の検査を例外なく適用し、finding があれば検証を fail closed で停止します。

## 境界と manifest

`config/repository-boundary.json` は公開 tree の path を `canonical`、`private-overlay`、`public-only` に分類する自己完結した manifest です。pre-push hook と public CI は各commitのtracked treeを検査し、新しいpathの未分類、ruleの重複、symlink、submoduleをfail closedで拒否します。privateへのhandoffも同じmanifestを使います。

公開 root の `package.json` と `apps/web/package.json` は local build・test・preview 用で、deploy・運用 script を含めません。`apps/web/wrangler.jsonc` は local/preview 専用で、production ID、route、secret、private service、billing/analytics の実 ID を持ちません。型生成に必要な billing 値は local placeholder だけです。

公開 CI は `.github/workflows/public-ci.yml` で、GitHub-hosted runner 上の install、fixture generation、local DB setup、validate、runtime smoke を実行します。credential、self-hosted runner、deploy、publish には到達できません。

PR は install 前の境界 guard だけを実行し、full CI は merge queue の `merge_group` だけで実行します。private handoff CI は対象 commit が public main に含まれ、同じ SHA の `Public full validation` check run が成功していることを GitHub API から確認します。main への push は public full CI の入口ではありません。

公開テストからは、private cron の設定値を読む契約テストと、OS 固有の internal visual baseline との比較だけを除外します。migration guard を含む製品ソースの単体テスト、GitHub-hosted Chromium で再現できる browser behavior test、Worker build/runtime smoke は実行します。visual test file の明示一覧は public test audit で固定し、新規 test が黙って除外されないようにします。

## publicを正本とするhandoff

privateへのhandoffはpush URLを`no_push`にした名前付きpublic remoteと`config/repository-boundary.json`を正本とし、検証済みのpublic main SHAを入力にします。canonicalだけを反映し、private-overlayはprivate側の値を保持し、public-onlyは取り込みません。private CIはpublic mainへの包含、同じSHAのfull validation成功、canonical tree、private overlay digestを照合します。

公開 checkout では `pnpm install` の `prepare` が public 境界用の `pre-push` hook を導入します。既存 hook がある場合は上書きせず warning を出すため、内容を統合するか、不要な既存 hook を削除してから `pnpm install` を再実行してください。guard を更新した場合も再 install で hook を更新します。

## scan

`config/public-repository-scan.json` は scanner の検出 pattern と、カテゴリ・pattern 単位の最小 allowlist を分離して管理します。scan はpublic repositoryのtracked regular text fileだけを読み、binaryは安全に無視します。credential、個人・顧客データ、private network、private 文書・issue 参照、production resource/service/billing/analytics identifier、public CI の private runner/secret/deploy/publish 到達性を検出します。各カテゴリには負対照を持ち、findingが1件でもあれば検証を停止します。

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
