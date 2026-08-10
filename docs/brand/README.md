# ブランドアセット

ブランドマーク (coral タイル＋白い `as`) の正本と派生をここで管理する。

## 商標と self-hosting

repository の license は、Artifact Share の名称、ロゴ、サービスマークその他の商標に関する権利を付与しない。出所を事実に即して説明するため、または self-host 版に同梱された未改変のブランド資産をそのソフトウェアとともに再配布するために必要な範囲でのみ使用できる。公式版、TechTalk, Inc. による承認、提携、または後援があるとの誤認を招く使い方はできない。

self-host 版を独自のサービスとして提供するときは、同梱された mark をそのままサービスの識別表示として使わない。出所表示や未改変資産の再配布を超える利用については `support@artifactshare.com` へ問い合わせる。

## 単一ソース

- **`icon.svg`** — UI / favicon 用マークの生成元。背景透過 (角の外は alpha 0)、角丸タイルは SVG 自身が持つ。
- **`platform-icon.svg`** — GitHub Organization / Slack App など、表示側が角丸マスクを適用するサービス向けの正方形マスター。`as` の字形・配置・色は `icon.svg` と同一で、背景だけを全面 coral にする。
- **`build.sh`** — `icon.svg` から下記の派生をすべて書き出す単一コマンド (rsvg-convert + python3 が要る)。マークを変えたら必ずこれを実行する。手動コピーは作らない (favicon と OG がドリフトするため)。

```sh
bash docs/brand/build.sh
```

## 派生 (すべて透過 PNG / `build.sh` が生成)

| ファイル                         | サイズ | 用途                                                     |
| -------------------------------- | ------ | -------------------------------------------------------- |
| `png/icon-120.png`               | 120    | **Google OAuth 同意画面のアプリロゴ** (透過、推奨サイズ) |
| `png/icon-512.png`               | 512    | 高解像度の予備 (ストア / 大きい表示)                     |
| `png/platform-icon-512.png`      | 512    | GitHub Organization / Slack App 入稿用 (角丸なし)        |
| `png/platform-icon-1024.png`     | 1024   | 外部サービス入稿用の高解像度版 (角丸なし)                |
| `png/icon-{32,64,128,256}.png`   | 各     | Marketplace / 汎用                                       |
| `png/favicon-{16,32,48,180}.png` | 各     | favicon / apple-touch の元                               |

## 配信先 (`build.sh` が `public/` へ書き込む)

- `public/favicon.svg` ← `icon.svg`
- `public/apple-touch-icon.png` ← `png/favicon-180.png`
- `public/favicon.ico` ← `png/favicon-{16,32,48}.png` を束ねた PNG 埋め込み ICO
- `apps/web/app/services/brand-og-mark.generated.ts` ← 公開ページの OG カード用の PNG data URI (`@generated`)

マークの意図と 16px 基準は [`docs/reference/design-system.md`](../reference/design-system.md) §1 を参照。coral / cream の色の値は、このディレクトリの生成元 (`icon.svg`) を正本にする。
