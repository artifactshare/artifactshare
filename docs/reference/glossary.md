# glossary — 製品語彙の用語集

Artifact Share で使う言葉の基準をまとめた用語集です。画面の文言（`apps/web/app/i18n/ja.json` / `en.json`）、公開ページ、法務文書、ガイド、メールの表記は、この表の表示語にそろえます。

lint の `copy-glossary/no-violations` ルールは、表の「使わない語」列を禁止語のリストとして読み込み、画面の文言の JSON、法務文書、ガイド、Updates、公開ページ用の TypeScript ファイルを検査します。接頭辞なしはすべての対象、`en:` は英語版のすべての対象、`ui:` は画面の文言の JSON だけに適用します。`ui:` は、公開文書の中で別の概念として正しく使う語にだけ付けます。例外は、lint プラグイン側でキー単位の許可リスト（allowlist）に登録します。

## 製品の一文

Artifact Share を一言で表す文です。共有ページの製品紹介（`vw.productSummary`）、About の冒頭、meta description（`about.meta.description`）では、独自の言い換えを作らず、この一文をそのまま使います。

- 日本語: **HTML ファイルを社内で安全に共有できるサービスです。**
- 英語: **A service for sharing HTML files safely within your company.**

「HTML ファイル」は最初の一歩を示す代表例で、Markdown、フォルダ、静的サイトへの対応を否定するものではありません。補足が必要なときは一文の後ろに足し、一文そのものは膨らませません。

## 用語表

1 つの概念につき 1 行で定義します。「使わない語」は同じ概念を指す表記ゆれで、画面の文言と公開文書には使いません。コード上の識別子、データモデル名、URL、開発者向けの文書は、この表の対象外です。

### 製品と対象物

| 概念 | 日本語表示語 | 英語表示語 | コード識別子 | 使わない語 |
|---|---|---|---|---|
| 残すバージョン数 | 残すバージョン数 | Version retention | `retain_versions` | リテンション、プルーン、トゥームストーン |
| 製品の自称 | サービス | service | — | ui:ツール、プラットフォーム |
| 共有する対象物 | ファイル | file | `shareable`, `artifact` | 成果物、アーティファクト、ドキュメント、en:artifact、en:artifacts |
| 対象物の更新単位 | バージョン | version | `versions` | — |
| 共有のための URL | 共有リンク | share link | `shareUrl` | 共有 URL、公開リンク |
| 共有リンクを開いた閲覧画面 | 共有ページ | shared page | viewer | ビューア、閲覧ページ |
| バージョンを重ねる行為の言い回し | 同じ URL のまま更新する | update to the next version at the same URL | — | 差し替える、再アップロード |

「ファイル」の例外は、サービス名の `Artifact Share` と、仕様上の概念を説明する場面で `artifact` を使う場合だけです。

### 行為

| 概念 | 日本語表示語 | 英語表示語 | コード識別子 | 使わない語 |
|---|---|---|---|---|
| ファイルを共有まで持ち込む行為の総称 | 投稿 | post | — | ui:公開、ui:登録 |
| ブラウザからファイルを送る操作 | アップロード | upload | `upload` | — |
| 認証してアカウントに入る操作 | ログイン | sign in | `sign-in` | サインイン、ログオン |
| 製品を使い始めること（ページ名・概念） | 始め方 | get started | `/start` | 導入、ui:利用開始、ui:セットアップ |
| 使い始めを促す行動ボタン | 無料で始める | Start for free | — | 今すぐ登録 |
| 内容の該当箇所への反応 | コメント | comment | `comments` | フィードバック、注釈 |
| 前回の閲覧境界より後に他の投稿者が書いたコメント | 新着 | New | `comments.new` | — |
| 閲覧された回数 | 閲覧数 | views | `viewCount` | ビュー数、表示回数 |

「投稿」は CLI、MCP、ブラウザに共通する総称です。「アップロード」はブラウザからファイルを送る操作の名前としてだけ使い、投稿全体の総称にはしません。
閲覧数には所有者本人の閲覧も含まれます。共有相手が開いたことを示す数としては扱いません。

### 共有範囲と所属

