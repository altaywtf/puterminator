#!/usr/bin/env bash
set -euo pipefail

VERSION=1.7.4
SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
JAR="${XDG_CACHE_HOME:-$HOME/.cache}/tla2tools/tla2tools-$VERSION.jar"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

if [[ ! -f "$JAR" ]]; then
  mkdir -p "$(dirname "$JAR")"
  curl -fsSL -o "$JAR.part" "https://github.com/tlaplus/tlaplus/releases/download/v$VERSION/tla2tools.jar"
  mv "$JAR.part" "$JAR"
fi
echo "$SHA256  $JAR" | shasum -a 256 -c --quiet

java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -deadlock -workers 4 -metadir "$OUT" -config "$HERE/PlanRuns.cfg" "$HERE/PlanRuns.tla"
