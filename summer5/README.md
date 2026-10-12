# PolyTrack Summer 5 TAS (from scratch)

A tool-assisted run of **Summer 5** (official track, id `7603aaef…6e52`, game version 0.6.3)
built without anyone else's run. No leaderboard recording was downloaded or used as a seed;
the leaderboard was only looked at for the time to beat.

## Track info (fetched 2026-10-12)

- 8 checkpoints (taken in order), 1,444,439 verified leaderboard entries.
- #1 **49.858s** Wak3son (2026-10-07), #2 49.872 SpeedySebas, #3 49.894 youngfella.

## Result: 1:48.375

`tas-exact.user.js` finishes Summer 5 in **1:48.375**. Verified in the real game (headless
Chromium, submission blocked): `01:48.375`, 8/8 checkpoints. It is a first, unoptimized
route: about twice the #1 time. Improvement cycles come next.

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

## Use

1. Tampermonkey/Violentmonkey → add `tas-exact.user.js`.
2. Open PolyTrack → Official tracks → Summer 5 → Play.
3. Press W once. The TAS drives from there; your own key presses are ignored by the car.

Turn the script off to play normally again (while it's on it drives every track you load).
It submits finished runs to the leaderboard (`ALLOW_SUBMIT = true`); set it to `false` to block that.

## Files

- `inputs/summer5.json` – the run (`[frame_ms, key, pressed]`).
- `tas-exact.user.js` – built from `tas-exact.template.js` by `python3 tools/build_userscript.py`.
- `tools/fetch_sim_assets.sh` – physics worker + wasm and Summer 5 track messages into `sim_assets/`.
- `tools/explore.js` – the from-scratch search (`START`, `MAX_T`, `CONFIGS` options; saves the
  leading line at every new checkpoint).
- `tools/run_headless.js` – runs the userscript in headless Chromium; always blocks submission.
