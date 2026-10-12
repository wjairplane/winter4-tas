#!/bin/sh
# Section-by-section search: each section starts from the best line into the previous
# checkpoint and searches (route free, tools/explore.js) for the earliest arrival at the next.
# usage: tools/segments.sh <prefix.json> <prefix_frame> <first_target_cp> <outdir>
#   e.g. tools/segments.sh out/explore_cp1_e50.json 7800 2 out/seg
# writes <outdir>/seg<k>.json (+ .t) for k = first..8, then <outdir>/finish.json (+ .t)
set -e
prev=$1; t=$2; k=$3; out=$4
mkdir -p "$out"
cd "$(dirname "$0")/.."
while [ "$k" -le 8 ]; do
  echo "== section to checkpoint $k from $prev at $t ms"
  START="$prev:$t" STOPCP=$k MAX_T=$((t + 40000)) LOGEVERY=50 node tools/explore.js "$out/seg$k.json"
  prev="$out/seg$k.json"; t=$(cat "$prev.t"); k=$((k + 1))
done
echo "== section to the finish from $prev at $t ms"
START="$prev:$t" MAX_T=$((t + 40000)) LOGEVERY=50 node tools/explore.js "$out/finish.json"
echo "== done: finish $(cat "$out/finish.json.t")"
