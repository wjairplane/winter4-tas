// Evolutionary search (population + selection + mutation + crossover), in the spirit of
// Theo Jansen's Strandbeest leg search. Unlike optimize2/3 (keep one best, judge each
// candidate once), a population lets promising-but-unfinished lines survive and get
// repaired over generations.
//  - Fitness is measured on the run up to just before the finish (TF):
//      stays on the racing line -> "ms ahead of the reference" at TF (sub-ms),
//      leaves the line at frame T -> heavy penalty minus how much track is left,
//    so crashing later is better than crashing earlier (a gradient to repair crashes).
//  - Mutations: small edits (aimed just before the crash point if the run crashes),
//    big moves (shift/stretch a range, replace steering with a hold, add a brake),
//    and time-cut crossover between two parents.
//  - When the best individual is ahead of the reference and its real finish frame is not
//    worse, it becomes the new reference and is written to the output file.
// usage: [NK=processes] [SEED=start.json] [WIN=a,b] [THROTTLE=1] node tools/evolve.js [minutes=10] [in] [out]
const { fork } = require('child_process'), fs = require('fs');
const { createSim } = require('./sim.js');
const KEY = { KeyW: 'up', KeyD: 'right', KeyS: 'down', KeyA: 'left', Reset: 'reset' };
const NAME = Object.fromEntries(Object.entries(KEY).map(([a, b]) => [b, a]));
const NK = +(process.env.NK || 4), POP = 24, EXPLORERS = 8, CHILDREN = 48, SAMPLE = 50, FINISH_MARGIN = 5, OFF_LINE = 4;

if (process.argv[2] === 'child') {
  (async () => {
    const sim = await createSim();
    await sim.initFast();
    process.send({ ready: true });
    process.on('message', async m => {
      const r = m.op === 'setBase' ? await sim.setBase(m.L, m.cap) : await sim.evalFrom(m.L, m.from, m.cap, m.sample);
      const out = { id: m.id, frames: r.frames, fin: r.fin, pos: r.pos, speed: r.speed, resumedFrom: r.resumedFrom };
      if (r.S) out.S = Array.from(r.S);
      if (m.op === 'setBase' && m.wantRef) { out.P = Array.from(r.P); out.V = Array.from(r.V); }
      process.send(out);
    });
  })();
  return;
}

const minutes = +(process.argv[2] || 10);
const inFile = process.argv[3] || 'inputs/summer1_opt.json', outFile = process.argv[4] || 'inputs/summer1_opt.json';
const seed = { up: [], right: [], down: [], left: [], reset: [] };
for (const [f, k] of JSON.parse(fs.readFileSync(inFile))) seed[KEY[k]].push(f);
for (const k in seed) seed[k].sort((a, b) => a - b);
const STEER = ['right', 'left', 'down'];
// WIN=a,b restricts mutations to frames [a,b); THROTTLE=1 also mutates W (inserts/moves short throttle lifts)
const WIN = process.env.WIN ? process.env.WIN.split(',').map(Number) : null;
const THROTTLE = !!process.env.THROTTLE;
const clampWin = (a, b) => { if (!WIN) return [a, b]; const lo = Math.max(a, WIN[0]), hi = Math.min(b, WIN[1]); return lo < hi ? [lo, hi] : [WIN[0], WIN[1]]; };
const clone = L => Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.slice()]));
const rnd = n => Math.floor(Math.random() * n), pick = a => a[rnd(a.length)];
const valid = L => ['up', 'right', 'down', 'left'].every(k => L[k].every((f, i) => (i === 0 ? f >= (k === 'up' ? 0 : 1) : f > L[k][i - 1])));
const key = L => STEER.map(k => L[k].join(',')).join('|') + '|' + L.up.join(',');
const toEvents = L => {
  const ev = []; for (const k of ['up', 'right', 'down', 'left']) L[k].forEach((f, i) => ev.push([f, NAME[k], i % 2 === 0]));
  return ev.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
};
const firstDiff = (A, B) => {
  let m = Infinity;
  for (const k of ['up', 'right', 'down', 'left']) {
    const n = Math.max(A[k].length, B[k].length);
    for (let i = 0; i < n; i++) if (A[k][i] !== B[k][i]) { m = Math.min(m, A[k][i] ?? Infinity, B[k][i] ?? Infinity); break; }
  }
  return m;
};

