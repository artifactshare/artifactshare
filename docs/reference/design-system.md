# Artifact Share — Design System

> **値の正本**: `apps/web/app/styles/theme.css` の `@theme` / `apps/web/app/styles/tokens.css` (light / dark とも) と各部品コード
> **部品一覧の正本**: `apps/web/app/components/catalog.ts` (何があり・いつ使い・どの variant を持ち・公式から何が違うか)
> ステータス: 現行仕様 v0.28 (unreleased)

この文書はデザインシステムの**語彙と意図**を定める。なぜこのスケールなのか、どの部品をいつ使い、何を避けるかを確定する。
値 (色・余白・角丸・動き 等) は文書に規範表として持たない。値の正本は `@theme` と部品コードにあり、文書が値を二重に持つと実装と乖離するため、文書からは正本性を外す。
部品の一覧・variant・公式差分は `apps/web/app/components/catalog.ts` を正本とする。

## 公開面フッター

`PublicFooter` は公開面で共有するフッター。ページ名の一覧ではなく、次の 2 ルールで決める。

1. **公開面の画面には必ずフッターを出す。** 利用者に 1 つの判断をさせる集中フロー (サインイン、デバイスコード承認、招待モードのランディング) は `minimal` (規約 3 リンク + 下段)、それ以外の公開ページは `full` (ブランド + プロダクト導線 + 規約列 + 下段)。ログイン後のアプリ画面と `/dev/*`、`/a/:id` 未認証ゲートは対象外。
2. **フッターの内容幅はサイト共通の 1 値 (`max-w-guide-shell-max`)。** ページの本文幅 (法務ページの prose 幅など) には追従しない。帯自体は常に画面全幅で、上辺 hairline がページを締める。
3. **本文とフッターの境界余白は本文シェルが所有する。** 公開ページと集中フローでは、フッター直前の本文シェル要素が境界余白を所有する。共有シェルを複数の文脈で使い、文脈ごとに境界余白が変わる場合だけ、文脈を知る呼び出し側が指定する。全文脈が同じ余白でよければシェル部品が既定として持つ。`PublicFooter` は外側余白を所有しない。

下段は著作権表示 `© {year} Artifact Share`、言語切替、テーマ切替 (system / light / dark のドロップダウン) で構成する。言語切替は `/ja` ルート対のあるページ (`public-pages.json` 判定) だけに表示し、存在しない locale パスへのリンクを作らない。

UI 実装時は、次の順で参照する。

1. `docs/reference/design-system.md`: 語彙と意図。色・余白・部品の意味、いつ何を使うか、文言、避ける表現。
2. `apps/web/app/components/catalog.ts`: どの部品があり、どの variant を持ち、公式から何が違うか。
3. `apps/web/app/styles/theme.css` (`@theme`) / `apps/web/app/styles/tokens.css`: 実装で使うトークン値の正本。
4. 既存 React component と近接の `*-styles.ts`: 共通スタイルの正本。挙動、状態、アクセシビリティ、細部の DOM 構造、寸法もここが正本。
5. UI 付き spec の静的モックを作る場合は、画面構成と状態遷移を spec 内で自己完結させる。

新しい UI 部品・状態・文言・操作パターンを追加または変更した場合は、この文書 (語彙・意図) と `catalog.ts` (部品一覧) を更新するか、既存規範だけで説明できるため更新不要だと PR 本文で説明する。
見た目の視覚参照は dev 専用の `/dev/gallery` (実部品を直接描画) を使う。静的 HTML の視覚参照 (`docs/mockups/`) は廃止した。

---

## 1. 哲学

認証方法をまだ選んでいない集中フローは provider-first とし、明示的なメール選択または `account_not_linked` は email-first とする。

UX Bar の「原則」にある「驚かせない」「速く感じさせる」「成果物を主役にする」を視覚言語に翻訳:

- **既存オフィスツールの期待を借りる**: file / 共有 / アクセス / オーナーの語彙は、Google Drive や Notion の利用者が迷わない範囲で使う。
- **Notion-warm**: 純白・純黒は使わない。warm-black を中心に半透明で濃淡を作る。
- **装飾を引く**: shadow は 3 段だけ。border はすべて hairline。tab や folder を再発明しない。
- **動きは控えめ**: easing は単一、duration は 3 段。
- **トークン経由のみ**: 生 px / 生 hex は実装に書かない。トークン名で参照する。

**ブランドマーク**: coral タイルに白い `as` の独自字形 (recraft 由来) を載せたマーク。機能メタファーは入れず、16px でも coral 面と白い `as` の塊が残ることを最低基準にする。正本は `public/favicon.svg`、生成元 `docs/brand/icon.svg` を `docs/brand/build.sh` (rsvg-convert) で各サイズ PNG と favicon.ico に書き出す。UI 内は `BrandMark` (`components/app/brand-mark.tsx`) だけを使い、文脈に応じて 16px (共通 topbar・viewer error・guide・auth・viewer 折りたたみノブ)、20px (通常 viewer の文字併記)、24px (通常 viewer の記号単独へ切り替わる responsive 表示)、32px (landing / device hero) を使う。brand coral / cream はこのマーク専用の色で、値は `docs/brand/` の生成元に持つ。アバター色の `--avatar-*` とは別系統。

---

## 2. ファイル構成

