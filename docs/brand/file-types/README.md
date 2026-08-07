# ファイル種別アイコン

成果物の種別 (HTML / Markdown / Site) を表す素材。Slack unfurl のサムネなど、種別を一目で示したい場面で使う。ブランドマーク (`../icon.svg`) とは別系統のアセット。

- `html.svg` / `md.svg` / `site.svg` — `viewBox="0 0 160 180"`、背景透過。縦長の紙＋右上の折り角＋ラベル＋coral の種別記号。
- 4 隅は対称の r=15 角丸。記号は HTML=`</>`、MD=横線、Site=globe。

## 配色

| 要素 | 値 | 備考 |
|---|---|---|
| 紙の面 | `#FFFFFF` | |
| 外枠・折り角の線 | `#9E9484` | くすんだ warm-gray |
| 折り角の面 | `#EAE5DC` | warm-gray (薄) |
| ラベル | `#37352f` | `--text` (warm-black) |
| 種別記号 | `#F76B58` | ブランド coral (`../icon.svg` と同値) |

## 配信 (Slack サムネ)

Slack の image accessory は SVG 不可なので、`build.sh` が正方形・背景透過の PNG を `apps/web/public/file-types/{html,md,site}.png` に生成する (256×256、アイコンを中央に padding 付きで配置 = 正方形クロップ対策)。アイコンを変えたらこれを実行する。

```sh
bash docs/brand/file-types/build.sh
```

## 使うとき

- ラベルの `font-family` はシステムサンセリフを指定済 (standalone でも太字で出る)。
- 色やアイコンを変えるときはこの SVG を直して `build.sh` を再実行する (派生 PNG を手編集しない)。トークンは [`../../reference/design-system.md`](../../reference/design-system.md) を参照。
