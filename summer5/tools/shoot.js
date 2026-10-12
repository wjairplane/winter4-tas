// Random-input search from a saved line: tries N random input sequences from <frame> and keeps
// the one that reaches a target point earliest (within <radius> m), or else gets closest to it.
// For spots the beam/explorer searches cannot find on their own (a tunnel entrance, a ramp jump).
// usage: node tools/shoot.js <prefix.json> <frame> <horizon_ms> <tries> <x,y,z> <radius> <out.json>
//   prefix: an event list or a beam.js BDUMP file; out: events of prefix + best sequence up to
//   the arrival (out.t holds the arrival frame)
const { createSim } = require('./sim.js'), fs = require('fs');
const NAME = { 1: 'KeyW', 2: 'KeyD', 4: 'KeyS', 8: 'KeyA' }, KB = { KeyW: 1, KeyD: 2, KeyS: 4, KeyA: 8 };
const [file, C, H, N, tgt, R, out] = process.argv.slice(2).map((a, i) => [1, 2, 3, 5].includes(i) ? +a : a);
const T = tgt.split(',').map(Number);

function prefixBits(f, upTo) {              // per-frame key bits of the prefix, frames 0..upTo-1
  const saved = JSON.parse(fs.readFileSync(f));
  if (!Array.isArray(saved)) return saved.bits.slice(0, upTo);
  const ev = saved.slice().sort((a, b) => a[0] - b[0]), bits = []; let b = 0, i = 0;
  for (let fr = 0; fr < upTo; fr++) { while (i < ev.length && ev[i][0] <= fr) { b = ev[i][2] ? b | KB[ev[i][1]] : b & ~KB[ev[i][1]]; i++; } bits.push(b); }
  return bits;
}
function listsOf(bits) {                    // per-frame bits -> toggle lists for the simulator
  const L = { up: [], right: [], down: [], left: [], reset: [] }, K = { 1: 'up', 2: 'right', 4: 'down', 8: 'left' };
  for (const bit of [1, 2, 4, 8]) { let on = false; bits.forEach((b, f) => { const w = !!(b & bit); if (w !== on) { L[K[bit]].push(f); on = w; } }); }
  return L;
}

(async () => {
  const sim = await createSim(); await sim.initFast();
  const pre = prefixBits(file, C);
  await sim.setBase(listsOf(pre), C);          // snapshots up to C: each try resumes from there
  let best = null;
  for (let n = 0; n < N; n++) {
    const bits = pre.slice();
    while (bits.length < C + H) { const b = Math.floor(Math.random() * 16), len = 40 + Math.floor(Math.random() * 360); for (let k = 0; k < len; k++) bits.push(b); }
    bits.length = C + H;
    const r = await sim.evalFrom(listsOf(bits), C, C + H, 20);
    let hit = null, minD = Infinity;
    for (let i = 0; i < r.S.length; i += 4) { const d = Math.hypot(r.S[i + 1] - T[0], r.S[i + 2] - T[1], r.S[i + 3] - T[2]); if (d < minD) minD = d; if (d <= R && hit === null) hit = r.S[i]; }
    const score = hit !== null ? hit : 1e9 + minD;
    if (!best || score < best.score) { best = { score, hit, minD, bits: hit !== null ? bits.slice(0, hit) : bits }; console.log(`try ${n}: ${hit !== null ? 'reached at ' + hit : 'closest ' + minD.toFixed(1) + ' m'}`); }
  }
  const ev = [], on = {}; best.bits.forEach((b, f) => { for (const bit of [1, 2, 4, 8]) { const w = !!(b & bit); if (w !== !!on[bit]) { ev.push([f, NAME[bit], w]); on[bit] = w; } } });
  fs.writeFileSync(out, JSON.stringify(ev)); fs.writeFileSync(out + '.t', String(best.hit ?? best.bits.length));
  console.log(best.hit !== null ? `best: reached at ${best.hit} -> ${out}` : `best: closest ${best.minD.toFixed(1)} m (not reached) -> ${out}`);
  process.exit(0);
})();
