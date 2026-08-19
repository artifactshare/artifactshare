# glossary — 製品語彙の用語集

製品語彙の単一の正本。UI 文字列 (`apps/web/app/i18n/ja.json` / `en.json`)、公開ページ、法的文書、ガイド、メールの文言は、この表の表示語に従う。

機械検査 `check:copy-glossary` は「使わない語」列を deny list として、UI JSON、法的文書、ガイド、Updates、明示した TypeScript 公開コピーを走査する。無印は全検査面、`en:` は英語 locale の全検査面、`ui:` は UI JSON だけに適用する。`ui:` は公開散文で別概念として正当に使われる語に限る。例外は key 単位の allowlist で管理し、検査スクリプト側に置く。

## 製品の一文

製品を一言で説明する文。viewer の製品紹介 (`vw.productSummary`)、About の冒頭、meta description (`about.meta.description`) はこの一文を単一ソースとして使い、独自の言い換えを作らない。

- 日本語: **HTML ファイルを、社内で安全に共有するサービスです。**
- 英語: **A service for sharing HTML files safely within your company.**

「HTML ファイル」は最初の一歩を指す代表であり、Markdown、フォルダ、静的サイトへの対応を否定しない。補足するときは一文の後ろに足し、一文そのものを膨らませない。

## 用語表

1 概念 1 行。「使わない語」は同じ概念を指す揺れであり、UI と公開文書に書かない。コード識別子、データモデル名、URL、開発文書はこの表の対象外。

### 製品と対象物

| 概念 | 日本語表示語 | 英語表示語 | コード識別子 | 使わない語 |
|---|---|---|---|---|
| 製品の自称 | サービス | service | — | ui:ツール、プラットフォーム、ui:場所、ui:アプリ |
| 共有する対象物 | ファイル | file | `shareable`, `artifact` | 成果物、アーティファクト、ドキュメント、en:artifact、en:artifacts |
| 対象物の更新単位 | 版 | version | `versions` | バージョン |
| 共有のための URL | 共有リンク | share link | `shareUrl` | 共有 URL、公開リンク |
| 共有リンクを開いた閲覧画面 | 共有ページ | shared page | viewer | ビューア、閲覧ページ |
| 版を重ねる行為の言い回し | 同じ URL で次の版へ更新する | update to the next version at the same URL | — | 差し替える、再アップロード |

「ファイル」の例外は、プロダクト名 `Artifact Share` と、仕様上の概念説明で `artifact` を使う場合に限る。

### 行為

| 概念 | 日本語表示語 | 英語表示語 | コード識別子 | 使わない語 |
|---|---|---|---|---|
| ファイルを共有まで持ち込む行為の総称 | 投稿 | post | — | ui:公開、ui:登録 |
| ブラウザからファイルを送る操作 | アップロード | upload | `upload` | — |
| 認証してアカウントに入る操作 | ログイン | sign in | `sign-in` | サインイン、ログオン |
| 製品を使い始めること (ページ名・概念) | 利用開始 | get started | `/start` | 導入、ui:セットアップ |
| 使い始めを促す行動ボタン | 無料で始める | Start for free | — | 今すぐ登録、申し込む |
| 内容の該当箇所への反応 | コメント | comment | `comments` | フィードバック、注釈 |
| 閲覧された回数 | 閲覧数 | views | `viewCount` | ビュー数、表示回数 |

「投稿」は CLI、MCP、ブラウザに共通の総称。「アップロード」はブラウザ経路の操作名としてだけ使い、行為の総称にしない。

### 共有範囲と所属

