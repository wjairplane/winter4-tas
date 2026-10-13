#!/bin/sh
# Re-search the end of the best lap from just before each of its crashes, latest first.
# The lap is kept exactly up to the restart point; explore.js (scored by the route map) searches
# the rest, capped at the current best time. Every faster finish becomes the new best, and later
# restarts use it.
# usage: tools/tails.sh <best.json> <best_ms> <map.json> <workdir> <restart_ms>...
#   e.g. tools/tails.sh inputs/summer5_opt.json 65088 out/map.json out/tails 54000 41000 26500 13500
set -e
best=$1; bt=$2; map=$3; W=$4; shift 4
cd "$(dirname "$0")/.."
mkdir -p "$W"
for T in "$@"; do
  for pen in 0 0.2; do
    out="$W/tail_${T}_pen${pen}.json"
    echo "== restart at $T ms (crash penalty $pen), best $bt ms"
    START="$best:$T" EMP="$map" CRASHPEN=$pen MAX_T=$bt CONFIGS=e70,e75,e80,e70w LOGEVERY=500 node tools/explore.js "$out" || true
    if [ -s "$out.t" ] && [ "$(cat "$out.t")" != Infinity ] && [ "$(cat "$out.t")" -lt "$bt" ]; then
      bt=$(cat "$out.t"); best=$out; echo "== improved: $bt ms -> $out"
    fi
  done
done
echo "== done: best $bt ms -> $best"
