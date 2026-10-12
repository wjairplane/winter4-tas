#!/bin/sh
# Downloads the game's physics worker + wasm into sim_assets/ (not committed), then captures
# the track/Init messages the worker needs (tools/capture_msgs.js, needs playwright).
set -e
B=https://app-polytrack.kodub.com/0.6.3
mkdir -p sim_assets
curl -sSf $B/simulation_worker.bundle.js -o sim_assets/worker.js
curl -sSf $B/lib/polytrack_physics.js -o sim_assets/polytrack_physics.js
curl -sSf $B/polytrack_physics.wasm -o sim_assets/polytrack_physics.wasm
node "$(dirname "$0")/capture_msgs.js" sim_assets