| 概念 | 日本語表示語 | 英語表示語 | コード識別子 | 使わない語 |
|---|---|---|---|---|
| ファイルやプロジェクトの見える範囲 | 共有範囲 | who can view | `visibility`, `shareScope` | 公開範囲、アクセス権、en:Sharing scope、en:Company-wide、en:Project audience、en:Add audience、en:Current audience |
| 所有者と個別共有の相手だけへ見せる区分 | 個別共有 | specific people | `visibility = 'private'` | プライベート、限定共有 |
| ワークスペースのメンバー全員へ見せる区分 | 社内全員 | everyone at {domain} | `workspace` | 全社公開、社内公開 |
| プロジェクトの関係者だけへ見せる区分 | 関係者のみ | project members | `base_visibility = 'private'` | メンバー限定 |
| ファイルが所属プロジェクトの共有範囲に従う区分 | プロジェクトの関係者 | project members | `visibility = 'project'` | — |
| 一覧でファイルの共有範囲を識別するチップ | 個別共有、プロジェクト、社内全員、リンク共有 | Specific, Project, Company, Link sharing | `shortVisibilityLabelKey` | — |
| 一覧でプロジェクト自体の共有範囲を識別するチップ | プロジェクト、社内全員 | Project, Company | `ProjectScopeChip` | — |
| プロジェクトで継続的にファイルを見られる人 | プロジェクトの関係者 | project members | `projectShareDefaults` | ui:参加者、ui:メンバー |
| プロジェクトの動きを購読する所属 | 参加 | join | `project_members` | フォロー、購読 |
| 参加している状態・節 | 参加中 | Joined | `joined` | 参加済み |
| 参加できるプロジェクトの節 | 参加できるプロジェクト | Projects you can join | — | 未参加プロジェクト |
| 参加の操作 | 参加する / 参加をやめる | Join / Leave project | `join-project`, `leave-project` | 脱退、退出 |
| 参加中プロジェクトの未読ファイル数 | 新着 {n} | {n} new | `newCount` (99 超は 99+) | 未読 {n} |
| プロジェクトの参加者数表示 | {n} 人が参加 | {n} joined | `countProjectParticipants` | — |
| ファイルごとに 1 件ずつ足す共有 | 個別共有 | specific people | `shareable_grants` | 個別招待 |
| 同じワークスペースに属する人 | 社内 | internal | `internal` | 組織内、テナント内 |
| 同じワークスペースに属さない人 | 社外 | external | `external` | ゲスト、部外者 |
| 利用の単位となる組織 | ワークスペース | workspace | `workspace` | チーム、組織 |
| ファイルをまとめる単位 | プロジェクト | project | `artifact_containers` | ui:フォルダ、コレクション |
| メンバーをワークスペースの所属から外す操作 | 削除 | remove | `removeWorkspaceMember` | 除名、除外、ui:外す |
| 閲覧した人（このファイルを開いたことのある社内 active member、または個別共有・共有プロジェクトのログイン済み human。外部受信者同士にも表示。社内 active member は共有範囲を狭めた後も残る） | 閲覧した人 | Who viewed | `viewerList` | — |
| 閲覧した人における社外（対象 workspace の active member ではない行。owner header の domain 判定とは異なる） | 社外 | External | `isExternal` | ゲスト、部外者 |

メンバーの「削除」がデータ削除と誤読されないよう、確認ダイアログで「アクセスできなくなる」「ファイルとコメントは残る」を必ず補足する。

### 動きのフィード

| 概念 | 日本語表示語 | 英語表示語 | コード識別子 | 使わない語 |
|---|---|---|---|---|
| 閲覧・コメント・版更新の時系列の面 | 最近の動き | Recent activity | `events`, `feed` | ui:タイムライン、ui:フィード |
| 認証済み閲覧の集約表現 | ◯人に閲覧されました | Viewed by N people | `viewUniqueCount` | — |
| 日次ダイジェストの閲覧表示（匿名のみを除く） | あなたのファイル M 件が N 人に閲覧されました | M of your files viewed by N people | `viewedFileCount`, `viewUniqueCount` | — |
| 匿名閲覧の集約表現 | リンク経由で◯回閲覧されました | Viewed N times via link | `anonymousViewCount` | — |
| 日次ダイジェストの匿名のみ表示 | あなたのファイル M 件がリンク経由で N 回閲覧されました | M of your files viewed N times via link | `viewedFileCount`, `anonymousViewCount` | — |
| 日次ダイジェストの上位表示 | 上位: | Top: | `viewTopItems` | — |
| actor を解決できない場合の表示 | 不明なユーザー | Unknown user | — | 退会したユーザー |

フィードの「◯人に閲覧されました」(`viewUniqueCount`: 日別集計・90 日のイベント窓・owner 除外) と、閲覧した人の人数 (全期間・owner 含む) は定義が異なり、同じファイルで数が一致しないことがある。
閲覧した人には未ログイン閲覧とリンクだけで開いた人を含めないため、閲覧回数とも母集団が異なる。
`Everyone in this workspace` は domain を取得できない表示面の fallback として使う。
「関係者」(閲覧できる人) と「参加」(動きを購読する所属) は別概念で同一画面に並ぶ。閲覧権の文脈にだけ「関係者」、購読の文脈にだけ「参加」を使い、混ぜない。

## 運用

- 語を追加・変更するときは、この表を先に更新し、同じ変更で UI 文字列を表に揃える。表にない新概念を UI に出す前に、ここへ 1 行足す。
- 「使わない語」列は `check:copy-glossary` が自動で読む。無印、`en:`、`ui:` の適用面を選び、列に語を足せば次の検査からその語の混入が fail になる。
- レビューで同じ語の揺れが 2 回指摘されたら、その語をこの表に足して機械検査へ昇格させる ([design-system.md](./design-system.md) の昇格ループ)。
- 例外 (製品名、意図的に固定した文言) は検査スクリプトの allowlist に key 単位で登録し、この文書には書かない。
