// Segment search: evolutionary search that only changes inputs inside a time window [W0, W1],
// e.g. the opening (approach, braking turn, ramp). Fitness is robust to "looks good briefly":
//   phase A: simulate the candidate up to W1 and measure how many ms it is ahead of the
//            reference there (projection on the reference line),
//   phase B: continue with the reference's inputs shifted by that lead, and score by when it
//            collects checkpoint TARGET (reference arrival - candidate arrival, in ms) plus a
//            small bonus for arriving faster.
// The best full input set (window inputs + shifted reference tail) is written to OUT.
// usage: node tools/segment.js <ref.json> <minutes> <out.json> [W0=0] [W1=5300] [TARGET=2 (4 = finish)] [NK=3]
const { fork } = require('child_process'), fs = require('fs');
const { createSim } = require('./sim.js');
const KEY = { KeyW: 'up', KeyD: 'right', KeyS: 'down', KeyA: 'left', Reset: 'reset' };
const NAME = Object.fromEntries(Object.entries(KEY).map(([a, b]) => [b, a]));
const KEYS = ['up', 'right', 'down', 'left'], BIT = { up: 1, right: 2, down: 4, left: 8 };
const [refFile, minutesArg, outFile, w0Arg, w1Arg, targetArg, nkArg] = process.argv.slice(2);
const W0 = +(w0Arg || 0), W1 = +(w1Arg || 5300), TARGET = +(targetArg || 2), NK = +(nkArg || 3);
const POP = 24, EXPLORERS = 8, CHILDREN = 36, SPEED_W = 0.05;
const load = f => { const L = { up: [], right: [], down: [], left: [], reset: [] }; for (const [fr, k] of JSON.parse(fs.readFileSync(f))) L[KEY[k]].push(fr); for (const k in L) L[k].sort((a, b) => a - b); return L; };
const clone = L => Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.slice()]));
const toEvents = L => { const ev = []; for (const k of KEYS) L[k].forEach((f, i) => ev.push([f, NAME[k], i % 2 === 0])); return ev.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])); };
const firstDiff = (A, B) => { let m = Infinity; for (const k of KEYS) { const n = Math.max(A[k].length, B[k].length); for (let i = 0; i < n; i++) if (A[k][i] !== B[k][i]) { m = Math.min(m, A[k][i] ?? Infinity, B[k][i] ?? Infinity); break; } } return m; };

if (process.argv[2] === 'child') {
  (async () => {
    const sim = await createSim(); await sim.initFast();
    let ref, P, V, C, refBits, refCp, N;
    process.on('message', async m => {
      if (m.op === 'init') {
        ref = m.ref; const b = await sim.setBase(ref, 30000);
        P = b.P; V = b.V; C = b.C; N = b.frames + 3000;
        refBits = new Uint8Array(N); for (const k of KEYS) { let on = false, i = 0; const a = ref[k]; for (let f = 0; f < N; f++) { while (i < a.length && a[i] <= f) { on = !on; i++; } if (on) refBits[f] |= BIT[k]; } }
        refCp = 0; if (m.target >= 4) refCp = b.frames; else for (let f = 1; f < C.length; f++) if (C[f] >= m.target) { refCp = f; break; }   // target 4 = finish
        process.send({ id: m.id, refCp, refSpeed: V[refCp] });
        return;
      }
      // phase A: run to W1, measure lead over the reference there
      const L = m.L, fromA = Math.min(firstDiff(ref, L), m.w1 - 1);
      const a = await sim.evalFrom(L, fromA, m.w1);
      let lead = 0;
      if (!a.fin) {
        let bestD = Infinity, bt = m.w1;
        for (let j = Math.max(0, m.w1 - 400); j < Math.min(P.length / 3 - 2, m.w1 + 400); j++) {
          const ax = P[3 * j], az = P[3 * j + 2], bx = P[3 * j + 3] - ax, bz = P[3 * j + 5] - az, L2 = bx * bx + bz * bz || 1e-12;
          let u = ((a.pos[0] - ax) * bx + (a.pos[2] - az) * bz) / L2; u = Math.max(0, Math.min(1, u));
          const dx = ax + u * bx - a.pos[0], dz = az + u * bz - a.pos[2], d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; bt = j + u; }
        }
        if (Math.sqrt(bestD) > 6) { process.send({ id: m.id, fit: -2000, lead: null }); return; }   // off the line at W1
        lead = Math.round(bt - m.w1);
      }
      // phase B: window inputs up to W1, then the reference's inputs shifted by the lead
      const bits = new Uint8Array(N);
      for (const k of KEYS) { let on = false, i = 0; const arr = L[k]; for (let f = 0; f <= m.w1; f++) { while (i < arr.length && arr[i] <= f) { on = !on; i++; } if (on) bits[f] |= BIT[k]; } }
      for (let f = m.w1 + 1; f < N; f++) bits[f] = refBits[Math.max(0, Math.min(N - 1, f + lead))];
      const full = { up: [], right: [], down: [], left: [], reset: [] };
      for (const k of KEYS) { let on = false; for (let f = 0; f < N; f++) { const b = !!(bits[f] & BIT[k]); if (b !== on) { full[k].push(f); on = b; } } }
      const r = await sim.evalFrom(full, Math.min(firstDiff(ref, full), m.w1), refCp + 1500, 0, m.target >= 4 ? 0 : m.target);
      const reached = m.target >= 4 ? r.fin : r.cp >= m.target;
      let fit;
      if (reached) fit = (refCp - r.frames) + SPEED_W * (r.speed - V[refCp]);
      else fit = -1000 - (refCp + 1500 - r.frames) / 10;
      process.send({ id: m.id, fit, lead, arrival: reached ? r.frames : null, full });
    });
    process.send({ ready: true });
  })();
  return;
}

