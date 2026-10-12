// Windowed search for a faster Summer 1 run.
//  - Score = "ms ahead of the current best run": candidate position is projected onto the
//    best run's per-frame racing line, giving sub-millisecond resolution anywhere on track.
//  - A candidate edited at frame T is first simulated only to T + WINDOW (cheap filter);
//    promising ones are then simulated up to just before the finish (TF) and accepted only
//    if they are ahead there, so a misleading short-window score can't be accepted.
// usage: node tools/optimize2.js [minutes=10] [in=inputs/summer1_opt.json] [out=inputs/summer1_opt.json]
const { fork } = require('child_process'), fs = require('fs');
const { createSim, decodePos } = require('./sim.js');
const KEY = { KeyW: 'up', KeyD: 'right', KeyS: 'down', KeyA: 'left', Reset: 'reset' };
const NAME = Object.fromEntries(Object.entries(KEY).map(([a, b]) => [b, a]));
const WINDOW = 1500, FINISH_MARGIN = 5, NK = 4, PER_KID = 16, FULL_CHECKS = 8;

if (process.argv[2] === 'child') {
  (async () => {
    const sim = await createSim();
    await sim.initFast();
    process.send({ ready: true });
    process.on('message', async m => {
      const r = m.op === 'setBase' ? await sim.setBase(m.L, m.cap) : await sim.evalFrom(m.L, m.from, m.cap);
      const out = { id: m.id, frames: r.frames, fin: r.fin, pos: r.pos, speed: r.speed };
      if (m.op === 'setBase' && m.wantRef) { out.P = Array.from(r.P); out.V = Array.from(r.V); }
      process.send(out);
    });
  })();
  return;
}

const minutes = +(process.argv[2] || 10);
const inFile = process.argv[3] || 'inputs/summer1_opt.json', outFile = process.argv[4] || 'inputs/summer1_opt.json';
const lists = { up: [], right: [], down: [], left: [], reset: [] };
for (const [f, k] of JSON.parse(fs.readFileSync(inFile))) lists[KEY[k]].push(f);
for (const k in lists) lists[k].sort((a, b) => a - b);
const clone = L => Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.slice()]));
const rnd = n => Math.floor(Math.random() * n), pick = a => a[rnd(a.length)];
const valid = L => ['up', 'right', 'down', 'left'].every(k => L[k].every((f, i) => f >= 1 && (i === 0 || f > L[k][i - 1])) || (k === 'up' && L.up[0] === 0));

function mutate(L) {
  const M = clone(L), r = Math.random();
  const k = Math.random() < 0.05 ? 'up' : pick(['right', 'left', 'down']), l = M[k];
  const d = pick([-1, 1, -2, 2, -3, 3, -5, 5, -8, 8, -13, 13, -21, 21, -34, 34]);
  if (k === 'up') {                                              // try a brief throttle lift
    if (r < 0.5 && l.length > 1) { const i = 1 + rnd(l.length - 1); l[i] += d; }
    else { const t = 200 + rnd(21500), w = 5 + rnd(40); l.push(t, t + w); l.sort((a, b) => a - b); }
  } else if (!l.length || r < 0.08) {                              // add a tap
    const t = 200 + rnd(21500), w = 10 + rnd(60); l.push(t, t + w); l.sort((a, b) => a - b);
  } else {
    const i = rnd(l.length);
    if (r < 0.6) l[i] += d;                                       // move one edge
    else if (r < 0.85) { const j = i ^ 1; if (j < l.length) { l[i] += d; l[j] += d; } } // move a tap
    else if (l.length > 2) { const j = i - (i % 2); l.splice(j, 2); }                   // drop a tap
  }
  return valid(M) ? M : null;
}
const firstDiff = (A, B) => {
  let m = Infinity;
  for (const k of ['up', 'right', 'down', 'left']) {
    const n = Math.max(A[k].length, B[k].length);
    for (let i = 0; i < n; i++) if (A[k][i] !== B[k][i]) { m = Math.min(m, A[k][i] ?? Infinity, B[k][i] ?? Infinity); break; }
  }
  return m;
};
const toEvents = L => {
  const ev = []; for (const k of ['up', 'right', 'down', 'left']) L[k].forEach((f, i) => ev.push([f, NAME[k], i % 2 === 0]));
  return ev.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
};

