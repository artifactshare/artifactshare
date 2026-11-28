# 公開製品開発の現行制約

公開リポジトリで製品コードを変更するときに参照する判断基準です。
領域ごとに「機械検査で強制済み」「人が判断する現行規則」「復元しない事項」を分けて整理しています。

## Analytics

- **機械検査で強制済み**: `apps/web/app/lib/analytics/events.ts` でイベント名、イベントごとのパラメーターキー、カスタムディメンションの対応を閉じた型で定義しています。lint は、許可された送信経路以外からの `gtag` と `dataLayer.push` 呼び出しを拒否します。
- **人が判断する現行規則**: 利用者の行動に関わる変更では計測への影響を確かめ、`apps/web/app/lib/analytics/events.ts` の定義と全送信経路を同じ変更でそろえます。管理設定を変えるスクリプトがリポジトリ内にある場合は、そのスクリプトも同じ PR で更新します。
- **復元しない事項**: 現行実装に該当がない分析基盤の手順は復元しません。

## 依存管理

- **機械検査で強制済み**: CI の frozen install と `scripts/workflow-policy.test.mjs` が lockfile との一致を検査します。
- **人が判断する現行規則**: `pnpm-workspace.yaml` の `minimumReleaseAgeExclude` を編集するときは、除外する理由を確認します。依存関係を変更したら lockfile を再生成し、`pnpm install --frozen-lockfile` で再現できることを確かめます。
- **復元しない事項**: 現行実装に該当がないビルドシステム固有の規則は復元しません。

## D1 と SQLite

- **機械検査で強制済み**:
  - スキーマとマイグレーションの整合は `apps/web/check-schema.mjs`、危険なマイグレーション操作と新しい `PRAGMA foreign_keys` 設定は `apps/web/check-migrations.mjs` が検査します。スキーマの基準ファイルは `apps/web/db/schema.sql` です。
  - Kysely プラグインは、クエリビルダーが組み立てた最終の `OperationNode` を実行・コンパイル前に検査し、変数や配列を経由した場合も含めて 6 項以上の compound SELECT と 101 個以上のバインドパラメーターを拒否します。このプラグインは本番 D1 接続とテスト用 SQLite 接続の両方に入れます。
  - `scripts/check-d1-compatibility.mjs` は、本番コードの Kysely 接続にこのプラグインが組み込まれていることを強制し、同じ式に直接書かれた生 SQL・カスタムコンパイル・D1 `prepare`・`join` を AST で検査します（データフローは追わず、クエリビルダーの組み立ては実行時プラグインが検査します）。制限内の compound SELECT は `EXISTS` や raw interpolation を含めて許可されます。
  - 利用者入力による部分一致検索では、50 バイトのパターン上限がある `LIKE`/`GLOB` ではなく `instr()` を使い、入力全文の意味を保ちます。
  - Wrangler Test Harness の D1 スイートは、既存の Wrangler 設定から全マイグレーションを適用し、D1 固有の SQL 境界とデータ入りテーブルの再構築を CI で検証します。
- **人が判断する現行規則**:
  - TypeScript の型より先に、スキーマとマイグレーションの `CHECK`・`UNIQUE`・外部キー制約を確認します。マイグレーション番号は作成時点の `main` の最新番号に続け、`UNIQUE` 列へ重複インデックスを作りません。
  - 既存行をバックフィルするマイグレーションでは、移行時点の値（`now` やその時点の権限・名前）ではなく、元データから導ける値を書き込みます。元データから導けない値は、列が NULL を許すなら NULL のまま欠測として扱います。
  - D1 と SQLite の差異が絡む変更では、constraint error の `cause` 確認と再照会を組み合わせます。メールアドレスの照合には `apps/web/app/lib/grant-emails.server.ts` の `lowerEmail` を使います。D1 とテスト用 SQLite では制約の効き方が異なるため、型検査や SQLite テストが通っただけで互換性を断定しません。