```
apps/web/app/
├── app.css               # アプリの CSS 入口: body reset, base, theme.css の取り込み
├── styles/
│   ├── theme.css         # dark variant, @theme, @theme inline, light / dark / system 値 (トークン値の正本)
│   ├── tokens.css        # design tokens (light :root ＋ dark)
│   ├── landing.css       # トップページ LP 専用トークン (製品 UI からは参照しない)
│   └── view-transitions.css  # ドキュメント級グローバル CSS (view transitions)
├── components/
│   ├── catalog.ts        # 部品カタログ (一覧・variant・公式差分の正本)
│   ├── ui/               # 汎用 UI primitives (shadcn 系)
│   ├── form/             # フォーム複合部品 (§11.12、スタイル同居)
│   ├── layout/           # 一方向レイアウト primitive (Stack / Inline)
│   └── app/              # Artifact Share 固有の部品
├── viewers/
│   ├── shared/           # 両ビューア共通: アプリの言語・テーマを親フレームから受け取る
│   ├── pdf/              # sandbox iframe 内で動く PDF ビューア (React + viewer.css)
│   └── video/            # sandbox iframe 内で動く動画プレーヤー (React + viewer.css)
└── i18n/
    ├── en.json
    └── ja.json
```

sandbox iframe 内のビューア (`viewers/pdf/`, `viewers/video/`) は、アプリと同じ `components/ui/` 部品と `styles/theme.css` / `styles/tokens.css` から作り、アプリの言語とテーマは `viewers/shared/` の共通コードで親フレームから受け取る。スタイルシート `viewer.css` は `app.css` を読み込まず、ビューアのソースと使う部品だけを走査して別にビルドする (`app.css` は `viewers/` を走査しない)。両ビューアは同じビルドスクリプト (`apps/web/scripts/build-viewers.mjs`) で作る。生成物 (`apps/web/workers/lib/{pdf,video}-viewer-*.generated.ts`) は `pnpm --filter @artifactshare/web generate:viewers` で作り直し、`check:viewers` (ルートの `typecheck` も) が鮮度を確かめる。ビューアの変更でアプリの CSS が変わらないことは `node apps/web/scripts/check-viewer-app-css.mjs --base <commit>` で、基準コミットとのビルド結果のバイト比較で確かめる。ビューアのスタイルシートも `check:design-tokens` の breakpoint・media query・未定義変数の検査対象で、ホストするライブラリ (pdf.js) の markup を整えるため class セレクタだけは許す。

shadcn/ui の new-york style を**ベースに採用**しつつ、color/spacing/radius を `@theme` のトークンで上書きする。公式からの独自差分は `catalog.ts` の `upstreamDiff` に記録する。

`as-*` 接頭辞はかつてアプリ CSS で使っていたクラス命名で、`components.css` の廃止で定義は消えた。グローバル CSS (`app.css` + `styles/*.css`) の rule prelude に class / id セレクタ (`as-*` を含む) を新規追加すると `check:design-tokens` の `global-css-selector` 検査が弾く。書き出しなどアプリ外で生成・注入するドキュメントの CSS は `as-` を使わず別接頭辞 (`asx-` 等) にする。

ページ全体に必要な挙動は、部品用 class / id ではなく、目的を表す `data-*` 属性をページの `main` に置いてグローバル CSS の条件にできる。ガイドとランディングのスムーズスクロールはこの基準に従い、`prefers-reduced-motion` を尊重する。

---

## 3. Color

値の正本は `styles/theme.css` の semantic 変数とし、`@theme inline` を介して named utility を生成する。ここでは語彙だけ定める。

### 3.1 Surface (background hierarchy)

| Token | 用途 |
|---|---|
| `--background` | ページ全体の面 |
| `--surface-warm` | 弱い warm-white。Viewer body / large surface |
| `--muted` / `--secondary` | panel head / file-icon bg と secondary UI |
| `--card` / `--popover` | カード面と overlay 面。現在値は同じでも役割を分ける |

### 3.2 Text

| Token | 用途 |
|---|---|
| `--foreground` | primary text (warm-black) |
| `--muted-foreground` | secondary (meta / caption) |
| `--faint` | tertiary (placeholder / dot separator) |

通常テキストに使う意味色は、指定値ではなく実際の背景色と合成した後のコントラスト比で判定する。通常背景に対して `--faint` は 4.5:1 以上、`--muted-foreground` は 7:1 以上、`--foreground` はそれ以上の最上位とする。複数の背景で使う色は、`--background`、`--card`、`--muted`、文字を載せる淡色背景を含む実利用背景の最悪値でもこの基準を満たす。下地によって合成色が変わる半透明色は、文字を載せる静的なチップ背景に使わず、`--chip-muted` のような不透明の意味色へ分ける。単一値で階調や色相を保てない場合は、画面別に上書きせず、文字色と淡色背景の意味色を分ける。`--success`、`--warning`、`--destructive`、`--link` など状態・操作を表す文字色も通常テキストとして 4.5:1 以上を満たし、意味と色相の区別を保つ。

> 純黒も、暗背景上の pure white text も使わない。warm-black 一系統で濃淡を作る。

### 3.3 Border / divider

| Token | 用途 |
|---|---|
| `--border` | デフォルト border |
| `--border-strong` | 強調 border (ホバー時、外周) |
| `--divider` | 横方向の薄い divider (topbar bottom 等) |

### 3.4 Hover と muted surface

| Token | 用途 |
|---|---|
| `--accent` | ボタン hover bg |
| `--chip-muted` | muted badge / count badge など、補助文字を載せる不透明の淡色背景 |

### 3.5 Accent (Notion blue)

| Token | 用途 |
|---|---|
| `--link` | link 文字色 / focus ring / info アイコン |
| `--link-hover` | link hover 等 (dark の primary hover を兼ねる) |
| `--link-soft` | selection bg / info 状態 bg |
| `--primary` / `--primary-hover` | primary ボタン。light では白文字の WCAG AA を満たすため `--link` より暗くする |
| `--agent-soft` | AI エージェント名バッジの core palette 外アクセント |

### 3.6 Semantic

| Token | 用途 |
|---|---|
| `--success` / `--success-soft` | 成功 (delta up / toast check) と、その状態 bg |
| `--destructive` | 破壊的操作 (delete / delta down / external denied) |
| `--warning` / `--warning-soft` | 注意を要する状態 (rate limit、link visibility) と、その状態 bg |

### 3.7 Avatar palette (deterministic)

