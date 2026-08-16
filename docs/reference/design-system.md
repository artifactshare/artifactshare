# Artifact Share — Design System

> **値の正本**: `apps/web/app/app.css` の `@theme` / `apps/web/app/styles/tokens.css` (light / dark とも) と各部品コード
> **部品一覧の正本**: `apps/web/app/components/catalog.ts` (何があり・いつ使い・どの variant を持ち・公式から何が違うか)
> ステータス: 現行仕様 v0.26 (2026-08-14)

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
3. `apps/web/app/app.css` (`@theme`) / `apps/web/app/styles/tokens.css`: 実装で使うトークン値の正本。
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
├── app.css               # body reset, font-family, focus-visible, @theme (トークン値の正本)
├── styles/
│   ├── tokens.css        # design tokens (light :root ＋ dark)
│   └── view-transitions.css  # ドキュメント級グローバル CSS (view transitions)
├── components/
│   ├── catalog.ts        # 部品カタログ (一覧・variant・公式差分の正本)
│   ├── ui/               # 汎用 UI primitives (shadcn 系)
│   ├── form/             # フォーム複合部品 (§11.12、スタイル同居)
│   ├── layout/           # 一方向レイアウト primitive (Stack / Inline)
│   └── app/              # Artifact Share 固有の部品
└── i18n/
    ├── en.json
    └── ja.json