- **復元しない事項**: 公開範囲外の運用手順は復元しません。

## React Router と Web UI

- **機械検査で強制済み**: 認証ミドルウェアの割り当ては `apps/web/app/routes/auth-middleware-contract.test.ts`、デザイントークンは `scripts/check-design-tokens.mjs` が検査します。
- **人が判断する現行規則**:
  - クライアントコードからサーバー専用モジュールを import しません。loader・action・middleware では正規化済みの `url` を使い、生の受信 URL が本当に必要なときだけ `request.url` を使います。
  - hydration 前後で DOM 構造が変わる場合は hydration gate を置きます。CLI が呼ぶ API ルートには Bearer トークン対応ミドルウェアを付けます。
  - 「表示されないこと」を確かめるテストでは、条件を反転した負の対照も実行します。
  - fake timers 下では `Response` の `text()`・`json()`・`arrayBuffer()` が microtask だけで完了すると前提にしません。本文の読み取りに実タスクが必要なことがあるため、`apps/web/app/test/wait-for-real-task-condition.ts` の共通ヘルパーで観測可能な結果を待ちます。
  - `act` の外で render した後は、操作対象の要素が存在するまで待つか、`apps/web/app/test/browser-layout.ts` を使ってから操作します。query で取得した要素の `click()`・`focus()`・`dispatchEvent()` は optional chaining で呼び出してはいけません。
- **復元しない事項**: 機械検査へ置き換わったトークン値や DOM 断片の一覧は復元しません。

## Tests

ブラウザ待機、機能判定、lint の適用範囲は [Browser test waits](../../apps/web/app/test/browser-test-waits.md) を参照してください。

- **機械検査で強制済み**: Public CI の `changed-browser-repetitions` ジョブ（チェック名 `Changed browser behavior repetitions`）と `Flaky detector` ワークフロー（`.github/workflows/flaky-detector.yml`）が、反復実行によって不安定なテストを検出します。
- **機械検査で強制済み**: PR、マージキュー、ローカルの `pnpm test:behavior-browser` は Chromium と WebKit だけでブラウザテストを回します。Firefox は毎晩の `Flaky detector` だけで回します（`scripts/public-ci-contract.test.mjs`）。Firefox で確かめたいときは `pnpm test:behavior-browser --project=firefox` を使います。
- **人が判断する現行規則**:
  - sheet や dialog の開閉後にフォーカスや開閉状態を検証するときは、マウント・アンマウントとアニメーション完了を待ちます。固定時間の `sleep` は使わず、`[data-slot="sheet-content"]` の出現・消失など観測可能な条件で待ちます。
  - `vi.waitFor` で重い処理（大きな文書、多数のコメント、マイグレーションを再適用する D1 リセット）や既定の 1 秒を超え得る条件を待つ場合は、CI ランナーがローカルの約 2 倍かかることを見込んで明示的な timeout を指定します（短時間で終わる条件は既定値のままで構いません）。重いフィクスチャを使うテストにも同様に明示的な timeout を設定します。D1 スイートのテストとフックの timeout は `apps/web/app/test/vitest.d1.config.ts` を参照します。
  - サブピクセルのレイアウト値は、根拠を明記した許容誤差で比較します。一時ディレクトリはテストごとに固有のものを使います。
  - ブラウザテストでは、まず iframe 自体にフォーカスを当ててから内部要素へフォーカスを移します（Firefox ではフレームの browsing context にフォーカスがないと、内部要素で `focus()` を呼んでも `<body>` にフォーカスが残ることがあるためです）。
- **復元しない事項**: 現行実装に該当がないテスト手順は復元しません。

## Workers

- **機械検査で強制済み**: リクエストのエントリポイントと遅延初期化の契約は、`apps/web/workers/app.test.ts` が検査します。
- **人が判断する現行規則**: リクエスト内で作った Promise を、isolate の生存期間にわたるキャッシュへ保存しません。`apps/web/workers/app.ts` の `anchorAuthInit`・`anchorServerBuild` と、認証処理のハング復旧を維持します。途中で中断されたリクエストの Promise を isolate 全体で使い回すと、未解決状態が後続のリクエストへ引き継がれてしまうためです。
- **復元しない事項**: 公開範囲外の運用設定は復元しません。