`user.id` (or `google_sub`) を hash して 6 色のうち 1 つを選ぶ。**workspace mark** にも同じ palette を使う。`--avatar-1`〜`--avatar-6` は白いイニシャルと 4.5:1 以上のコントラストを持つ単色で、`tokens.css` に置く。

---

## 4. Typography

### 4.1 Font stack

製品 UI は Geist Variable を英数字の preferred font とし、日本語グリフは Hiragino Sans、Noto Sans JP、Meiryo の順で OS のフォントへ fallback する。日本語ページは `line-break: strict` と `word-break: auto-phrase` を併用し、禁則処理を保ちながら語句単位で改行する。文字幅を変える `palt` などの OpenType feature は全体へ適用しない。表、入力、バッジ、コード、数値表示は同じ stack を継承し、各部品が所有する既存の幅と整列を維持する。emoji は `Apple Color Emoji` / `Segoe UI Emoji` を明示して OS 任せの描画に統一する。値は `app.css` を正本にする。

表示面ごとのフォント指定は、配信方法と生成環境が異なるため完全には統一しない。

| 表示面 | 所有範囲と方針 |
|---|---|
| 製品 UI | `app.css` が Geist Variable、日本語 system fallback、locale 固有の文字組みを所有する。追加の日本語 Web フォントは配信しない (例外は下記のランディング見出しのみ) |
| ランディングの display 表現 | LP の hero / section 見出し、ステップ番号、証言の引用だけ Zen Old Mincho 700 (`@fontsource`、自己ホスト) を使う。本文は製品 UI の stack を継承し、この serif を製品 UI 部品へ持ち込まない。製品ページは mount 後に stylesheet を動的 import し、dev-scenario fixture は撮影の `document.fonts.ready` 待ちが効くよう静的 import する |
| ユーザー文書 | Markdown renderer またはアップロードされた文書自身が font stack と文字組みを所有し、製品 UI の指定を文書内へ注入しない |
| OG 画像 | preview image generator が LINE Seed JP の Japanese / Latin subset、normal 400 / 700 WOFF2 を `@fontsource/line-seed-jp` 5.3.0 から bundle し、Takumiへ`ArrayBuffer`として渡す。配布元は Fontsource の `font-files` repository (`fonts/google/line-seed-jp`)。Font Software は SIL Open Font License 1.1で、package同梱の`LICENSE`を配布物に保持する。runtimeの外部font hostと製品 UI の OS fallbackには依存しない |
| 独立した error / embed surface | 各 surface の自己完結した CSS が所有し、製品 UI bundle の font 読み込みには依存しない |

### 4.2 Type scale

正本は Tailwind 既定スケール。自前のサイズトークンは持たない。例外はランディングで、LP 全体の文字サイズを display の clamp から本文・キャプション・極小メタまで `--lp-text-*` スケールとして `landing.css` に持つ (製品 UI からは参照しない)。

| Utility | 用途 |
|---|---|
| `text-xs` | kbd / caption / pill / meta |
| `text-sm` | body default / button / label / input |
| `text-base` | 記事本文 / hero sub |
| `text-lg` | section heading |
| `text-xl` | page title / empty state |
| `text-2xl` | larger heading |
| `text-3xl` | hero h1 |
| `text-4xl` | pricing / guide h1 |
| `text-5xl` | サインイン表示のブランド名 |

10px 以下の極小表示 (バッジ等) は Tailwind に対応ステップが無いため、生 CSS の `font-size` で例外的に残す。

### 4.3 Font weight

`400` はほぼ使わない (body は `500` を既定にする)。`500` Medium は UI 既定 (button / meta / body)、`600` Semibold は title / emphasis、`700` Bold は display / large heading。

### 4.4 Line height

`--lh-tight` (display) / `--lh-snug` (card title) / `--lh-normal` (body default) / `--lh-loose` (code / pre)。値は `tokens.css`。

---

## 5. Spacing

原始スケール `--spacing-N` は基本 N × 4px の刻み。値の正本は `app.css` の `@theme` で、`p-N` / `gap-N` 等のユーティリティと `var(--spacing-N)` の両方がそこから出る。コード中で `padding: 14px` のような生 px を書かない。トークンに合わない値が必要なら、まずトークンを足すか考える。

### 5.1 用途名 spacing (フォーム / 管理画面)

原始スケールの上に用途名の層を置き、ページ側に「2 か 3 か」を選ばせない。値の正本は `app.css` の `@theme` (減少スケールは HashiCorp Helios のフォームパターン準拠)。

| Token | 用途 | 消費者 |
|---|---|---|
| `--spacing-section` | セクション間 | `SettingsPage` |
| `--spacing-field` | フィールド間 | `SettingsSection` |
| `--spacing-inline` | 横並びグループ内 | `InlineFields` |

これらはフォーム部品 (§11.12) が gap として所有する。ページ (routes) 側で `gap-field` 等を直接書かない。フィールド内部 (label と control の間など) とコントロールの高さは shadcn 部品の既定に従う。

---

## 6. Radius

`--r-sm` (button / kbd / dropdown item) / `--r-md` (card / CTA / palette) / `--r-lg` (empty icon container / large surface) / `--r-xl` (rare) / `--r-full` (avatar)。値は `tokens.css`。

> **これ以上丸めない**。Notion 系は控えめ。Bubble UI 化を避ける。

---

## 7. Shadow

「**hairline ring + soft drop**」の 2 段構え (Notion 流)。`--shadow-sm` (カード at rest) / `--shadow-md` (カード on hover) / `--shadow-lg` (modal / palette / toast)。

> **lift (translateY) と shadow を併用しない**。ring の段階だけで深さを出し、成果物を主役にするという UX Bar の原則を守る。

---

## 8. Motion

