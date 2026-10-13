# PolyTrack Summer 5 TAS (from scratch)

A tool-assisted run of **Summer 5** (official track, id `7603aaef…6e52`, game version 0.6.3)
built without anyone else's run. No leaderboard recording was downloaded or used as a seed;
the leaderboard was only looked at for the time to beat.

## Track info (fetched 2026-10-12)

- 8 checkpoints (taken in order), 1,444,439 verified leaderboard entries.
- #1 **49.858s** Wak3son (2026-10-07), #2 49.872 SpeedySebas, #3 49.894 youngfella.

## Result: 1:03.953

`tas-exact.user.js` finishes Summer 5 in **1:03.953**. Verified in the real game (headless
Chromium, submission blocked): `01:03.953`, 8/8 checkpoints. The #1 time is 49.858s, so this
is about 15 s off, and 43 s faster than the first route.
`tas-first-route.user.js` is the first from-scratch route (1:48.375).

### How it was found

1. `tools/track_info.js` dumps the track's parts, checkpoints and start from the game's own
   physics worker.
2. `tools/explore.js` grows a run forward from the start with the game's physics (offline).
   Progress is distance along the track to the next checkpoint, from a graph of the track's
   parts (Dijkstra per checkpoint; links through solid blocks cost +400 m). Each step keeps the
   best states, one per (cell, heading) bin, and states in the least-visited cells.
   It reached checkpoint 7 at 98.7 s, then stalled at a narrow tunnel entrance.
3. A random-input search from 96.0 s (3,000 tries) found a way into the tunnel.
4. `explore.js` from inside the tunnel (`START=…:100000`) reached the finish: 108.375 s.

### Improvement log

| Cycle | Method | Time |
|---|---|---|
| 0 | explore.js from the start + tunnel random search + explore.js to the finish | 1:48.375 |
| 1 | `evolve.js`, 30 min (19 reference updates) | 1:48.283 |
| 2 | beam search guided by the 1:48.283 run, and section-by-section search: faster checkpoint times (e.g. checkpoint 6 at 66.0 s vs 77.3 s) but no faster full lap | — |
| 3 | route map from all 85 of our own saved runs (`tools/navmesh.js`), then `explore.js EMP=...` from the start, scored by the fastest known time-to-go | 1:20.057 |
| 4 | round 1 (`tools/round.sh`): map rebuilt with the 1:20.057 lap (108 runs), e60 variants; e70 won | 1:05.112 |
| 5 | round 2 (map with the 1:05.112 lap): behind at every checkpoint, stopped; `evolve.js` 30 min on 1:05.112 | 1:05.088 |
| 6 | crash penalty in the score (round 4): avoided the checkpoint-2 wall hit but 3.5-5 s slower, stopped; `tools/tails.sh`: keep the lap to 54.0 s (before the tunnel crash), re-search the rest | **1:03.953** |

## Use

1. Tampermonkey/Violentmonkey → add `tas-exact.user.js`.
2. Open PolyTrack → Official tracks → Summer 5 → Play.
3. Press W once. The TAS drives from there; your own key presses are ignored by the car.

Turn the script off to play normally again (while it's on it drives every track you load).
It submits finished runs to the leaderboard (`ALLOW_SUBMIT = true`); set it to `false` to block that.

## Files

- `inputs/summer5.json` – the first run (1:48.375); `inputs/summer5_opt.json` – the current best, 1:03.953 (`[frame_ms, key, pressed]`).
- `inputs/sections/` – faster lines to individual checkpoints found along the way.
- `tools/navmesh.js` – builds the route map from saved runs; `tools/shoot.js` – random-input search toward a point.
- `tas-exact.user.js` – built from `tas-exact.template.js` by `python3 tools/build_userscript.py`.
- `tools/fetch_sim_assets.sh` – physics worker + wasm and Summer 5 track messages into `sim_assets/`.
- `tools/explore.js` – the from-scratch search (`START`, `MAX_T`, `CONFIGS` options; saves the
  leading line at every new checkpoint).
- `tools/run_headless.js` – runs the userscript in headless Chromium; always blocks submission.
