// Systematic sweep of the wall-ride around checkpoint 1.
// The wall-ride is described by a few presses in the reference run:
//   D (steer right into the wall): press/release      ~3.40 s / 3.91 s
//   S (brake tap at the wall):     start/length       ~3.83 s / 49 ms (or none)
//   A (come off the wall, down the ramp): press/release ~4.06 s / 5.27 s
// Each sweep varies one press (2D grid of start x end/length) with the others fixed, keeps the
// best, then the next sweep runs; a second round repeats with finer steps around the best.
// Scoring (same as tools/segment.js, which provides the evaluator): run to W1, measure the lead
// over the reference, continue with the reference inputs shifted by that lead, score by when
// (and how fast) checkpoint 2 is collected: fitness = ms earlier than the reference (+ speed bonus).
// usage: node tools/wallride.js <ref.json> <out.json> [W1=6000] [NK=4]
const { fork } = require('child_process'), fs = require('fs'), path = require('path');
const KEY = { KeyW: 'up', KeyD: 'right', KeyS: 'down', KeyA: 'left', Reset: 'reset' };
const NAME = Object.fromEntries(Object.entries(KEY).map(([a, b]) => [b, a]));
const KEYS = ['up', 'right', 'down', 'left'];
const [refFile, outFile, w1Arg, nkArg] = process.argv.slice(2);
const W1 = +(w1Arg || 6000), NK = +(nkArg || 4);
const load = f => { const L = { up: [], right: [], down: [], left: [], reset: [] }; for (const [fr, k] of JSON.parse(fs.readFileSync(f))) L[KEY[k]].push(fr); for (const k in L) L[k].sort((a, b) => a - b); return L; };
const toEvents = L => { const ev = []; for (const k of KEYS) L[k].forEach((f, i) => ev.push([f, NAME[k], i % 2 === 0])); return ev.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])); };
const range = (a, b, s) => { const r = []; for (let x = a; x <= b + 1e-9; x += s) r.push(Math.round(x)); return r; };

// find a press (on/off pair) of key k whose start lies in [lo, hi]
function findPress(L, k, lo, hi) { const l = L[k]; for (let i = 0; i + 1 < l.length; i += 2) if (l[i] >= lo && l[i] <= hi) return [l[i], l[i + 1]]; return null; }
// rebuild the reference with the wall-ride presses replaced by params p
function build(ref, base, p) {
  const L = Object.fromEntries(Object.entries(ref).map(([k, v]) => [k, v.slice()]));
  const drop = (k, pr) => { if (pr) L[k] = L[k].filter(f => f !== pr[0] && f !== pr[1]); };
  drop('right', base.D); drop('down', base.S); drop('left', base.A);
  L.right.push(p.Don, p.Doff); if (p.Slen > 0) L.down.push(p.Son, p.Son + p.Slen); L.left.push(p.Aon, p.Aoff);
  for (const k of KEYS) L[k].sort((a, b) => a - b);
  for (const k of KEYS) for (let i = 1; i < L[k].length; i++) if (L[k][i] <= L[k][i - 1]) return null;   // overlapping presses
  return L;
}