## i18n

- **機械検査で強制済み**: 翻訳の呼び出し箇所で指定するキーは、`apps/web/app/i18n/messages.ts` が型検査します。`apps/web/app/i18n/catalog-parity.test.ts` は、en.json と ja.json でキーがそろっていること、キーごとのプレースホルダーがそろっていること、en に文があるキーには ja にも文があることを検査します。`tPlural` が連結して作る `One` と `Other` のキーも、同じ検査の対象です。
- **人が判断する現行規則**: `apps/web/app/i18n/en.json` と `apps/web/app/i18n/ja.json` で意味をそろえます。日本語 UI に内部用語や英語動詞をそのまま出さず、トーストやエラーメッセージに literal backtick を入れません。同じ画面内では文体を統一します。
- **復元しない事項**: 現行実装に該当がない locale 運用規則は復元しません。

## プラン

- **機械検査で強制済み**: `scripts/plan-tier-lint-plugin.mjs` は、課金・料金表示以外のアプリコードで plan を有料プランの名前（`plus`・`team`）と比べることを、TS・SQL・Kysely の `where` のいずれでも拒否します。機能の判定は `apps/web/app/lib/plan-tier.ts` の `planTier`・`isPaidPlan` と、SQL では `apps/web/app/lib/plan-tier-sql.server.ts` の `planInTierSql` を使います。`free` との比較は、新しい有料プランでもそのまま正しいので許可します。
- **人が判断する現行規則**: プランを足すときは、`PLAN_TIERS` に 1 行足して、どの tier（`free`・`individual`・`team`）の機能を持つかを決めます。tier の意味を変えるときは、`planTier` と `planInTierSql` の呼び出し元をすべて確かめます。
- **復元しない事項**: なし。

## Legal

- **機械検査で強制済み**: 法務 Markdown の公開範囲は、`apps/web/app/services/legal-content.server.ts` のテストとビルドが検査します。
- **人が判断する現行規則**: `apps/web/app/legal/` の日英文書は必ず対で確認します。利用者向けの価格表示を変えるときは、法務文書と `apps/web/app/i18n/en.json`・`apps/web/app/i18n/ja.json` の `billing.*` 表示を同じ変更でそろえます。
- **復元しない事項**: 公開範囲外の契約情報は復元しません。

## Updates

- **機械検査で強制済み**: ファイル名、frontmatter、language pair、公開設定の契約は、`apps/web/app/services/updates-content.server.test.ts` と `apps/web/app/services/updates-visibility.server.test.ts` が検査します。
- **人が判断する現行規則**: 本文には、一般化した利用場面、解消する課題、利用者に起きる変化を書きます。外部へ出せない内部文脈は書かず、形式の詳細はパーサーとテストに任せてここへ重複記載しません。
- **復元しない事項**: 機械検査へ置き換わった frontmatter 全項目の一覧は復元しません。

## CLI

- **機械検査で強制済み**: リリースタグ、バージョン、changelog は `scripts/check-cli-changelog.mjs`、コマンドと API の公開仕様は `packages/contract/generate-surfaces.mjs` が `packages/contract` の共有契約から生成・検査します。生成済みの capability matrix は `apps/web/app/lib/cli-capability-matrix.json` に置きます。
- **人が判断する現行規則**: コマンド、オプション、JSON 出力、認証の契約を変えるときは、capability matrix・help・リファレンス・同梱スキルを同じ変更でそろえます。トークン保存先を通るテストは OS の credential store から隔離します。引数処理を変えるときは、`packages/cli/src/args.ts` における Gunshi の正規化と空値の扱いを確認します。
- **復元しない事項**: 公開範囲外のリリース操作は復元しません。