- **Easing**: すべて単一の ease-out (`--ease-out`)。
- **Duration**: `--duration-fast` (hover / focus 反応) / `--duration-base` (enter / exit: toast slide, viewer transition) / `--duration-slow` (data viz: bar chart / line draw)。値は `tokens.css`。
- **Reduced motion**: `@media (prefers-reduced-motion: reduce)` で全 transition / animation を実質無効化する (アクセシビリティ上の必須要件)。

---

## 9. Z-index

`--z-base` (通常) / `--z-topbar` (sticky topbar) / `--z-dropdown` (⋯ メニュー) / `--z-toast` (トースト) / `--z-modal` (command palette / dialog)。値は `tokens.css`。

> 中間層を勝手に作らない。新しい層が要るならトークン追加 + この文書の更新。

### 9.1 Home recent container sizes

Home の「最近見たもの」日付レールは、viewport breakpoint ではなく一覧コンテナ専用の `recent-rail-collapse` (15rem) と `recent-rail-wide` (48.75rem) を使う。

---

## 10. Breakpoints

breakpoint の正本は `styles/theme.css` の `@theme` にある semantic 名の `--breakpoint-*` 6 値。TSX では named variant (`max-stack:` 等)、生 CSS では `@media (width < theme(--breakpoint-*))` で参照する (CSS `@media` は `var()` を解釈できないが `theme()` は解決される)。値はこの文書に重複させず、`check:design-tokens` が px の再導入を deny する。

- **phone**: 電話幅。ビューア操作のアイコン化、メニュー切替。
- **nav**: 小画面境界。topbar のラベル省略や viewer chrome の畳み込み。
- **stack**: mobile / desktop の主境界。フォーム複合部品や一覧ツールバーが縦積みに切り替わる。
- **sheet**: コメントパネルのサイドシート → ボトムシート切替。
- **viewer**: ビューア chrome のアクション圧縮。
- **wide**: 一覧の表形式が成立する幅。

semantic な `--breakpoint-*` は media query と container query のどちらから参照しても同じ意味を保つ。配置先の幅で構造を切り替える場合も新しい閾値を作らず、既存の `stack` を使う。

値を統廃合するときは、semantic role が同じ値だけをまとめ、見た目が偶然同じだけの値は分ける。

---

## 11. コンポーネント

各部品の一覧・variant・公式差分は `apps/web/app/components/catalog.ts`、寸法・状態は部品コード (`components/ui/` `components/form/` `components/layout/` `components/app/`) を正本にする。
ここでは命名規約と使い方の意図・制約だけを定める。

### 11.1 Button

shadcn `Button` (`ui/button.tsx`) を唯一のボタン実装とする。独自ボタンクラスを新設しない。主ボタンの色は `app.css` の `--primary` が持ち、コンポーネント側で色を上書きしない。variant / size は `catalog.ts` と `button.tsx` を参照する。

**ルール**:

- `default` variant は **画面につき 1 つ** が原則 (Copy URL がある画面で他に default を置かない)。
- サイズは既定 (`default`) に頼らず用途に応じて明示する (list 内の補助操作は `size="sm"` 等)。
- アイコンのみのボタンには `aria-label` を必ず付け、視覚補助は shadcn `Tooltip` (Provider は `root.tsx` に配置済み) で出す。省略テキストの全文提示だけはネイティブ `title` でよい。リンク先の preview は実リンクを trigger にした `HoverCard` を使えるが、内容内に操作を置かず、`HoverCard` を fallback の唯一の入口にしない。
- レイアウト都合の調整 (全幅化・縦積みなど) は使用側の `className` で行い、`ui/button.tsx` は改変しない。
- `Link` に適用するときは `asChild` で包む。

アイコンだけの app 操作は shadcn `Button` を土台にした `IconButton` (`components/app/icon-button.tsx`) を使う。`sm` は 28px、`md` は viewer・comment・project 用の 30px。home topbar は `NavigationLink` の `topbar` variant、settings navigation はグループ別のサイドバーとモバイルの `Sheet` を使う。

### 11.2 Avatar

shadcn `Avatar` (`ui/avatar.tsx`) を土台にした `AuthorAvatar` (`components/app/author-avatar.tsx`) を使う。fallback の背景色は user.id hash (`avatarSlotFor`) で `--avatar-1`〜`--avatar-6` から決める。文字は email の頭 1 文字 (uppercase)。寸法は `xs` 14px (viewer 補助情報)、`sm` 20px (一覧・コメント)、`menu` 26px (アカウントメニュー) のいずれかを明示する。

**落とし穴**: Google profile picture を `AvatarImage` に出すときは `referrerPolicy="no-referrer"` が必須 (referer を見て 429 / 403 を返すため)。画像未ロード中も fallback が見える (Radix 仕様、許容)。寸法は `AuthorAvatar` が所有する。`AvatarMenu variant="viewer"` だけが 520px 以下で trigger と avatar を 30px にし、使用側 `className` は右寄せや grid 配置だけに使う。

### 11.3 File-type icon

HTML 文字を入れる小バッジ。**色は warm-grey に統一**する。amber / 派手色は使わない。

### 11.4 Card (gallery)

- container 幅に応じて伸縮させる (固定幅で並べない)。
- hover で shadow を sm → md に変える。**lift しない**。
- title は 2 行 clamp。
- focus-visible は ring 標準形 (§13 参照)。

### 11.5 Toast

Sonner (`ui/sonner.tsx`) を使う。成功は緑チェック、任意で Undo ボタン、自動消滅。

**ルール**:

- 同時に 1 件のみ (新規 toast は前のを置き換える)。
- 確認ダイアログを挟むかは `--destructive` の見た目でなく操作結果で判断する。結果が不可逆、または実行者自身の権限・アクセスを失わせる操作は、ボタンの見た目に関わらず実行前に確認ダイアログを出す (例: 管理者移譲は実行者を member へ降格させ UI では戻せないため確認が要る)。Slack 切断のように復旧に再認可が必要な操作にも確認を出す。それ以外の取り消せる操作には確認の摩擦を足さない。
- toast は完了通知に使い、確認ダイアログの代わりにしない。

