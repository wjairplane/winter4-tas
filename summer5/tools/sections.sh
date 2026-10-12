#!/bin/sh
# Section-by-section improvement of a run, starting from a line that has reached checkpoint k-1.
# For each section, first beam.js guided by the reference run's route (BSEED + BSTOPCP), and
# if that finds no arrival, explore.js (route free). Every result is a clean re-simulation.
# usage: tools/sections.sh <reference.json> <prefix.json> <prefix_frame> <first_target_cp> <outdir>
#   e.g. tools/sections.sh inputs/summer5_opt.json out/seg2.json 35545 3 out
# writes <outdir>/seg<k>.json (+ .t) for k = first..8, then <outdir>/finish.json (+ .t)
set -e
ref=$1; prev=$2; t=$3; k=$4; out=$5
mkdir -p "$out"
cd "$(dirname "$0")/.."
section() {   # $1 = target checkpoint (0 = finish), $2 = output file
  rm -f "$2" "$2.t"
  if [ "$1" -gt 0 ]; then stop="BSTOPCP=$1"; else stop=""; fi
  echo "== beam: $prev at $t ms -> checkpoint $1 (0 = finish)"
  env $stop BSEED="$prev" BSTART="$t" node tools/beam.js "$ref" "$2" || true
  if [ ! -s "$2.t" ] || [ "$(cat "$2.t")" = Infinity ]; then
    rm -f "$2" "$2.t"
    if [ "$1" -gt 0 ]; then stop="STOPCP=$1"; else stop=""; fi
    echo "== explore: $prev at $t ms"
    env $stop START="$prev:$t" MAX_T=$((t + 40000)) LOGEVERY=50 node tools/explore.js "$2" || true
  fi
  [ -s "$2.t" ] && [ "$(cat "$2.t")" != Infinity ] || { echo "== no arrival"; exit 1; }
  prev=$2; t=$(cat "$2.t"); echo "== reached at $t ms -> $2"
}
while [ "$k" -le 8 ]; do section "$k" "$out/seg$k.json"; k=$((k + 1)); done
section 0 "$out/finish.json"
echo "== done: finish $t"
