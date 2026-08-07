#!/usr/bin/env bash
# ファイル種別アイコンの Slack 配信用 PNG を生成する。
#
# 単一ソース: docs/brand/file-types/{html,md,site}.svg (160x180)
# 出力:       apps/web/public/file-types/{html,md,site}.png
#             256x256・背景透過・アイコンを中央に padding 付きで中央配置
#             (Slack の section accessory が正方形クロップしても見切れない)。
#
# アイコンを変えたら docs/brand/file-types/*.svg を直してこれを実行する。
# PNG は手編集しない (ソースと配信がドリフトするため)。rsvg-convert が要る。
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
out="$root/apps/web/public/file-types"
mkdir -p "$out"

# 256 キャンバス内のアイコン配置 (中 padding)。160:180 の縦長を中央へ。
x=75
y=68
w=107
h=120

for t in html md site; do
  # 外側 <svg> タグを外して中身だけ取り出す。reformat 等で空になったら
  # 黙って空アイコンを吐かないよう、ここで止める。
  inner="$(sed '1d;$d' "$here/$t.svg")"
  if [ -z "$inner" ]; then
    echo "error: extracted no inner SVG from $t.svg (reformatted to one line?)" >&2
    exit 1
  fi
  # 正方形・透過キャンバスの中央へ padding 付きで置いて rasterize。stdin
  # 経由なので一時ファイルを作らない (rsvg-convert は入力無指定で stdin を読む)。
  rsvg-convert -w 256 -h 256 -o "$out/$t.png" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <svg x="$x" y="$y" width="$w" height="$h" viewBox="0 0 160 180">
$inner
  </svg>
</svg>
SVG
done

echo "wrote $out/{html,md,site}.png"