### 11.6 Dropdown menu

shadcn `DropdownMenu` (`ui/dropdown-menu.tsx`)。アイコンは line-art SVG に統一 (emoji 不可)、danger アイテムは `--red`。

### 11.7 Empty state

shadcn `Empty` (`ui/empty.tsx`) で組む: `EmptyHeader` (`EmptyMedia variant="icon"` → `EmptyTitle` → `EmptyDescription`) + `EmptyContent` (CTA は `Button`、Link は `asChild`)。viewer のエラー表示も `DeniedPanel` (`components/app/denied-panel.tsx`) 経由で同じ `Empty` 構成を使う。装飾を増やさない。illustration や mascot を置かない (UX Bar の「やらないこと」)。

### 11.8 Topbar

- ヒーローファーストのランディングは一般的な Topbar を必須にしない。
- 回遊する公開文書は `GuideTopbar` が高さ、背景、区切り線、ブランドリンク、基本ナビゲーションを所有する。
- サインイン、デバイス承認、OAuth 同意などの集中フローは `FocusedFlowBrand` がホームリンクの表現を所有し、グローバルナビゲーションを出さない。
- ランディングは `LandingShell`、ログイン後のアプリは `AppTopbar`、共有 Viewer は `AppTopbar` を土台にした Viewer 固有表示を使う。
- 4 系統を 1 コンポーネントへ統合しない。sandbox の成果物面には Artifact Share の Topbar を描画しない (full bleed)。

### 11.9 Visibility chip

shareable の公開範囲 (`Visibility`) を表す pill 形バッジ。shadcn `Badge` (`ui/badge.tsx`) を土台にした `VisibilityChip` (`components/app/visibility-chip.tsx`) を、viewer chrome / gallery card / list row / dialog で再利用する。配色は `Badge` の variant で与える (`catalog.ts` の Badge 参照)。

| visibility | icon | Badge variant |
|---|---|---|
| `private` | `IconLock` | `muted` |
| `project` | `IconUsers` | `success` |
| `workspace` | `IconBuilding` | `info` |
| `link` | `IconLink` | `warning` |

`VisibilityGlyph` は `Badge` を使わないため、同じトークンを参照する `glyphClassName` の配色クラスで同等の見た目を与える。

**ルール**:

- chip 自身を clickable にしてよい (owner なら公開範囲変更 dialog を開くトリガ。`Badge asChild` + `<button>`)。
- 4 値で同じ pill 形 / 同じ寸法を保つ (status badge を作るときも継承する)。
- 色面積で `private` → `link` の「外向性が増える」感覚を担保する (gray → green → blue → yellow の意図)。

### 11.10 全文検索

所有者の名前候補には件数を付けない。入力のたびに全件を集計することを避けるため、件数は結果の絞り込み欄にだけ表示し、閲覧可能な取得済みファイルから数える。スマホの絞り込みシートは上部の角を丸め、高さを画面の85%以内に収める。ヘッダーとフッターを固定し、内容だけをスクロールする。

共通ヘッダーの検索欄は「ファイル、人、プロジェクトを検索」と ⌘K を表示する。クリック、⌘K / Ctrl+K、入力欄の外での `/` で開く。デスクトップでは shadcn `Popover` を欄の直下に置き、`Command` の中に候補を表示する。初期選択は設けず、Enter はすべての結果、矢印キーは候補の選択に使う。人・プロジェクトの選択は欄内の削除可能な札にする。

- **候補**: 未入力時は「最近見たもの」「最近の検索」のみ。入力時は「人とプロジェクト」「ファイル」「すべての結果を表示」の順。Avatar、プロジェクトアイコン、FileTypeIcon で種類を示し、ファイルには所有者・プロジェクト・抜粋を添える。末尾にキー操作を案内する。API が返さない件数は表示しない。
- **入力と状態**: IME 変換中は送信せず、確定 Enter で遷移しない。150 ms の debounce 中は前の候補を残し、検索中と件数を aria-live で知らせる。Escape で閉じ、起点へフォーカスを戻す。
- **結果の見出し**: 本文は「『キーワード』の検索結果」から始め、件数を隣に小さな `text-muted-foreground` で表示する。キーワード入力はヘッダーに集約する。
- **絞り込み**: `Button variant="outline" size="sm"` と `rounded-full` を使い、所有者・プロジェクト・期間の Popover を一列に並べる。選択済みの所有者・プロジェクトは同じ列の札で外せる。解除は ghost、並び順は右端に置く。所有者は Checkbox と名前検索、プロジェクト・期間・並び順は RadioGroup を使う。変更は URL と結果へ即時反映する。
- **結果行**: 左に FileTypeIcon、タイトルリンク、所有者・プロジェクト、抜粋。デスクトップの右側には VisibilityChip と固定幅の日付欄を置き、行間は `border-divider` で区切る。タイトルと抜粋の一致箇所は `bg-search-highlight`（明暗両テーマの淡い黄色）で強調し、文字色を維持する。HTML として挿入しない。同名ファイルはリンク風の開閉ボタンからインデントした行に展開する。
- **スマホ**: 600 px 未満は虫めがねから全画面 Dialog を開く。検索欄と ghost の「キャンセル」を上部の同じ行に置く。結果では日付と公開範囲をコンパクトなメタデータ行にまとめる。「絞り込み」から `Sheet side="bottom"` を開き、同じメニュー内容を一列に表示する。ヘッダーに「すべて解除」、下部に全幅の「n件を表示」を置く。内容だけをスクロールし、閉じる操作と件数を常に利用できるようにする。

失敗時は条件と取得済みの結果を保持し、再読み込みを案内する。戻る操作は追加読込の深さと表示位置を復元する。文言は ja/en をそろえ、共有範囲は既存の VisibilityChip の用語を使う。

### 11.11 Guide page layout (guide-shell 部品)

