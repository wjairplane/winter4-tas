#!/usr/bin/env python3
"""Fetch a PolyTrack leaderboard recording and convert it to TAS inputs.

usage: fetch_replay.py [rank=1] [out=inputs/winter4.json]

Recording format (from the game's bundle): zlib data holding 5 lists
(up, right, down, left, reset); each is a 3-byte LE count followed by 3-byte LE
deltas. Cumulative values are frames where that key toggles. 1 frame = 1 ms.
"""
import base64, json, sys, urllib.request, zlib

TRACK = "7d134c939df80c676a258266201beedd3b93572d5603f3ff4339ff8679803715"  # Winter 4
BASE = "https://vps.kodub.com/v6/"
HDRS = {"Origin": "https://app-polytrack.kodub.com",
        "Referer": "https://app-polytrack.kodub.com/",
        "User-Agent": "Mozilla/5.0"}
KEYS = ["KeyW", "KeyD", "KeyS", "KeyA", "Reset"]  # up, right, down, left, reset


def get(path):
    req = urllib.request.Request(BASE + path, headers=HDRS)
    return json.load(urllib.request.urlopen(req, timeout=30))


def parse(buf):
    pos, lists = 0, []
    for _ in range(5):
        n = int.from_bytes(buf[pos:pos + 3], "little")
        vals, acc = [], 0
        for i in range(n):
            d = int.from_bytes(buf[pos + 3 + 3 * i:pos + 6 + 3 * i], "little")
            acc = d if i == 0 else acc + d
            vals.append(acc)
        lists.append(vals)
        pos += 3 + 3 * n
    return lists


def main():
    rank = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    out = sys.argv[2] if len(sys.argv) > 2 else "inputs/winter4.json"
    lb = get(f"leaderboard?version=0.6.3&trackId={TRACK}&skip={rank-1}&amount=1&onlyVerified=true")
    e = lb["entries"][0]
    rec = get(f"recordings?version=0.6.3&ids={e['id']}")[0]["recording"]
    raw = zlib.decompress(base64.urlsafe_b64decode(rec + "=" * (-len(rec) % 4)))
    events = []
    for key, frames in zip(KEYS, parse(raw)):
        for i, f in enumerate(frames):
            events.append([f, key, i % 2 == 0])  # toggles alternate press/release
    events.sort(key=lambda x: (x[0], x[1]))
    json.dump(events, open(out, "w"), separators=(",", ":"))
    print(f"rank {rank}: {e['nickname']} id={e['id']} {e['frames']/1000:.3f}s "
          f"-> {len(events)} events -> {out}")
    if any(ev[1] == "Reset" for ev in events):
        print("note: run contains Reset presses (kept as 'Reset' events)")


main()
