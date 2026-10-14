#!/bin/sh
# 共通コア（core/*.js）を YTM-Immersion へ写す。YTM 側の manifest / 読み込みの変更は別途。
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)/core"
DST="${1:?usage: tools/sync-core.sh <YTM-Immersion のパス>}/src/js/core"
mkdir -p "$DST"
cp "$SRC"/*.js "$DST"/
echo "core を $DST へ写しました"