// ---- mutation operators ----
function small(L, a, b) {                          // edit one toggle/tap inside [a,b)
  [a, b] = clampWin(a, b);
  const k = THROTTLE && Math.random() < 0.3 ? 'up' : pick(STEER);
  const M = clone(L), l = M[k];
  const idx = []; l.forEach((f, i) => { if (f >= a && f < b && !(k === 'up' && i === 0)) idx.push(i); });
  const d = pick([-1, 1, -2, 2, -4, 4, -8, 8, -16, 16, -32, 32]);
  // for W the list starts "on" at frame 0, so a lift is the pair (odd, even) = (release, press)
  const partner = i => k === 'up' ? (i % 2 ? i + 1 : i - 1) : (i ^ 1);
  if (!idx.length || Math.random() < 0.1) { const t = a + rnd(Math.max(1, b - a)), w = k === 'up' ? 3 + rnd(40) : 10 + rnd(60); l.push(t, t + w); l.sort((x, y) => x - y); }
  else {
    const i = pick(idx), r = Math.random(), j = partner(i);
    if (r < 0.6) l[i] += d;
    else if (r < 0.9) { if (j > 0 && j < l.length) { l[i] += d; l[j] += d; } }
    else if (j > 0 && j < l.length && l.length > 2) l.splice(Math.min(i, j), 2);
  }
  return M;
}
function big(L) {
  const M = clone(L), r = Math.random();
  const a = WIN ? WIN[0] + rnd(Math.max(1, WIN[1] - WIN[0] - 200)) : 300 + rnd(20500), len = 200 + rnd(1500), b = WIN ? Math.min(WIN[1], a + len) : a + len, inR = f => f >= a && f < b;
  if (r < 0.35) {
    const d = pick([-150, -100, -60, -40, -25, 25, 40, 60, 100, 150]);
    for (const k of STEER) M[k] = M[k].map(f => inR(f) ? f + d : f);
  } else if (r < 0.6) {
    const s = pick([0.5, 0.7, 0.85, 1.2, 1.4, 1.8]);
    for (const k of STEER) for (let i = 0; i + 1 < M[k].length; i += 2)
      if (inR(M[k][i])) M[k][i + 1] = M[k][i] + Math.max(5, Math.round((M[k][i + 1] - M[k][i]) * s));
  } else if (r < 0.85) {
    for (const k of ['right', 'left']) {
      const l = M[k], out = [];
      for (let i = 0; i + 1 < l.length; i += 2) if (!inR(l[i])) out.push(l[i], l[i + 1]);
      if (l.length % 2) out.push(l[l.length - 1]);
      M[k] = out;
    }
    M[pick(['right', 'left'])].push(a, a + 30 + rnd(Math.min(600, len)));
  } else M.down.push(a, a + 20 + rnd(300));
  for (const k of STEER) M[k].sort((x, y) => x - y);
  return M;
}
function crossover(A, B) {                          // A before time t, B from t on
  const t = 300 + rnd(21000), C = {};
  for (const k of ['up', 'right', 'down', 'left', 'reset']) {
    const a = A[k].filter(f => f < t), b = B[k].filter(f => f >= t);
    const pa = a.length % 2, pb = B[k].filter(f => f < t).length % 2;   // key state at t in A vs B
    C[k] = pa === pb ? a.concat(b) : (b[0] === t ? a.concat(b.slice(1)) : a.concat([t], b));
  }
  return C;
}

