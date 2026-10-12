# PolyTrack Winter 4 TAS

Tool-assisted run of **Winter 4** (official track, id `7d134c93…3715`) in
https://www.kodub.com/apps/polytrack, game version 0.6.3. Built the same way as
[summer1-tas](https://github.com/wjairplane/summer1-tas).

## Track info (fetched 2026-10-12)

- 4 checkpoints, 859,825 leaderboard entries (verified only).
- #1 **19.311s** SpeedySebas (2026-07-22), #2 19.380 xtuov, #3/#4 19.383 Swirls / The Kroger,
  #5 19.388 LanceB_YT. The #1 run is 69 ms clear of everyone else.

## Result: 19.308s

`tas-exact.user.js` finishes Winter 4 in **19.308s**, 3 ms faster than the #1 run (19.311s).
Verified in the real game (headless Chromium, submission blocked): `00:19.308`, 4/4 checkpoints.

Found with `tools/evolve.js` seeded from the #1 run, in under a minute. It changed two
inputs: the brake (S) tap at 12.723s now starts at 12.707s, and the right-steer (D) tap at
18.313s now starts at 18.305s. The search was stopped at the first time under 19.311.
`tas-replay.user.js` replays the unmodified #1 run (also verified: 19.311s, 4/4).

## Use

`tas-exact.user.js` patches PolyTrack's physics worker so the inputs are applied on
exact 1 ms simulation frames (browser key timing can't do that). It has to run before
the game loads, so install it as a userscript:

1. Tampermonkey/Violentmonkey → add `tas-exact.user.js` (runs at document-start on
   `app-polytrack.kodub.com`).
2. Open PolyTrack, go to Official tracks → Winter 4 → Play.
3. Press W once. The TAS drives from there; your own key presses are ignored by the car.

Turn the script off to play normally again (while it's on it drives every track you load).

**Leaderboard:** the userscript submits finished runs to the leaderboard as usual
(`ALLOW_SUBMIT = true` at the top of the script). Set it to `false` to block submission;
the game then shows "Failed to connect to server" after the finish.

## Files

- `inputs/winter4.json` – #1 run (19.311s), decoded from the leaderboard (`[frame_ms, key, pressed]`).
- `inputs/winter4_opt.json` – optimized run found by the search tools.
- `tas-exact.user.js` – the 19.308s userscript; `tas-replay.user.js` – the #1 replay (both built from `tas-exact.template.js` by
  `python3 tools/build_userscript.py [inputs] [out]`).
- `tools/fetch_replay.py [rank] [out]` – downloads and decodes a Winter 4 leaderboard recording.
- `tools/run_headless.js [userscript]` – runs the userscript on Winter 4 in headless Chromium
  (`npm i playwright`), prints the final time and checkpoints. It always blocks submission (forces
  `ALLOW_SUBMIT = false` and aborts leaderboard POSTs).
- `tools/fetch_sim_assets.sh` – downloads the physics worker + wasm and captures the Winter 4
  track messages into `sim_assets/` for the offline simulator (`tools/sim.js`).
- `tools/evolve.js`, `optimize*.js`, `beam.js`, `segment.js` – search tools from summer1-tas,
  run against the game's own physics offline in Node.

## Notes

- Patching depends on game version 0.6.3. If the game updates, the script logs
  `patch anchor not found` and runs unpatched.
