# ファイル種別アイコン

ファイルの種別（HTML / Markdown / Site）を示すアイコン素材。Slack 展開時のサムネイルなど、種別を一目で伝えたい場面で使う。ブランドマーク（`../icon.svg`）とは別系統のアセットとして管理する。

- `html.svg` / `md.svg` / `site.svg` — `viewBox="0 0 160 180"`、背景透過。縦長の紙、右上の折り角、ラベル、coral の種別記号で構成する。
- 四隅は対称の `r=15` 角丸。種別記号は HTML が `</>`、MD が横線、Site が地球儀（globe）。

## 配色

| 要素 | 値 | 備考 |
|---|---|---|
| 紙の面 | `#FFFFFF` | |
| 外枠・折り角の線 | `#9E9484` | くすんだ warm-gray |
| 折り角の面 | `#EAE5DC` | 薄い warm-gray |
| ラベル | `#37352f` | `--text`（warm-black） |
| 種別記号 | `#F76B58` | ブランド coral（`../icon.svg` と同値） |

## 出力（Slack サムネイル）

Slack の image accessory は SVG に対応していないため、`build.sh` で正方形・背景透過の PNG を `apps/web/public/file-types/{html,md,site}.png` に書き出す（256×256、正方形クロップに備えて中央に余白付きで配置）。アイコンを変更したら次のコマンドを実行する。

```sh
bash docs/brand/file-types/build.sh
```

## 使うときの注意

- ラベルの `font-family` にはシステムサンセリフを指定済み（単体表示でも太字で描画される）。
- 色や形を変えるときはこの SVG を編集し、`build.sh` を再実行する（生成された PNG は手で編集しない）。デザイントークンは [`../../reference/design-system.md`](../../reference/design-system.md) を参照。
