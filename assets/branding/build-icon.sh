#!/bin/bash
# macOS packaging only; the source artwork is kept unchanged.
set -euo pipefail
asset_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/yolo-univ-icon.XXXXXX")"
trap 'rm -rf -- "$build_dir"' EXIT
iconset="$build_dir/YOLO-UNIV.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$asset_dir/yolo-univ-icon-source.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  /usr/bin/sips -z "$double" "$double" "$asset_dir/yolo-univ-icon-source.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$iconset" -o "$build_dir/yolo-univ.icns"
/usr/bin/sips -z 1024 1024 "$asset_dir/yolo-univ-icon-source.png" --out "$build_dir/yolo-univ-icon.png" >/dev/null
# Publish only after both conversions succeed.
cp "$build_dir/yolo-univ.icns" "$asset_dir/yolo-univ.icns"
cp "$build_dir/yolo-univ-icon.png" "$asset_dir/yolo-univ-icon.png"