const rnd = n => Math.floor(Math.random() * n), pick = a => a[rnd(a.length)];
const valid = L => KEYS.every(k => L[k].every((f, i) => (i === 0 ? f >= (k === 'up' ? 0 : 1) : f > L[k][i - 1])));
const inW = f => f >= W0 && f < W1;
function small(L) {
  const M = clone(L), k = Math.random() < 0.7 ? pick(['right', 'left']) : pick(['down', 'up']), l = M[k];
  const idx = []; l.forEach((f, i) => { if (inW(f) && !(k === 'up' && i === 0)) idx.push(i); });
  const d = pick([-1, 1, -2, 2, -4, 4, -8, 8, -16, 16, -32, 32, -64, 64]);
  if (!idx.length || Math.random() < 0.15) { const t = Math.max(1, W0) + rnd(W1 - Math.max(1, W0)), w = 5 + rnd(80); l.push(t, t + w); l.sort((x, y) => x - y); }
  else {
    const i = pick(idx), r = Math.random();
    if (r < 0.55) l[i] += d;
    else if (r < 0.85) { const j = i ^ 1; if (j < l.length) { l[i] += d; l[j] += d; } }
    else if (l.length > 2) l.splice(i - (i % 2), 2);
  }
  for (const kk of KEYS) M[kk] = M[kk].filter(f => f < W1 || L[kk].includes(f));       // never move edits past W1
  return M;
}
function big(L) {
  const M = clone(L), r = Math.random(), a = W0 + rnd(Math.max(1, W1 - W0 - 200)), b = Math.min(W1, a + 100 + rnd(1200)), inR = f => f >= a && f < b;
  if (r < 0.4) { const d = pick([-80, -40, -20, -10, 10, 20, 40, 80]); for (const k of ['right', 'left', 'down']) M[k] = M[k].map(f => inR(f) && inR(f + d) ? f + d : f); }
  else if (r < 0.7) { const s = pick([0.5, 0.75, 1.25, 1.5]); for (const k of ['right', 'left', 'down']) for (let i = 0; i + 1 < M[k].length; i += 2) if (inR(M[k][i])) M[k][i + 1] = Math.min(W1 - 1, M[k][i] + Math.max(3, Math.round((M[k][i + 1] - M[k][i]) * s))); }
  else if (r < 0.85) { const k = pick(['down']); const l = M[k], out = []; for (let i = 0; i + 1 < l.length; i += 2) if (!inR(l[i])) out.push(l[i], l[i + 1]); if (l.length % 2) out.push(l[l.length - 1]); M[k] = out; }   // remove braking in range
  else { const k = pick(['right', 'left']); M[k].push(a, Math.min(W1 - 1, a + 20 + rnd(300))); }
  for (const k of KEYS) M[k].sort((x, y) => x - y);
  return M;
}
function crossover(A, B) {
  const t = W0 + rnd(W1 - W0), C = {};
  for (const k of [...KEYS, 'reset']) { const a = A[k].filter(f => f < t), b = B[k].filter(f => f >= t), pa = a.length % 2, pb = B[k].filter(f => f < t).length % 2; C[k] = pa === pb ? a.concat(b) : (b[0] === t ? a.concat(b.slice(1)) : a.concat([t], b)); }
  return C;
}
const key = L => KEYS.map(k => L[k].filter(f => f < W1).join(',')).join('|');

