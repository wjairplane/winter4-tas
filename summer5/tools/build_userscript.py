#!/usr/bin/env python3
"""Embed TAS inputs into tas-exact.template.js.

usage: build_userscript.py [in=inputs/summer5.json] [out=tas-exact.user.js]
"""
import json
import sys

KEYS = {"KeyW": "up", "KeyD": "right", "KeyS": "down", "KeyA": "left", "Reset": "reset"}
src = sys.argv[1] if len(sys.argv) > 1 else "inputs/summer5.json"
out = sys.argv[2] if len(sys.argv) > 2 else "tas-exact.user.js"
ev = json.load(open(src))
sched = [[f, KEYS[k], d] for f, k, d in ev]
tpl = open("tas-exact.template.js").read()
tpl = tpl.replace("/*SRC*/", src).replace("/*SCHED*/[]", json.dumps(sched, separators=(",", ":")))
open(out, "w").write(tpl)
print(f"wrote {out} ({len(sched)} events)")