```

shadcn/ui の new-york style を**ベースに採用**しつつ、color/spacing/radius を `@theme` のトークンで上書きする。公式からの独自差分は `catalog.ts` の `upstreamDiff` に記録する。

`as-*` 接頭辞はかつてアプリ CSS で使っていたクラス命名で、`components.css` の廃止で定義は消えた。グローバル CSS (`app.css` + `styles/*.css`) の rule prelude に class / id セレクタ (`as-*` を含む) を新規追加すると `check:design-tokens` の `global-css-selector` 検査が弾く。印刷・書き出しなどアプリ外で生成・注入するドキュメントの CSS は `as-` を使わず別接頭辞 (`asx-` 等) にする。

ページ全体に必要な挙動は、部品用 class / id ではなく、目的を表す `data-*` 属性をページの `main` に置いてグローバル CSS の条件にできる。ガイドとランディングのスムーズスクロールはこの基準に従い、`prefers-reduced-motion` を尊重する。

---

## 3. Color

値の正本は `app.css` の semantic 変数とし、`@theme inline` を介して named utility を生成する。ここでは語彙だけ定める。

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

`user.id` (or `google_sub`) を hash して 6 色のうち 1 つを選ぶ。**workspace mark** にも同じ palette を使う。`--avatar-1`〜`--avatar-6` は gradient のため、色 named utility にできない唯一の raw gradient 例外として `tokens.css` に置く。

---

## 4. Typography

### 4.1 Font stack

製品 UI は Geist Variable を英数字の preferred font とし、日本語グリフは Hiragino Sans、Noto Sans JP、Meiryo の順で OS のフォントへ fallback する。日本語ページは `line-break: strict` と `word-break: auto-phrase` を併用し、禁則処理を保ちながら語句単位で改行する。文字幅を変える `palt` などの OpenType feature は全体へ適用しない。表、入力、バッジ、コード、数値表示は同じ stack を継承し、各部品が所有する既存の幅と整列を維持する。emoji は `Apple Color Emoji` / `Segoe UI Emoji` を明示して OS 任せの描画に統一する。値は `app.css` を正本にする。

表示面ごとのフォント指定は、配信方法と生成環境が異なるため完全には統一しない。

| 表示面 | 所有範囲と方針 |
|---|---|
| 製品 UI | `app.css` が Geist Variable、日本語 system fallback、locale 固有の文字組みを所有する。追加の日本語 Web フォントは配信しない |
| ユーザー文書 | Markdown renderer またはアップロードされた文書自身が font stack と文字組みを所有し、製品 UI の指定を文書内へ注入しない |
| PDF 書き出し | 書き出し処理が再現可能な日本語 font の埋め込みを所有する |
| OG 画像 | preview image generator が利用可能な埋め込み font を所有する。製品 UI の OS fallback には依存しない |
| 独立した error / embed surface | 各 surface の自己完結した CSS が所有し、製品 UI bundle の font 読み込みには依存しない |

### 4.2 Type scale

正本は Tailwind 既定スケール。自前のサイズトークンは持たない。

| Utility | 用途 |
|---|---|
| `text-xs` | kbd / caption / pill / meta |
| `text-sm` | body default / button / label / input |
| `text-base` | 記事本文 / hero sub |
| `text-lg` | section heading |
| `text-xl` | page title / empty state |
| `text-2xl` | larger heading |
| `text-3xl` | hero h1 |
| `text-4xl` | landing h1 |
| `text-5xl` | landing display |

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

breakpoint の正本は `app.css` の `@theme` にある semantic 名の `--breakpoint-*` 6 値。TSX では named variant (`max-stack:` 等)、生 CSS では `@media (width <= theme(--breakpoint-*))` で参照する (CSS `@media` は `var()` を解釈できないが `theme()` は解決される)。値はこの文書に重複させず、`check:design-tokens` が px の再導入を deny する。

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

アイコンだけの app 操作は shadcn `Button` を土台にした `IconButton` (`components/app/icon-button.tsx`) を使う。`sm` は 28px、`md` は viewer・comment・project 用の 30px。home topbar は `NavigationLink` の `topbar` variant、settings navigation は `TabNav` (`components/app/tab-nav.tsx`) を使う。

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
- 確認ダイアログを挟むかは `--destructive` の見た目でなく操作結果で判断する。結果が不可逆、または実行者自身の権限・アクセスを失わせる操作は、ボタンの見た目に関わらず実行前に確認ダイアログを出す (例: 管理者移譲は実行者を member へ降格させ UI では戻せないため確認が要る)。取り消せる操作には確認の摩擦を足さない。
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

### 11.10 Command palette

- modal + backdrop blur。
- セクション (`Actions` / `Files`) で区切る。
- Footer のキー hint は常時表示する。モバイル幅 (`max-phone`) のみ非表示 (物理キーボード前提のヒントのため)。

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
- 表示系も shadcn 公式を使う: バッジ / ステータス pill は `Badge`、バナーは `Alert` (ARIA role は用途に合わせ使用側で上書き)、アバターは `Avatar` (§11.2)、使用量メーターは `Progress` (装飾扱いなら `aria-hidden`)、radio は `RadioGroup` (非制御フォームでは Root に `name` + `defaultValue`)。
- 構造系も shadcn 公式を使う: ページ内状態切替は `Tabs`、URL 駆動の切替 (ネステッドルート切替) はリンクの `TabNav` を使う。`TabNav` はページナビゲーションであり `role="tablist"` を付けない。その他は `Table` (semantic `<table>`)、`Breadcrumb`、`Empty` (§11.7)、`Card`、`Tooltip` (§11.1 のルール)。手組みの `role="tablist"` / `role="table"` を新設しない。

### 11.13 Layout primitives (`Stack` / `Inline`)

単純な一方向フロー (縦積み / 横並び) は `components/layout/stack.tsx` と `components/layout/inline.tsx` を使う。grid、scroll container、overlay、breakpoint で軸や gap が変わる複合部品は専用 component が所有し、primitive に偽装しない。

**API**:

- `gap` (必須): `@theme` spacing scale の `0` / `0.5` / `1` / `1.5` / `2` / `3` / `4` / `5` / `6` / `8` / `10` / `12` / `16` / `20` / `24`。
- `align` / `justify` / `wrap` (任意): 有限の props。省略時は CSS 既定。
- `asChild`: Radix Slot で単一子要素へ className / props / ref / event handler を合成する。

**ルール**:

- primitive の `className` では padding、幅、surface、typography、局所的 responsive 制約だけを書く。
- 兄弟間隔を子の外側 margin (`mt-*` / `mb-*` 等) で作らず、親の `gap` へ寄せる。
- `pnpm report:spacing-ownership` は `Stack` / `Inline` の適用 className と、そのほかの要素の実際の className 値を、ファイル・行・対象・class・構文区分・理由の安定順で棚卸しする。`ownership-review` は構文だけでは責務を決めず、親所有か意味的複合部品所有かを人手で判定する表示専用の候補であり、許可リストではない。
- spacing ownership reportはsource上で余白の所有者を棚卸しする。描画後に隣接要素のゼロ間隔や接触を検出するgap auditとは役割が異なる。全登録画面のgap auditは `pnpm screens:capture -- --all --audit-gaps` で実行する。
- 機械検査が deny する保証範囲は `Stack` / `Inline` の静的に解決できる display・軸・gap・alignment・justify・wrap・外側 margin、および settings route の局所的な正の block-axis margin である。dynamic-review、既存の意味的所有、reset・prose・overlay・geometry surface は report-only とし、現状件数を baseline として許可しない。表示専用の所有方針と判断理由は `scripts/spacing-ownership-policy.mjs` を正本とする。
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

## 14. エージェント批評の観点

画面キャプチャを入力に、批評 agent が UI を評価するときの観点の正本。観点の追加・変更はこの章の更新で行う。

上位基準は「北極星 (投稿→反応→再投稿の輪) に照らして、この画面は担当の段 (画面台帳の `loop`) を前へ進めているか」。6 観点はその内訳である。

1. **役割の単一性**: 画面の役割が 1 つに絞れているか。画面台帳 (`scripts/screen-ledger.mjs`) の `role` / `primaryAction` と実際の画面が一致しているか。
2. **語彙**: 表示文言が用語集 ([glossary](./glossary.md)) の表示語に従っているか。機械検査 `check:copy-glossary` が deny list で拾えない言い回しの揺れも見る。
3. **視覚的な階層と密度**: 主役 (成果物・主要導線) が視覚的に最も強いか。密度が過剰・過疎でないか。トークン外の見た目 (機械検査の対象) ではなく、配置と強弱の判断を見る。
4. **代表状態の抜け**: 台帳の `states` にない、利用上あり得る状態 (空、大量、長文、エラー、待機) が考慮されているか。
5. **次の行動の明確さ**: 閲覧後に利用者が取るべき次の行動 (台帳の `loop` の次の段) が画面上で明確か。
6. **モック照合**: 対象画面のモックと実装を並べ、表示項目・配置・状態の差を列挙する。各差が spec に明記された意図的な差か、明記のない無断差かを判定し、無断差は指摘として返す。モックの表示語が [glossary](./glossary.md) またはこの design-system と食い違う場合は正本側を優先し、表示語 drift を無断差として指摘しない。

---

## 15. レビュー指摘の機械検査への昇格

人間レビューとエージェント批評で同型の指摘が 2 回出たら、3 回目を人の注意力だけで防がず、deny rule または検査スクリプトへの昇格を検討する。個別画面の偶発的な問題ではなく、共通の禁止条件または期待結果として表現できる場合に昇格する。誤検知が多い、実行時間が過大、意図の良否を機械判定できない場合は、理由を PR 本文に残してレビュー観点のまま維持する。

昇格先は、再発条件に応じて次の順で選ぶ。

1. **デザイントークン検査 (`check:design-tokens`)**: 色、余白、寸法、セレクタ、レイアウト所有など、ソースコードの静的な禁止条件として判定できる指摘。
2. **コピー用語検査 (`check:copy-glossary`)**: 禁止語、表示語の置換、語彙の組み合わせなど、表示文言を静的に判定できる指摘。許容表現と禁止表現の根拠は [glossary](./glossary.md) に置く。
3. **回帰検査 (`pnpm visual:compose`)**: 部品や代表画面の見た目、横あふれ、重なり、主要要素の可視性など、描画結果または画面の幾何で判定する指摘。baselineを意図的に更新するときは `pnpm visual:compose:update` を使う。

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