ガイド記事・手順ページ用の再利用レイヤー (`/connect`・`/share-with-ai`・`/privacy`・`/terms`・`/tokushoho`・`/updates`)。本文は記事用に `text-base` を使い、アプリ UI の `text-sm` とは分ける。実装は `components/app/guide-shell.tsx` (部品) と `guide-styles.ts` (共有クラス定数)、目次は `guide-toc.tsx`、適用例は `routes/connect.tsx`。

- **レイアウト** (`GuideShell` + `GuideMain`): prose カラム ＋ 右 sticky の目次 (`GuideRail`) を 2 カラム。狭幅で rail を隠し、本文上部のチップ目次 (`GuideTocMobile`) に切り替える。
- **prose バリアント** (`GuideProse`): 目次なしの単一カラム。markdown 由来の見出し・段落・リスト・コード・引用・水平線に記事タイポを当てる、文書ページ (`/privacy`・`/terms`・`/tokushoho`・`/updates`) 用。要素スタイルは `GuideProse` の子孫ユーティリティに限定する。
- **目次のハイライト**: 表示中の節を `aria-current` で示す。JavaScript なしでも目次リンクと anchor 遷移は機能する補助機能とする。
- **手順** (`guideStepsClassName`): 番号は warm soft の丸バッジ、連続する番号を縦線 (spine) でつなぐ。
- **コードブロック** (`CopyableCodeBlock`): ファイル名タブ＋コピー。
- **callout** (`guideCalloutClassName`): info アイコン＋ warm soft 面の補足カード。装飾を増やさない (§11.7 と同方針)。
- **ホスト識別**: 見出し前のブランド色ドット。公式ロゴは使わない。色は core palette 外のブランド色で、実装側に定義する。
- **CTA**: primary 青ボタン。外部アプリへ飛ぶ導線には launch アイコンを添える。

**ルール**:

- 新しい色・余白・角丸はトークンから取る。装飾グラデーションや派手な影を足さない。
- 全 focusable に focus-visible リング (§13)。smooth scroll と遷移は `prefers-reduced-motion` で無効化する。

### 11.12 フォーム部品 (shadcn 公式 + 複合)

フォーム・管理画面は部品でしか組まない。shadcn 公式にある部品 (`Field` / `Input` / `Select` / `Label` 等) はそのまま使い、独自部品は shadcn に無い画面構成の複合 (`components/form/`) に限る。単純な縦積み・横並びは汎用 layout primitive (`components/layout/` の `Stack` / `Inline`) を使い、用途名 spacing (`gap-section` / `gap-field` / `gap-inline`) は `SettingsPage` / `SettingsSection` / `InlineFields` が所有する。スタイルは部品の tsx か近接の `*-styles.ts` に同居し、グローバル CSS へは追記しない。部品一覧と役割は `catalog.ts`、適用例は `routes/_protected/settings/` を参照する。

**ルール**:

- shadcn 公式に部品がある領域では独自部品を作らない。カスタマイズは `app.css` の semantic token 上書きで行う。
- 用途名 spacing は意味的な複合部品が gap として所有する。汎用 `Stack` / `Inline` の gap props は `@theme` spacing scale の有限集合だけを受け取り、用途名 spacing を公開 API に混ぜない。
- `Stack` / `Inline` の `className` では padding、幅、surface、typography、局所的な responsive 制約だけを許す。display、軸、gap、alignment、justify、wrap、外側 margin は props が所有し、`pnpm check:design-tokens` で重複指定を検出する。
- 余白は部品が gap で所有する。ページ (routes) 側に余白ユーティリティ・余白のインライン style を書かない (データ表示の `width` 等は可)。
- 隠しラベルは `FieldLabel` に `sr-only` を付ける。エラーは `FieldError` (`role="alert"`) をフィールド直下に置き、`aria-describedby` / `aria-invalid` を入力へ配線する。
- ボタンは shadcn `Button` を使う (§11.1)。
- チェックボックスは共有 `Checkbox` を使う。境界線は light / dark とも隣接する背景に対して 3:1 以上のコントラストを保ち、disabled 時も薄くしない。disabled は破線の境界で示し、チェック済みの disabled は `bg-muted` の塗りと `text-foreground` のチェック印を使う。
- 有効な input・select・textarea・radio の境界線（`border-input`）は light / dark とも隣接する背景に対して 3:1 以上のコントラストを保つ。
- 表示系も shadcn 公式を使う: バッジ / ステータス pill は `Badge`、バナーは `Alert` (ARIA role は用途に合わせ使用側で上書き)、アバターは `Avatar` (§11.2)、使用量メーターは `Progress` (装飾扱いなら `aria-hidden`)、radio は `RadioGroup` (非制御フォームでは Root に `name` + `defaultValue`)。
- 構造系も shadcn 公式を使う: ページ内状態切替は `Tabs`、URL 駆動の切替 (ネステッドルート切替) はリンクの `TabNav` を使う。設定メニューは目的別の見出しで分けたリンク一覧を使い、狭い画面では `Sheet` に収める。`TabNav` はページナビゲーションであり `role="tablist"` を付けない。その他は `Table` (semantic `<table>`)、`Breadcrumb`、`Empty` (§11.7)、`Card`、`Tooltip` (§11.1 のルール)。手組みの `role="tablist"` / `role="table"` を新設しない。

### 11.13 Layout primitives (`Stack` / `Inline`)

単純な一方向フロー (縦積み / 横並び) は `components/layout/stack.tsx` と `components/layout/inline.tsx` を使う。grid、scroll container、overlay、breakpoint で軸や gap が変わる複合部品は専用 component が所有し、primitive に偽装しない。

**API**:

- `gap` (必須): `@theme` spacing scale の `0` / `0.5` / `1` / `1.5` / `2` / `3` / `4` / `5` / `6` / `8` / `10` / `12` / `16` / `20` / `24`。
- `align` / `justify` / `wrap` (任意): 有限の props。省略時は CSS 既定。
- `asChild`: Radix Slot で単一子要素へ className / props / ref / event handler を合成する。

