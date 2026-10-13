#!/bin/sh
# One improvement round: rebuild the route map from every saved run (ours only), then search
# from the start scored by it, capped at the current best time.
# usage: tools/round.sh <workdir> <best_ms> [configs=e60,e50w,e70,e60w]
# reads runs from inputs/ and <workdir>/runs/; writes <workdir>/rN/run.json (+ .t) and copies
# every line it produced into <workdir>/runs/ for the next round's map
set -e
W=$1; BEST=$2; CFG=${3:-e60,e50w,e70,e60w}
cd "$(dirname "$0")/.."
mkdir -p "$W/runs"
n=1; while [ -e "$W/r$n" ]; do n=$((n + 1)); done; R="$W/r$n"; mkdir -p "$R"
runs=$(ls inputs/*.json inputs/sections/*.json "$W"/runs/*.json 2>/dev/null)
echo "== round $n: map from $(echo "$runs" | wc -l) runs"
node tools/navmesh.js "$R/map.json" $runs | tail -3
echo "== round $n: search ($CFG), cap $BEST ms"
EMP="$R/map.json" CONFIGS=$CFG MAX_T=$BEST LOGEVERY=500 node tools/explore.js "$R/run.json" || true
for f in "$R"/run*.json; do cp "$f" "$W/runs/r${n}_$(basename "$f")"; done
echo "== round $n done: $( [ -s "$R/run.json.t" ] && cat "$R/run.json.t" || echo 'no finish' )"