(async () => {
  const kids = [];
  for (let i = 0; i < NK; i++) { const c = fork(__filename, ['child']); await new Promise(r => c.once('message', r)); kids.push(c); }
  let nextId = 0, rr = 0; const pending = new Map();
  kids.forEach(c => c.on('message', m => { const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } }));
  const send = (c, m) => new Promise(res => { const id = nextId++; pending.set(id, res); c.send({ id, ...m }); });
  const anyKid = () => kids[rr++ % NK];

  let ref = seed, P, V, finish, TF;
  async function rebase() {
    const rs = await Promise.all(kids.map((c, i) => send(c, { op: 'setBase', L: ref, cap: 30000, wantRef: i === 0 })));
    P = rs[0].P; V = rs[0].V; finish = rs[0].frames; TF = finish - FINISH_MARGIN;
  }
  function ahead(p, T) {
    let bestD = Infinity, bestT = T;
    const lo = Math.max(0, T - 300), hi = Math.min(finish - 1, T + 300);
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
  async function evaluate(ind) {
    const from = Math.min(firstDiff(ref, ind.L), TF - 1);
    const r = await send(anyKid(), { op: 'eval', L: ind.L, from, cap: TF, sample: SAMPLE });
    ind.failAt = null;
    for (let i = 0; i < (r.S || []).length; i += 4) {          // first sample that left the line
      const T = r.S[i], a = ahead([r.S[i + 1], r.S[i + 2], r.S[i + 3]], T);
      if (a.off > OFF_LINE) { ind.failAt = T; ind.fit = -1000 - (TF - T) / 10; return ind; }
    }
    if (r.fin) { ind.fit = 1000 + (TF - r.frames); return ind; }
    const a = ahead(r.pos, TF);
    if (a.off > OFF_LINE) { ind.failAt = TF; ind.fit = -1000; return ind; }
    ind.fit = a.ms;
    return ind;
  }
  const evalAll = inds => Promise.all(inds.map(evaluate));
  const breed = pop => {
    const tour = () => { let b = pick(pop); for (let i = 0; i < 2; i++) { const c = pick(pop); if (c.fit > b.fit) b = c; } return b; };
    for (let tries = 0; tries < 50; tries++) {
      const p = tour(), r = Math.random();
      let L;
      if (r < 0.2) L = crossover(p.L, tour().L);
      else if (r < 0.4) L = big(p.L);
      else if (p.failAt != null) L = small(p.L, Math.max(1, p.failAt - 1500), p.failAt);   // repair before the crash
      else L = small(p.L, 1, TF);
      if (valid(L)) return { L };
    }
    return { L: clone(pop[0].L) };
  };

  await rebase();
  const startFinish = finish;
  console.log('start finish frames', finish);
  // SEED=<file>: start the population from another run (e.g. a changed section whose later
  // inputs still need repairing) while fitness stays relative to the reference (inFile)
  let start = seed;
  if (process.env.SEED) { start = { up: [], right: [], down: [], left: [], reset: [] }; for (const [f, k] of JSON.parse(fs.readFileSync(process.env.SEED))) start[KEY[k]].push(f); for (const k in start) start[k].sort((a, b) => a - b); console.log('population seeded from', process.env.SEED); }
  let pop = [{ L: clone(start) }];
  while (pop.length < POP) { const L = Math.random() < 0.5 ? big(start) : small(start, 1, TF); if (valid(L)) pop.push({ L }); }
  await evalAll(pop);
  const t0 = Date.now(); let gen = 0, evals = pop.length, refUpdates = 0;
  while (Date.now() - t0 < minutes * 60000) {
    gen++;
    const children = []; while (children.length < CHILDREN) children.push(breed(pop));
    await evalAll(children); evals += children.length;
    const seen = new Set(), merged = [];
    for (const ind of pop.concat(children).sort((a, b) => b.fit - a.fit)) { const k = key(ind.L); if (!seen.has(k)) { seen.add(k); merged.push(ind); } }
    // elites + explorers: keep the best on-line runs, plus the crashed lines that got furthest,
    // so new lines survive long enough to be repaired (otherwise tiny variants of the best take every slot)
    const ok = merged.filter(i => i.failAt == null), bad = merged.filter(i => i.failAt != null);
    const nExp = Math.min(EXPLORERS, bad.length);
    pop = ok.slice(0, POP - nExp).concat(bad.slice(0, nExp));
    if (pop.length < POP) pop = pop.concat(merged.filter(i => !pop.includes(i)).slice(0, POP - pop.length));
    pop.sort((a, b) => b.fit - a.fit);
    const top = pop[0];
    if (gen % 10 === 0) console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] gen ${gen} best ${top.fit.toFixed(3)} median ${pop[POP >> 1].fit.toFixed(2)} crashed ${pop.filter(p => p.failAt != null).length}/${POP}`);
    if (top.fit > 0.001) {                                       // ahead of the reference at TF
      const prevRef = ref, prevFinish = finish;
      ref = top.L; await rebase();
      if (finish > prevFinish) { ref = prevRef; await rebase(); top.fit = -1; continue; }
      refUpdates++;
      fs.writeFileSync(outFile, JSON.stringify(toEvents(ref)));
      console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] gen ${gen}: new reference (+${top.fit.toFixed(3)} ms), finish frames ${finish}`);
      await evalAll(pop); evals += pop.length;                   // fitness is relative to the reference
      pop.sort((a, b) => b.fit - a.fit);
    }
  }
  console.log(`done: ${gen} generations, ${evals} evals, ${refUpdates} reference updates; finish ${startFinish} -> ${finish}`);
  kids.forEach(c => c.kill()); process.exit(0);
})();