**ルール**:

- primitive の `className` では padding、幅、surface、typography、局所的 responsive 制約だけを書く。
- 兄弟間隔を子の外側 margin (`mt-*` / `mb-*` 等) で作らず、親の `gap` へ寄せる。
- 描画後に隣接要素のゼロ間隔や接触を検出する gap audit は、`/dev/scenarios` の各シナリオに対して `apps/web/app/routes/dev.scenarios.$scenario/scenarios.browser.test.tsx` が実行する。
- 機械検査が deny する保証範囲は `Stack` / `Inline` の静的に解決できる display・軸・gap・alignment・justify・wrap・外側 margin、および settings route の局所的な正の block-axis margin である。dynamic-review、既存の意味的所有、reset・prose・overlay・geometry surface は deny せず、現状件数を baseline として許可しない。
- 代表状態と props 一覧は `catalog.ts` と `/dev/gallery` を参照する。

### 11.14 設定画面 (管理画面)

設定画面 (`/settings` 配下: メンバー・使用量・トークン・連携・請求・操作履歴・棚卸し) はテーブル中心の管理画面であり、成果物ビューアとは別の規範を持つ。値の正本は `@theme` (`--spacing-settings-max`) と `page-shell-styles.ts` の `settingsMainClassName`。

**レイアウト**:

- 設定画面のシェルは広幅の `settingsMainClassName` を使う (左右余白を詰めて密度を優先する)。一覧ページ (home・最近の成果物・プロジェクト一覧・プロジェクト詳細・アーカイブ) は兄弟の `listMainClassName` を使い、ビューア・ガイドのシェルには適用しない。
- ナビ列と本文の 2 カラムは `SettingsNav` が所有する。テーブルの列は `Table` の overflow に頼る前に、広幅シェルの実効幅へ収める。長文になり得る列 (成果物名など) はセル内の幅制約付き wrapper で truncate / wrap の方針を持つ。

**テキスト階調 (4 段)**: 設定画面の全テキストは次のどれかに載せ、同じ役割は同じ段にする。

| 段 | 用途 | 形 |
|---|---|---|
| ページタイトル | h1 (`PageHeader`) | `text-xl font-semibold` |
| セクション見出し | h2 (`SettingsSection`) / 小見出し h3 | h2: `text-base font-semibold` / h3: `text-sm font-semibold` |
| 本文・説明 | テーブルセル、説明文、セクション説明 | `text-sm` (説明は `text-muted-foreground`) |
| メタ | 件数、日時、メールアドレス、注記 | `text-xs text-muted-foreground` |

統計値 (`UsageStat` の値) は視認性のための例外として `text-base` + strong を使う (`form/settings-text-styles.ts` の `statValueClassName` が正本)。
補助テキストは `TeamMuted` (メタ) / `TeamMutedParagraph` (説明) がサイズを内包する (`catalog.ts` の `form/team-muted`)。利用側でサイズ utility を上書きしない。`<small>` タグは使わない (メタ段の `text-xs` span にする)。金額の強調は「本文の段 + `font-semibold`」で表す。
共有するテキスト系のクラス定数 (`*-styles.ts`) は **font-size を必ず内包する**。サイズを親の継承に任せると、`text-sm` 文脈の外に置かれた瞬間に基底の 16px へ化ける (実例: 請求ページの本文リンク)。
見出しは必ず h タグで出す。`CardTitle` など div ベースの部品を見出しの代わりに使うと、見出しジャンプするスクリーンリーダー利用者からセクションが消える (実例: 請求見込みの Card 化)。

**ページ構成の原則**:

- **1 ページ 1 関心**: 1 つの設定ページは 1 つの関心を扱う。画面の切替や絞り込みは独自 state でなくネステッドルート・URL クエリに載せる。
- **主タスクを先頭**: ページの主目的の操作・一覧を最初のセクションに置く。
- **参照はページ末尾**: ガイドや外部ドキュメントへのリンクはページ末尾の固定位置に置く。
- **テーブル画面の標準形**: フィルタ → テーブル → ページャの縦並び。空状態は `Empty` (§11.7)。代表形は `/dev/gallery` の form セクションを参照する。

---

## 12. Voice &amp; Tone

UX Bar の「コピー」と、現行 UI の要件に整合させる。

### 12.1 共通原則

- **動詞始まり**: "Pick a file" / 「ファイルを選択」
- **短く正直**: 1 文 5–12 単語、現実を言う ("This file is no longer available." / 「このファイルは利用できません。」)
- **能動態**: "We won't store your file" / 「ファイルを保存しません」
- **共有系の語彙**: file / 共有 / アクセス / オーナーを使う。保存先や権限の正本として Drive を示す文言は使わない。
- **共有先は「リンク」/ "link"**: ファイルの共有先を指す語は「リンク」(英語 "link") に統一する。設定に貼り付ける技術的な接続先 (MCP コネクタなど) だけ「URL」を使う。
- **避ける**: "artifact" を UI に出さない (`file` / `ファイル` を優先)、"Oops!"、絵文字スプリンクル、deploy / cloud / AI 連呼。

### 12.2 言語固有

**English**:

- センテンスケース (Title Case にしない: "Add a file" not "Add A File")
- 句読点: 略号は `URL`, `Workspace` (大文字)、ボタンは period なし

**Japanese**:

- ですます体 (敬語)
- 「ログイン」を使う。「サインイン」は使わない
- カタカナ語の濫用を避ける ("ファイル" / "ワークスペース" は OK、"アーティファクト" は UI 非推奨)
- 句読点: ボタンや見出しは句点 (`。`) なし、説明文には付ける

### 12.3 ICU plural

```
{n, plural, one {1 file} other {# files}}
```

