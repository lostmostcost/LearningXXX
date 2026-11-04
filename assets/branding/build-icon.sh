#!/bin/bash
# macOS packaging only; the source artwork is kept unchanged.
# WBS-099: the source is redrawn on the macOS icon grid first (transparent 1024
# canvas, 824 px squircle body, soft shadow) by make-macos-icon.swift; every
# size below is derived from that master.
set -euo pipefail
asset_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/yolo-univ-icon.XXXXXX")"
trap 'rm -rf -- "$build_dir"' EXIT
master="$build_dir/yolo-univ-icon.png"
/usr/bin/swift "$asset_dir/make-macos-icon.swift" "$asset_dir/yolo-univ-icon-source.png" "$master"
iconset="$build_dir/YOLO-UNIV.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$master" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  /usr/bin/sips -z "$double" "$double" "$master" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$iconset" -o "$build_dir/yolo-univ.icns"
# Publish only after both conversions succeed.
cp "$build_dir/yolo-univ.icns" "$asset_dir/yolo-univ.icns"
cp "$master" "$asset_dir/yolo-univ-icon.png"