| 概念 | 日本語表示語 | 英語表示語 | コード識別子 | 使わない語 |
|---|---|---|---|---|
| ファイルやプロジェクトの見える範囲 | 共有範囲 | who can view | `visibility`, `shareScope` | 公開範囲、アクセス権、en:Sharing scope、en:Company-wide、en:Project audience、en:Add audience、en:Current audience |
| 所有者と個別共有の相手だけへ見せる区分 | 個別共有 | specific people | `visibility = 'private'` | プライベート、限定共有 |
| ワークスペースのメンバー全員へ見せる区分 | 社内全員 | everyone at {domain} | `workspace` | 全社公開、社内公開 |
| プロジェクトの関係者だけへ見せる区分 | 関係者のみ | project members | `base_visibility = 'private'` | メンバー限定 |
| ファイルが所属プロジェクトの共有範囲に従う区分 | プロジェクトの関係者 | project members | `visibility = 'project'` | — |
| 一覧でファイルの共有範囲を識別するチップ | 個別共有、プロジェクト、社内全員、リンク共有 | Specific, Project, Company, Link sharing | `shortVisibilityLabelKey` | — |
| 運営がリンク共有を一時停止したファイルの viewer チップ | リンク共有 · 一時停止中 | Link sharing · Paused | `vw.linkSharingPaused` | — |
| 一覧でプロジェクト自体の共有範囲を識別するチップ | プロジェクト、社内全員 | Project, Company | `ProjectScopeChip` | — |
| プロジェクトで継続的にファイルを見られる人 | プロジェクトの関係者 | project members | `projectShareDefaults` | ui:参加者 |
| プロジェクトの動きを購読する所属 | 参加 | join | `project_members` | フォロー、購読 |
| 参加している状態・節 | 参加中 | Joined | `joined` | 参加済み |
| 参加できるプロジェクトの節 | 参加できるプロジェクト | Projects you can join | — | 未参加プロジェクト |
| 参加の操作 | 参加する / 参加をやめる | Join / Leave project | `join-project`, `leave-project` | 脱退、退出 |
| 参加中プロジェクトの未読ファイル数 | 新着 {n} | {n} new | `newCount` (99 超は 99+) | 未読 {n} |
| プロジェクトの参加者数表示 | {n} 人が参加 | {n} joined | `countProjectParticipants` | — |
| ファイルごとに 1 件ずつ足す共有 | 個別共有 | specific people | `shareable_grants` | 個別招待 |
| 同じワークスペースに属する人 | 社内 | internal | `internal` | 組織内、テナント内 |
| 同じワークスペースに属さない人 | 社外 | external | `external` | ゲスト、部外者 |
| 利用の単位となる組織 | ワークスペース | workspace | `workspace` | 組織 |
| ファイルをまとめる単位 | プロジェクト | project | `artifact_containers` | ui:フォルダ、コレクション |
| メンバーをワークスペースの所属から外す操作 | 削除 | remove | `removeWorkspaceMember` | 除名、除外、ui:外す |
| 閲覧した人（このファイルを開いたことのある社内 active member、または個別共有・共有プロジェクトのログイン済み human。外部受信者同士にも表示。社内 active member は共有範囲を狭めた後も残る） | 閲覧した人 | Who viewed | `viewerList` | — |
| 閲覧した人における社外（対象 workspace の active member ではない行。owner header の domain 判定とは異なる） | 社外 | External | `isExternal` | ゲスト、部外者 |

メンバーの「削除」がデータの削除と誤解されないよう、確認ダイアログでは「このワークスペースにアクセスできなくなること」と「投稿したファイルとコメントは残ること」を必ず補足します。

### 動きのフィード

| 概念 | 日本語表示語 | 英語表示語 | コード識別子 | 使わない語 |
|---|---|---|---|---|
| 閲覧・コメント・バージョン更新の時系列の面 | 最近の動き | Recent activity | `events`, `feed` | ui:タイムライン、ui:フィード |
| 認証済み閲覧の集約表現 | ◯ 人に閲覧されました | Viewed by N people | `viewUniqueCount` | — |
| 日次ダイジェストの閲覧表示（匿名のみを除く） | あなたのファイル M 件が N 人に閲覧されました | M of your files viewed by N people | `viewedFileCount`, `viewUniqueCount` | — |
| 匿名閲覧の集約表現 | リンク経由で ◯ 回閲覧されました | Viewed N times via link | `anonymousViewCount` | — |
| 日次ダイジェストの匿名のみ表示 | あなたのファイル M 件がリンク経由で N 回閲覧されました | M of your files viewed N times via link | `viewedFileCount`, `anonymousViewCount` | — |
| 日次ダイジェストの上位表示 | よく見られたファイル: | Top: | `viewTopItems` | — |
| actor を解決できない場合の表示 | 不明なユーザー | Unknown user | — | 退会したユーザー |

最近の動きに出す「◯ 人に閲覧されました」（`viewUniqueCount`: 日別に集計、直近 90 日のイベント、所有者を除く）と、「閲覧した人」の人数（全期間、所有者を含む）は数え方が異なるため、同じファイルでも数が一致しないことがあります。
「閲覧した人」には未ログインの閲覧とリンクだけで開いた人を含めないため、閲覧数とも数える対象が異なります。
英語版の `Everyone in this workspace` は、ドメインを取得できない画面での代わりの表記として使います。
「関係者」（閲覧できる人）と「参加」（動きを受け取るための所属）は別の概念で、同じ画面に並びます。閲覧できるかどうかの話には「関係者」、動きを受け取る所属の話には「参加」だけを使い、混ぜません。

## 運用

- 語を追加・変更するときは、先にこの表を更新し、同じ変更の中で画面の文言を表にそろえます。表にない新しい概念を画面に出す前に、ここへ 1 行足します。
- 「使わない語」列は、lint の `copy-glossary/no-violations` ルールが自動で読み込みます。適用範囲（接頭辞なし、`en:`、`ui:`）を選んで列に語を足すと、次の lint からその語が混じったときにエラーになります。
- レビューで同じ語の揺れが 2 回指摘されたら、その語をこの表に足して自動検査に移します（[design-system.md](./design-system.md) の昇格ループ）。
- 製品名や、意図して固定した文言などの例外は、この文書には書かず、lint プラグインの許可リストにキー単位で登録します。