英語のみ。日本語は単数複数の区別なし (`ファイル {n} 件` で OK)。実装は `tPlural()` ヘルパで `'card.viewCountOne' / 'card.viewCountOther'` の 2 キーを保持する。

---

## 13. アクセシビリティ規約

アクセシビリティの実装ガイド。

- **focus-visible** リング: 正本は `--ring` トークン (`--color-ring` = `var(--ring)` = `var(--link)`)。箱状コントロールは `focus-visible:ring-3 focus-visible:ring-ring/50` (border を持つ部品は `focus-visible:border-ring` も付ける)。散文リンク・テキストナビは `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`。
- **キーボード**: `Tab` で全到達、`Enter` で activate、`Esc` で modal / menu close。
- **arrow-key navigation**: gallery / palette で必須。
- **aria 属性**: ボタンには `aria-label` (i18n 対応)、modal には `role="dialog"` + `aria-label`。
- **コントラスト**: 全テキストが WCAG AA 以上 (warm-black on white ≈ 12.6:1)。
- **reduced motion**: §8 で必須無効化。

---

## 15. レビュー指摘の機械検査への昇格

人間レビューとエージェント批評で同型の指摘が 2 回出たら、3 回目を人の注意力だけで防がず、deny rule または検査スクリプトへの昇格を検討する。個別画面の偶発的な問題ではなく、共通の禁止条件または期待結果として表現できる場合に昇格する。誤検知が多い、実行時間が過大、意図の良否を機械判定できない場合は、理由を PR 本文に残してレビュー観点のまま維持する。

昇格先は、再発条件に応じて次の順で選ぶ。

1. **デザイントークン検査 (`check:design-tokens`)**: 色、余白、寸法、セレクタ、レイアウト所有など、ソースコードの静的な禁止条件として判定できる指摘。
2. **コピー用語検査 (`copy-glossary/no-violations`)**: 禁止語、表示語の置換、語彙の組み合わせなど、表示文言を静的に判定できる指摘。許容表現と禁止表現の根拠は [glossary](./glossary.md) に置く。
3. **回帰検査 (`pnpm visual:compose`)**: 部品や代表画面の見た目、横あふれ、重なり、主要要素の可視性など、描画結果または画面の幾何で判定する指摘。baselineを意図的に更新するときは `pnpm visual:compose:update` を使う。一部のテストだけを更新するときは、`VITEST_TEST_NAME` にテスト名の正規表現を渡す（例: `VITEST_TEST_NAME='(^|\s)search-results-(mobile|mobile-short|desktop)-(light|dark)$' pnpm visual:compose:update`）。対象外のbaselineは書き換わらない。

隣接ブロックの縦間隔ゼロは、2 回の再発を受けて gap audit に昇格しました。

どの受け皿にも適さない指摘は、エージェント批評の観点または個別の reference / decision に残す。機械検査を追加するときは、再発した失敗例を fixture または test として固定し、既存の正当な実装を例外登録で無条件に通さない。

検査を新設・改修したときは、既知の欠陥を一時的に再導入して fail することを確認する (負の対照)。検出ゼロと検査の無効は出力から区別できない。
visual検出器の負の対照は `pnpm visual:fault-injection` で実行する。通常のPR検証には含めず、visual検出器やその配線を変更したときに明示的に実行する。

---

## 改訂履歴

| 日付 | 版 | 変更内容 |
|---|---|---|
| 2026-05-10 | v0.1  | 初版                                            |
| 2026-07-29 | v0.25 | 現行の semantic token、部品規範、検証基準へ更新 |
| 2026-08-14 | v0.26 | 日本語 system font fallback、禁則処理、表示面ごとの font 所有範囲を明文化 |
| 2026-08-24 | v0.27 | 批評所見を直す、計測する、見送るに分ける判断手順を追加 |

### Unreleased

| 日付 | 版 | 変更内容 |
|---|---|---|
| Unreleased | v0.28 | 批評所見の処置を直す・見送るの二つとし、明確な利用者体験・UI の改善と証拠で判断する規則へ変更 |

### Grouped Settings navigation

Settings uses purpose groups in this order: Your settings, Workspace, Review,
Plan, Workspace info. The desktop sidebar and mobile bottom sheet share the
same role-filtered items; empty groups are omitted. On narrow screens the
trigger names the current item followed by its group. Selecting a link closes
the sheet. The dialog primitive owns Escape, focus containment and return.

The storage meter belongs below the used amount. Its neutral track remains
visible at zero; near-quota fill uses the warning token. A labelled progressbar
and visible percentage communicate usage, with fill capped at 100% while the
text retains over-quota percentages. Invalid quotas show unavailable text.

### Settings confirmations and results

Settings forms submit with their own fetcher. Each action returns `data({ ok, code, intent, ...payload }, { status })`. Successful writes use a 2xx status and refresh loader data. Expected failures use a 4xx status and keep the draft at its originating control. Previews and one-time credentials belong to the form that requested them.

While a confirmation is pending, lock its controls and dismissal. Show expected failures and interrupted responses inside the open dialog. Retry only on user input. Close on success, restore focus, and announce the outcome once. A committed removal with a failed transfer refreshes the member lists and directs the user to transfer the remaining files from Removed members.

Only recognized external returns use URL notices. Consume the return parameter by replacing the history entry and retain checkout-pending feedback during the current Billing visit.

Disconnecting Slack removes authorization. Although reconnecting is possible, it requires a new authorization flow and interrupts previews and notifications; use a destructive confirmation that explains these consequences. Bot stop and creation cancellation also use destructive confirmations. Keep async confirmation dialogs open and disabled while submitting, show failures inside the dialog, and close only after success.

Settings notices use success (check, status), warning (triangle, status), and error (error icon, alert). Past-due and near-storage-limit billing warnings are urgent warning alerts. Unknown outcomes are errors. External sharing uses one explicit page-wide save with visible unsaved-change cues; reductions to maximum expiry require a read-only count preview before destructive confirmation.
