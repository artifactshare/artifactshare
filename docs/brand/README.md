# ブランドアセット

このディレクトリでは、ブランドマーク（coral タイルに白い `as`）の原本と、そこから生成する各種アセットを管理する。

## 商標とセルフホスト利用

リポジトリのライセンスは、Artifact Share の名称、ロゴ、サービスマークその他の商標に関する権利を付与しない。これらを使えるのは、出所を事実に即して示す場合か、セルフホスト版に同梱された未改変のブランド資産をソフトウェアと一緒に再配布する場合に限る。公式版であることや、TechTalk, Inc. による承認・提携・後援があると誤解される使い方はできない。

セルフホスト版を独自のサービスとして提供するときは、同梱されたマークをそのままサービスの識別表示に使わない。出所表示や未改変資産の再配布を超える利用については、`support@artifactshare.com` へ問い合わせる。

## 原本と生成コマンド

- **`icon.svg`** — UI・favicon 用マークの生成元。背景は透過（角の外は alpha 0）で、角丸タイル自体を SVG 内に持つ。
- **`platform-icon.svg`** — GitHub Organization や Slack App など、表示側が角丸マスクをかけるサービス向けの正方形マスター。`as` の字形・配置・色は `icon.svg` と同じで、背景だけを全面 coral にしている。
- **`build.sh`** — `icon.svg` から下記の派生ファイルをまとめて書き出すコマンド（`rsvg-convert` と `python3` が必要）。マークを変更したら必ず実行し、手動コピーは作らない（favicon と OG 画像が食い違うのを防ぐため）。

```sh
bash docs/brand/build.sh
```

## 派生ファイル（すべて透過 PNG / `build.sh` が生成）

| ファイル                         | サイズ | 用途                                                     |
| -------------------------------- | ------ | -------------------------------------------------------- |
| `png/icon-120.png`               | 120    | **Google OAuth 同意画面のアプリロゴ**（透過・推奨サイズ） |
| `png/icon-512.png`               | 512    | 高解像度の予備（ストア・大きい表示用）                   |
| `png/platform-icon-512.png`      | 512    | GitHub Organization / Slack App 入稿用（角丸なし）       |
| `png/platform-icon-1024.png`     | 1024   | 外部サービス入稿用の高解像度版（角丸なし）               |
| `png/icon-{32,64,128,256}.png`   | 各     | Marketplace・汎用                                        |
| `png/favicon-{16,32,48,180}.png` | 各     | favicon / apple-touch の元画像                           |

## 出力先（`build.sh` が `public/` へ書き込む）

- `public/favicon.svg` ← `icon.svg`
- `public/apple-touch-icon.png` ← `png/favicon-180.png`
- `public/favicon.ico` ← `png/favicon-{16,32,48}.png` を束ねた PNG 埋め込み ICO
- `apps/web/app/services/brand-og-mark.generated.ts` ← 公開ページの OG カード用 PNG data URI（`@generated`）

マークの意図と 16px 基準は [`docs/reference/design-system.md`](../reference/design-system.md) §1 を参照。coral と cream の色値は、このディレクトリの `icon.svg` を基準にする。