(async () => {
  const ref = load(refFile);
  const base = { D: findPress(ref, 'right', 3300, 3600), S: findPress(ref, 'down', 3700, 4000), A: findPress(ref, 'left', 3950, 4300) };
  if (!base.D || !base.A) throw new Error('could not find the wall-ride presses in the reference: ' + JSON.stringify(base));
  let p = { Don: base.D[0], Doff: base.D[1], Son: base.S ? base.S[0] : 3830, Slen: base.S ? base.S[1] - base.S[0] : 0, Aon: base.A[0], Aoff: base.A[1] };
  console.log('reference wall-ride:', JSON.stringify(p));

  const kids = [];
  for (let i = 0; i < NK; i++) { const c = fork(path.join(__dirname, 'segment.js'), ['child'], { serialization: 'advanced' }); await new Promise(r => c.once('message', r)); kids.push(c); }
  let nextId = 0, rr = 0; const pending = new Map();
  kids.forEach(c => c.on('message', m => { const q = pending.get(m.id); if (q) { pending.delete(m.id); q(m); } }));
  const send = (c, m) => new Promise(res => { const id = nextId++; pending.set(id, res); c.send({ id, ...m }); });
  const info = (await Promise.all(kids.map(c => send(c, { op: 'init', ref, target: 2 }))))[0];
  console.log(`reference collects checkpoint 2 at frame ${info.refCp}`);
  const cache = new Map();
  const evalP = async q => {
    const k = JSON.stringify(q); if (cache.has(k)) return cache.get(k);
    const L = build(ref, base, q); if (!L) { cache.set(k, { fit: -Infinity }); return cache.get(k); }
    const r = await send(kids[rr++ % NK], { op: 'eval', L, w1: W1, target: 2 });
    const out = { fit: r.fit, arrival: r.arrival, lead: r.lead, full: r.full }; cache.set(k, out); return out;
  };
  let cur = await evalP(p);
  console.log(`baseline fitness ${cur.fit.toFixed(2)} (checkpoint 2 at ${cur.arrival})`);
  const report = [];
  async function sweep(name, xs, ys, set) {
    const grid = []; for (const x of xs) for (const y of ys) grid.push([x, y]);
    const res = await Promise.all(grid.map(([x, y]) => evalP(set({ ...p }, x, y))));
    let bi = -1; res.forEach((r, i) => { if (bi < 0 || r.fit > res[bi].fit) bi = i; });
    const ok = res.filter(r => r.arrival != null).length;
    const [bx, by] = grid[bi], before = cur.fit;
    if (res[bi].fit > cur.fit) { p = set({ ...p }, bx, by); cur = res[bi]; }
    const line = `${name}: ${grid.length} tries, ${ok} reached checkpoint 2; best ${JSON.stringify(set({}, bx, by))} fitness ${res[bi].fit.toFixed(2)} (was ${before.toFixed(2)})`;
    console.log(line); report.push({ name, tries: grid.length, reached: ok, best: set({}, bx, by), fit: res[bi].fit,
      // per-value profile along x (best over y), to show how sensitive the timing is
      profile: xs.map(x => { let m = -Infinity; grid.forEach(([gx], i) => { if (gx === x) m = Math.max(m, res[i].fit); }); return [x, +m.toFixed(2)]; }) });
    fs.writeFileSync(outFile, JSON.stringify(toEvents(cur.full)));
  }
  for (const [round, step, span] of [[1, 10, 1], [2, 2, 0]]) {
    const near = (c, w) => range(c - w, c + w, step);
    // D press: start x end
    await sweep(`round ${round} D press`, round === 1 ? range(3300, 3550, step) : near(p.Don, 20), round === 1 ? range(3800, 4050, step) : near(p.Doff, 20), (q, x, y) => Object.assign(q, { Don: x, Doff: y }));
    // S tap: none, or start x length
    await sweep(`round ${round} S tap`, round === 1 ? range(3750, 3950, step) : near(p.Son, 20), round === 1 ? [0, 10, 20, 30, 40, 50, 60, 80, 100] : range(Math.max(0, p.Slen - 10), p.Slen + 10, 2), (q, x, y) => Object.assign(q, { Son: x, Slen: y }));
    // A press: start x end
    await sweep(`round ${round} A press`, round === 1 ? range(3950, 4250, step) : near(p.Aon, 20), round === 1 ? range(5000, 5500, 20) : near(p.Aoff, 20), (q, x, y) => Object.assign(q, { Aon: x, Aoff: y }));
  }
  console.log('best wall-ride:', JSON.stringify(p), `fitness ${cur.fit.toFixed(2)}, checkpoint 2 at ${cur.arrival} (reference ${info.refCp})`);
  fs.writeFileSync(outFile.replace(/\.json$/, '_report.json'), JSON.stringify({ reference: info.refCp, best: p, fit: cur.fit, arrival: cur.arrival, sweeps: report }, null, 1));
  kids.forEach(c => c.kill()); process.exit(0);
})();