(async () => {
  const ref = load(refFile);
  const kids = [];
  for (let i = 0; i < NK; i++) { const c = fork(__filename, ['child'], { serialization: 'advanced' }); await new Promise(r => c.once('message', r)); kids.push(c); }
  let nextId = 0, rr = 0; const pending = new Map();
  kids.forEach(c => c.on('message', m => { const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } }));
  const send = (c, m) => new Promise(res => { const id = nextId++; pending.set(id, res); c.send({ id, ...m }); });
  const info = (await Promise.all(kids.map(c => send(c, { op: 'init', ref, target: TARGET }))))[0];
  console.log(`reference collects checkpoint ${TARGET} at frame ${info.refCp} (${info.refSpeed.toFixed(0)} km/h); window ${W0}-${W1}`);
  const evaluate = async ind => { const r = await send(kids[rr++ % NK], { op: 'eval', L: ind.L, w1: W1, target: TARGET }); Object.assign(ind, { fit: r.fit, lead: r.lead, arrival: r.arrival, full: r.full }); return ind; };
  let pop = [{ L: clone(ref) }];
  while (pop.length < POP) { const L = Math.random() < 0.6 ? small(ref) : big(ref); if (valid(L)) pop.push({ L }); }
  await Promise.all(pop.map(evaluate));
  pop.sort((a, b) => b.fit - a.fit);
  console.log('baseline (reference) fitness', pop.find(p => key(p.L) === key(ref)).fit.toFixed(2));
  const t0 = Date.now(); let gen = 0, best = -Infinity;
  while (Date.now() - t0 < +(minutesArg || 10) * 60000) {
    gen++;
    const kidsL = [];
    const tour = () => { let b = pick(pop); for (let i = 0; i < 2; i++) { const c = pick(pop); if (c.fit > b.fit) b = c; } return b; };
    while (kidsL.length < CHILDREN) { const p = tour(), r = Math.random(); const L = r < 0.2 ? crossover(p.L, tour().L) : r < 0.45 ? big(p.L) : small(p.L); if (valid(L)) kidsL.push({ L }); }
    await Promise.all(kidsL.map(evaluate));
    const seen = new Set(), merged = [];
    for (const ind of pop.concat(kidsL).sort((a, b) => b.fit - a.fit)) { const k = key(ind.L); if (!seen.has(k)) { seen.add(k); merged.push(ind); } }
    const ok = merged.filter(i => i.arrival != null), bad = merged.filter(i => i.arrival == null);
    pop = ok.slice(0, POP - Math.min(EXPLORERS, bad.length)).concat(bad.slice(0, EXPLORERS)).sort((a, b) => b.fit - a.fit);
    if (pop[0].fit > best + 1e-9) {
      best = pop[0].fit;
      fs.writeFileSync(outFile, JSON.stringify(toEvents(pop[0].full)));
      console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] gen ${gen}: fitness ${best.toFixed(2)} (lead at ${W1}: ${pop[0].lead} ms, checkpoint ${TARGET} at frame ${pop[0].arrival}, reference ${info.refCp})`);
    }
  }
  console.log(`done: ${gen} generations, best fitness ${best.toFixed(2)}`);
  kids.forEach(c => c.kill()); process.exit(0);
})();
