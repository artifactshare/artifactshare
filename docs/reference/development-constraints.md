# 公開製品開発の現行制約

公開 checkout で製品コードを変更するときの判断用正本です。
機械検査が担う事項と、変更時に人が確認する事項を領域ごとに分けます。

## Analytics

- **機械検査で強制済み**：許可された送信経路外での `gtag('event', ...)` の直書きと `dataLayer.push` による event 送信、および parameter 定義の不整合は、`scripts/check-analytics-literals.mjs` と `scripts/check-analytics-dimensions.mjs` が検出します。
- **人が判断する現行規則**：利用者行動を変える変更では計測への影響を確認し、`apps/web/app/lib/analytics/events.ts` の定義と全送信経路を同じ変更で整合させます。管理設定を変更する script が対象 tree にある場合は、その script も同じ PR で更新します。
- **復元しない事項**：現行実装に該当がない分析基盤の手順は復元しません。

## 依存管理

- **機械検査で強制済み**：CI の frozen install と `scripts/public-ci-contract.test.mjs` が lockfile 前提を検査します。
- **人が判断する現行規則**：`pnpm-workspace.yaml` の `minimumReleaseAgeExclude` を変更する場合は、除外対象にした理由を確認します。依存変更では lockfile を再解決し、`pnpm install --frozen-lockfile` で再現性を確認します。
- **復元しない事項**：現行実装に該当がない build system 固有の規則は復元しません。

## D1 と SQLite

- **機械検査で強制済み**：schema と migration の整合は `apps/web/check-schema.mjs`、危険な migration 操作は `apps/web/check-migrations.mjs` が検査します。schema の正本は `apps/web/db/schema.sql` です。
- **人が判断する現行規則**：型より先に schema と migration の `CHECK`、`UNIQUE`、外部キーを確認します。migration 番号は作成時点の main の最新番号に続け、`UNIQUE` 列へ重複 index を作りません。D1 と SQLite の差に依存する変更では、constraint error の cause と再照会を組み合わせ、メール照合には `apps/web/app/lib/grant-emails.server.ts` の `lowerEmail` を使います。D1 とテスト用 SQLite では制約の適用方法が異なるため、型検査や SQLite test の成功だけで互換性を断定しません。
- **復元しない事項**：公開範囲外の運用手順は復元しません。

## React Router と Web UI

- **機械検査で強制済み**：認証 middleware の割り当ては `apps/web/app/routes/auth-middleware-contract.test.ts`、design token は `scripts/check-design-tokens.mjs` が検査します。
- **人が判断する現行規則**：client code から server-only module を import しません。loader、action、middleware では正規化済みの `url` を使い、生の受信 URL が必要な場合だけ `request.url` を使います。hydration 前後で DOM 構造を変える場合は hydration gate を設けます。CLI が呼ぶ API route では Bearer token 対応 middleware を使います。「表示されないこと」を確認する test では、条件を反転した負の対照も実行します。
- **復元しない事項**：機械検査へ置き換わった token 値や DOM 断片の一覧は復元しません。

## Workers

- **機械検査で強制済み**：request entrypoint と lazy initialization の契約は、`apps/web/workers/app.test.ts` が検査します。
- **人が判断する現行規則**：request 内で生成した promise を isolate lifetime の cache へ保存しません。`apps/web/workers/app.ts` の `anchorAuthInit` と `anchorServerBuild`、認証処理の hang recovery を維持します。中断された request の promise を isolate 全体で再利用すると、未解決状態が後続 request に引き継がれるためです。
- **復元しない事項**：公開範囲外の運用設定は復元しません。

## i18n

- **機械検査で強制済み**：翻訳の利用箇所で指定する key は、`apps/web/app/i18n/messages.ts` が型検査します。
- **人が判断する現行規則**：`apps/web/app/i18n/en.json` と `apps/web/app/i18n/ja.json` の key、意味、placeholder を揃えます。日本語 UI に内部語彙や英語動詞をそのまま出さず、toast と error message に literal backtick を入れません。同じ画面内では文体を統一します。
- **復元しない事項**：現行実装に該当がない locale の運用規則は復元しません。

## Legal

- **機械検査で強制済み**：legal markdown の公開 surface は、`apps/web/app/services/legal-content.server.ts` の test と build が検査します。
- **人が判断する現行規則**：`apps/web/app/legal/` の日英文書を対で確認します。利用者向け価格表示を変える場合は、legal 文書と `apps/web/app/i18n/en.json`、`apps/web/app/i18n/ja.json` の `billing.*` 表示を同じ変更で揃えます。
- **復元しない事項**：公開範囲外の契約情報は復元しません。

## Updates

- **機械検査で強制済み**：filename、frontmatter、language pair、visibility の契約は、`apps/web/app/services/updates-content.server.test.ts` と `apps/web/app/services/updates-visibility.server.test.ts` が検査します。
- **人が判断する現行規則**：本文には、一般化した利用状況、解消する問題、利用者に起きる変化を残します。外部へ出せない文脈は書きません。形式の詳細は parser と test を正本とし、ここへ複製しません。
- **復元しない事項**：機械検査へ置き換わった frontmatter の全項目一覧は復元しません。

## CLI

- **機械検査で強制済み**：release tag、version、changelog は `scripts/check-cli-changelog.mjs`、command surface は `apps/web/app/lib/cli-capability-matrix.json` と `scripts/generate-cli-reference.mjs` が検査します。
- **人が判断する現行規則**：command、option、JSON、認証の契約を変える場合は、capability matrix、help、reference、同梱 skill を同じ変更で整合させます。token store を通る test は OS の credential store から隔離します。引数処理を変える場合は、`packages/cli/src/args.ts` の Gunshi 正規化と空値の扱いを確認します。
- **復元しない事項**：公開範囲外の release 操作は復元しません。
