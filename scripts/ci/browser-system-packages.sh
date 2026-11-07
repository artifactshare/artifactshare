#!/usr/bin/env bash
set -euo pipefail

source_dir=${1:?source directory required}
destination_dir=${2:?destination directory required}
[[ -d "$source_dir" ]] || exit 0
shopt -s nullglob dotglob
for archive in "$source_dir"/*.deb; do
  [[ -f "$archive" && ! -L "$archive" ]] || continue
  mkdir -p -- "$destination_dir"
  cat -- "$archive" > "$destination_dir/${archive##*/}"
done