(async () => {
  const kids = [];
  for (let i = 0; i < NK; i++) { const c = fork(__filename, ['child']); await new Promise(r => c.once('message', r)); kids.push(c); }
  let nextId = 0; const pending = new Map();
  kids.forEach(c => c.on('message', m => { const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } }));
  const send = (c, m) => new Promise(res => { const id = nextId++; pending.set(id, res); c.send({ id, ...m }); });

  // reference = current best run, per-frame positions/speeds
  let best = lists, P, V, finish, TF;
  async function rebase() {
    const rs = await Promise.all(kids.map((c, i) => send(c, { op: 'setBase', L: best, cap: 30000, wantRef: i === 0 })));
    P = rs[0].P; V = rs[0].V; finish = rs[0].frames; TF = finish - FINISH_MARGIN;
  }
  // ms ahead of the reference at frame T (positive = ahead), sub-frame via segment projection
  function ahead(p, T) {
    let bestD = Infinity, bestT = T;
    const lo = Math.max(0, T - 150), hi = Math.min(finish - 1, T + 150);
    for (let j = lo; j < hi; j++) {
      const ax = P[3 * j], ay = P[3 * j + 1], az = P[3 * j + 2];
      const bx = P[3 * j + 3] - ax, by = P[3 * j + 4] - ay, bz = P[3 * j + 5] - az;
      const L2 = bx * bx + by * by + bz * bz || 1e-12;
      let u = ((p[0] - ax) * bx + (p[1] - ay) * by + (p[2] - az) * bz) / L2; u = Math.max(0, Math.min(1, u));
      const dx = ax + u * bx - p[0], dy = ay + u * by - p[1], dz = az + u * bz - p[2], d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; bestT = j + u; }
    }
    return { ms: bestT - T, off: Math.sqrt(bestD) };
  }
  const score = (r, T) => {
    if (r.fin) return 1000 + (T - r.frames);                       // finished early: clearly better
    const a = ahead(r.pos, T);
    if (a.off > 8) return -1e9;                                    // far from the racing line: no reliable match
    const vr = V[Math.min(V.length - 1, Math.round(T + a.ms))] || r.speed;
    if (process.env.DEBUG2) console.log("   T", T, "ms", a.ms.toFixed(3), "off", a.off.toFixed(3), "v", r.speed.toFixed(1), "vr", vr.toFixed(1));
    return a.ms + ((r.speed - vr) / Math.max(vr, 1)) * 300;        // lead + 300 ms of projected speed gain
  };

  await rebase();
  const startFinish = finish;
  console.log('start finish frames', finish);
  const t0 = Date.now(); let rounds = 0, accepted = 0, gain = 0, windowEvals = 0, fullEvals = 0;
  while (Date.now() - t0 < minutes * 60000) {
    rounds++;
    const cands = [];
    while (cands.length < NK * PER_KID) {
      const m = mutate(best); if (!m) continue;
      const from = firstDiff(best, m); if (from >= TF) continue;
      cands.push({ m, from, stop: Math.min(TF, from + WINDOW) });
    }
    const rs = await Promise.all(cands.map((c, i) => send(kids[i % NK], { op: 'eval', L: c.m, from: c.from, cap: c.stop })));
    windowEvals += rs.length;
    rs.forEach((r, i) => { cands[i].ws = score(r, cands[i].stop); if (!r.fin) cands[i].off = ahead(r.pos, cands[i].stop).off; else cands[i].off = 0; });
    if (process.env.DEBUG && rounds <= 3) { const w = cands.map(c => c.ws).sort((a, b) => b - a); console.log('ws top', w.slice(0, 5).map(x => x.toFixed(3)).join(' '), 'median', w[w.length >> 1].toFixed(3), 'bad', w.filter(x => x < -1e8).length); }
    // window gains of several ms are artefacts (track-matching errors / unstable lines)
    const prom = cands.filter(c => c.ws > 0.01 && c.ws < 3 && c.off < 1).sort((a, b) => b.ws - a.ws).slice(0, FULL_CHECKS);
    if (!prom.length) continue;
    const fr = await Promise.all(prom.map((c, i) => c.stop === TF ? Promise.resolve(null) : send(kids[i % NK], { op: 'eval', L: c.m, from: c.from, cap: TF })));
    fullEvals += fr.filter(Boolean).length;
    prom.forEach((c, i) => c.fs = fr[i] ? score(fr[i], TF) : c.ws);
    if (process.env.DEBUG) console.log('  full', prom.map(c => c.ws.toFixed(3) + '->' + c.fs.toFixed(3)).join(' '));
    const win = prom.filter(c => c.fs > 0.001).sort((a, b) => b.fs - a.fs)[0];
    if (!win) continue;
    const prev = best, prevFinish = finish;
    best = win.m;
    await rebase();
    if (finish > prevFinish) { best = prev; await rebase(); console.log('  rejected: real finish got worse'); continue; }  // safety net
    accepted++; gain += Math.min(win.fs, 1000);
    fs.writeFileSync(outFile, JSON.stringify(toEvents(best)));
    console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] +${win.fs.toFixed(3)} ms -> est. total gain ${gain.toFixed(3)} ms, finish frames ${finish}`);
  }
  console.log(`done: ${rounds} rounds, ${windowEvals} window evals, ${fullEvals} full evals, ${accepted} accepted; finish ${startFinish} -> ${finish}`);
  kids.forEach(c => c.kill()); process.exit(0);
})();
