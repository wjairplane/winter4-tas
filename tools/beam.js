// Beam search over driving: grows the run forward from the start instead of editing a
// finished input sequence, so it can find genuinely different racing lines.
//  - Every BLOCK ms each live car state branches into ACTIONS: W, W+right, W+left, coast,
//    brake, and "ref" (play the reference run's inputs from the point on the track the
//    state has reached; keeps the reference line alive and lets new lines follow it).
//  - States are scored by ms ahead of the reference line (+ a speed term) and binned by
//    position offset and heading relative to that line; the best state per bin survives
//    and the top K bins are kept -> many lines stay alive at once.
//  - Car states are heap snapshots of only the pages physics changes (~0.5 MB, not 24 MB).
//  - NK independent beams with different settings run in parallel (one per core); the main
//    process verifies every result with a clean, snapshot-free simulation.
// usage: [CONFIGS=l10,..] [BSTART=frame [BSEED=inputs.json]] [NFIN=k] node tools/beam.js [ref=inputs/summer1_opt.json] [out=inputs/summer1_beam.json]
const { fork } = require('child_process'), fs = require('fs');
const { createSim, encodeRecording } = require('./sim.js');
const KEY = { KeyW: 'up', KeyD: 'right', KeyS: 'down', KeyA: 'left', Reset: 'reset' };
const NAME = Object.fromEntries(Object.entries(KEY).map(([a, b]) => [b, a]));
const BIT = { up: 1, right: 2, down: 4, left: 8 };
// BACTIONS=1,3,9,0,4,6,7,12,ref adds braking while steering (6 = S+D, 7 = W+S+D, 12 = S+A, 5 = W+S)
const ACTIONS = process.env.BACTIONS ? process.env.BACTIONS.split(',').map(a => a === 'ref' ? 'ref' : +a) : [1, 3, 9, 0, 4, 'ref'];
const load = f => { const L = { up: [], right: [], down: [], left: [], reset: [] }; for (const [fr, k] of JSON.parse(fs.readFileSync(f))) L[KEY[k]].push(fr); for (const k in L) L[k].sort((a, b) => a - b); return L; };
const toEvents = L => { const ev = []; for (const k of ['up', 'right', 'down', 'left']) L[k].forEach((f, i) => ev.push([f, NAME[k], i % 2 === 0])); return ev.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])); };
const bitsToLists = bits => { const L = { up: [], right: [], down: [], left: [], reset: [] }; for (const k in BIT) { let on = false; for (let f = 0; f < bits.length; f++) { const b = !!(bits[f] & BIT[k]); if (b !== on) { L[k].push(f); on = b; } } } return L; };

const CONFIGS = [
  // fine late-section beams (use with BSTART, e.g. BSTART=14000)
  { name: 'l10', BLOCK: 10, K: 200, BIN_POS: 1.0, BIN_DIR: 0.05 },
  { name: 'l10fine', BLOCK: 10, K: 200, BIN_POS: 0.5, BIN_DIR: 0.03 },
  { name: 'l5', BLOCK: 5, K: 150, BIN_POS: 1.0, BIN_DIR: 0.05 },
  { name: 'l15', BLOCK: 15, K: 250, BIN_POS: 1.0, BIN_DIR: 0.05 },
  { name: 'l15b', BLOCK: 15, K: 300, BIN_POS: 0.75, BIN_DIR: 0.04 },
  { name: 'l20', BLOCK: 20, K: 300, BIN_POS: 1.0, BIN_DIR: 0.05 },
  { name: 'l25', BLOCK: 25, K: 300, BIN_POS: 1.0, BIN_DIR: 0.05 },
  { name: 'b20', BLOCK: 20, K: 150, BIN_POS: 1.0, BIN_DIR: 0.05 },
  { name: 'b15', BLOCK: 15, K: 120, BIN_POS: 1.0, BIN_DIR: 0.05 },
  { name: 'b25', BLOCK: 25, K: 180, BIN_POS: 1.0, BIN_DIR: 0.05 },
  { name: 'b20fine', BLOCK: 20, K: 150, BIN_POS: 0.5, BIN_DIR: 0.03 },
];

async function beamChild(cfg, refFile) {
  const { BLOCK, K, BIN_POS, BIN_DIR } = cfg;
  const SPEED_H = cfg.SPEED_H ?? 60, DEAD_OFF = 12;
  const sim = await createSim(); await sim.initFast();
  const ref = load(refFile);
  const base = await sim.setBase(ref, 30000);
  const P = base.P, V = base.V, C = base.C, finish = base.frames, N = finish + 2000;
  const cpFrames = []; for (let f = 1; f < C.length; f++) if (C[f] > C[f - 1]) cpFrames.push(f);
  process.send({ log: `[${cfg.name}] reference checkpoints at frames ${cpFrames.join(', ')}, finish ${finish}` });
  const refBits = new Uint8Array(N);
  for (const k in BIT) { let on = false, i = 0; const a = ref[k]; for (let f = 0; f < N; f++) { while (i < a.length && a[i] <= f) { on = !on; i++; } if (on) refBits[f] |= BIT[k]; } }
  const pages = new Set((await sim.probe(ref, 30000, 50)).pages); for (let i = 0; i < 40; i++) pages.add(i);
  await sim.raw({ op: 'bSetup', D: [...pages].sort((a, b) => a - b) });

  function project(p, lo, hi) {                  // foot point on the reference line between frames lo..hi
    let bestD = Infinity, bj = 0, bu = 0;
    lo = Math.max(0, Math.floor(lo)); hi = Math.min(finish - 1, Math.ceil(hi));
    for (let j = lo; j < hi; j++) {
      // match on the ground plane (y is up): jumps/drops would otherwise bias 3D matching
      const ax = P[3 * j], az = P[3 * j + 2];
      const bx = P[3 * j + 3] - ax, bz = P[3 * j + 5] - az;
      const L2 = bx * bx + bz * bz || 1e-12;
      let u = ((p[0] - ax) * bx + (p[2] - az) * bz) / L2; u = Math.max(0, Math.min(1, u));
      const dx = ax + u * bx - p[0], dz = az + u * bz - p[2], d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; bj = j; bu = u; }
    }
    const j = bj, bx = P[3 * j + 3] - P[3 * j], by = P[3 * j + 4] - P[3 * j + 1], bz = P[3 * j + 5] - P[3 * j + 2], l = Math.hypot(bx, by, bz) || 1e-9;
    return { refT: j + bu, off: Math.sqrt(bestD), dy: p[1] - (P[3 * j + 1] + bu * by), foot: [P[3 * j] + bu * bx, P[3 * j + 1] + bu * by, P[3 * j + 2] + bu * bz], tan: [bx / l, by / l, bz / l] };
  }
  const segsOf = (bits, t, len) => { const s = []; for (let f = t; f < t + len; f++) { const b = bits[Math.max(0, Math.min(f, N - 1))]; if (s.length && s[s.length - 1][0] === b) s[s.length - 1][1]++; else s.push([b, 1]); } return s; };
  const segsRef = (t, len) => segsOf(refBits, t, len);
  // BSEED=<inputs.json>: start from these inputs instead of the reference (see BSTART below); the seed's own
  // inputs are then the clock-aligned "ref" line, while progress is still measured on the reference line
  let clockBits = refBits;
  if (process.env.BSEED) {
    const sd = load(process.env.BSEED); clockBits = new Uint8Array(N);
    for (const k in BIT) { let on = false, i = 0; const a = sd[k]; for (let f = 0; f < N; f++) { while (i < a.length && a[i] <= f) { on = !on; i++; } if (on) clockBits[f] |= BIT[k]; } }
  }
  // BHYST=<ms>: a line that follows the reference by progress keeps its time shift until its progress drifts
  // more than BHYST ms from it (0 = re-align every block, the original behaviour)
  const HYST = +(process.env.BHYST || 0);

  let beam = [{ id: 0, t: 0, pos: [P[0], P[1], P[2]], parent: null, segs: null, refT: 0, isRef: true }];
  // BSTART=<frame>: play the reference exactly up to that frame, then branch (late-section search)
  // BSEED=<inputs.json>: play these inputs up to BSTART instead (e.g. a new jump approach), then branch;
  // progress is still measured against the reference line, which the start state need not be on
  const BSTART = +(process.env.BSTART || 0);
  if (BSTART > 0) {
    const startSegs = segsOf(clockBits, 0, BSTART);
    const { res } = await sim.raw({ op: 'bExpand', jobs: [{ pid: 0, cid: 1, segs: startSegs }] });
    const r = res[0];
    const refT0 = process.env.BSEED ? project(r.pos, Math.max(0, BSTART - 400), BSTART + 400).refT : r.frames;
    beam = [{ id: 1, t: r.frames, pos: r.pos, speed: r.speed, cp: r.cp, parent: beam[0], segs: startSegs, refT: refT0, isRef: true }];
    if (process.env.BSEED) process.send({ log: `[${cfg.name}] seed ${process.env.BSEED} at ${r.frames}: ${(refT0 - r.frames).toFixed(2)} ms ahead of the reference, ${r.speed.toFixed(1)} km/h` });
    await sim.raw({ op: 'bKeep', ids: [1] });
  }
  let nextId = 2, bestFin = null, step = 0, totalLeaks = 0, totalCrashes = 0; const finishers = [];
  const t0 = Date.now();
  while (beam.length) {
    step++;
    const jobs = [], meta = [];
    for (const nd of beam) for (const a of ACTIONS) {
      // 'ref': the reference line plays its own inputs; any other state plays the reference
      // inputs from the point it has reached on the track (not the clock), so lines that are
      // ahead/behind can still follow the reference's steering through upcoming corners
      let segs, sh = nd.sh;
      if (a !== 'ref') segs = [[a, BLOCK]];
      else if (nd.isRef) segs = segsOf(clockBits, nd.t, BLOCK);
      else { const want = nd.refT - nd.t; if (sh === undefined || Math.abs(want - sh) > HYST) sh = Math.round(want); segs = segsRef(Math.max(0, nd.t + sh), BLOCK); }
      const cid = nextId++; jobs.push({ pid: nd.id, cid, segs }); meta.push({ parent: nd, segs, isRef: nd.isRef && a === 'ref', sh });
    }
    // expand, then check for heap pages outside the snapshot set; if any appeared this step,
    // they were added to every snapshot (exactly) and the step is re-run so no child is contaminated
    // a child that crashes (wasm trap) is reported with .err; after a leak re-run, a child
    // that still crashes is a genuinely broken state and is dropped
    let res, leaks = 0;
    for (;;) {
      ({ res } = await sim.raw({ op: 'bExpand', jobs }));
      const lk = await sim.raw({ op: 'bLeak' });
      if (!lk.leak.length) break;
      leaks += lk.leak.length; totalLeaks += lk.leak.length;
    }
    const errs = res.filter(r => r.err);
    if (errs.length) { totalCrashes += errs.length; process.send({ log: `[${cfg.name}] step ${step}: dropped ${errs.length} crashed children (${errs[0].err})` }); }
    const bins = new Map(); let refNode = null; const why = { off: 0, dy: 0, slow: 0, cp: 0, ok: 0 }, prevTop = beam[0]; let topKid = null;
    res.forEach((r, i) => {
      if (r.err) return;
      const nd = { id: r.cid, t: r.frames, pos: r.pos, speed: r.speed, cp: r.cp, parent: meta[i].parent, segs: meta[i].segs, isRef: meta[i].isRef, sh: meta[i].sh };
      if (r.fin) { finishers.push(nd); if (!bestFin || r.frames < bestFin.t) bestFin = nd; return; }
      // progress is continuous: the match point can only move a little from the parent's
      // (stops matches jumping to another part of the track that passes nearby)
      const adv = nd.t - nd.parent.t, pr = project(r.pos, nd.parent.refT + 0.3 * adv, nd.parent.refT + 1.7 * adv);
      if (process.env.BTRACE && nd.parent === prevTop && (!topKid || pr.refT > topKid.refT)) topKid = { refT: pr.refT, off: pr.off, dy: pr.dy, speed: r.speed, cp: r.cp, pos: r.pos, t: nd.t };
      if (pr.off > DEAD_OFF) { why.off++; return; }
      if (pr.dy < -8 || pr.dy > 80) { why.dy++; return; }             // well below the track = fell off; far above = flying (allowed)
      if (pr.refT < nd.t - 1500) { why.slow++; return; }              // left the course / hopelessly slow
      // a state that is past a reference checkpoint position (with margin) but has not collected it skipped it
      if (nd.cp < C[Math.max(0, Math.min(C.length - 1, Math.floor(pr.refT) - 30))]) { why.cp++; return; }
      why.ok++;
      nd.refT = pr.refT;
      const vr = V[Math.min(V.length - 1, Math.round(pr.refT))] || r.speed;
      nd.score = (pr.refT - nd.t) + ((r.speed - vr) / Math.max(vr, 1)) * SPEED_H;
      const dt = Math.max(1, nd.t - nd.parent.t), v = [(r.pos[0] - nd.parent.pos[0]) / dt, (r.pos[1] - nd.parent.pos[1]) / dt, (r.pos[2] - nd.parent.pos[2]) / dt];
      const vl = Math.hypot(v[0], v[1], v[2]) || 1e-9;
      const off = [0, 1, 2].map(i => r.pos[i] - pr.foot[i]), dir = [0, 1, 2].map(i => v[i] / vl - pr.tan[i]);
      nd.coarse = off.map(x => Math.round(x / BIN_POS)).concat(dir.map(x => Math.round(x / BIN_DIR))).join(',');
      const fine = off.map(x => Math.round(x / 0.03)).concat(dir.map(x => Math.round(x / 0.003))).join(',');
      if (nd.isRef) refNode = nd;
      const cur = bins.get(fine);                                       // fine bins only remove near-duplicates
      if (!cur || nd.score > cur.score) bins.set(fine, nd);
    });
    // selection: the best state of each coarse bin (different lines) gets a reserved slot,
    // up to a third of the beam; the rest is filled purely by score
    const sorted = [...bins.values()].sort((a, b) => b.score - a.score), seenC = new Set(), picked = new Set();
    for (const nd of sorted) { if (picked.size >= Math.floor(K / 3)) break; if (!seenC.has(nd.coarse)) { seenC.add(nd.coarse); picked.add(nd); } }
    for (const nd of sorted) { if (picked.size >= K) break; picked.add(nd); }
    beam = [...picked].sort((a, b) => b.score - a.score);
    if (refNode && !beam.includes(refNode)) beam[beam.length - 1 < K - 1 ? beam.length : K - 1] = refNode;   // the reference line always survives
    await sim.raw({ op: 'bKeep', ids: beam.map(n => n.id) });
    // BDUMP=<frame>:<file>: save the leading line's inputs once it passes <frame> (seed for tools/landing.js)
    if (process.env.BDUMP && beam[0] && !globalThis.__dumped) { const [ft, file] = process.env.BDUMP.split(':'); if (beam[0].t >= +ft) {
      globalThis.__dumped = 1; const n = beam[0], chain = []; for (let a = n; a.parent; a = a.parent) chain.push(a.segs);
      const bits = []; for (const sg of chain.reverse()) for (const [b, len] of sg) for (let k = 0; k < len; k++) bits.push(b);
      fs.writeFileSync(file, JSON.stringify({ t: n.t, ahead: n.refT - n.t, pos: n.pos, speed: n.speed, cp: n.cp, bits }));
      process.send({ log: `[${cfg.name}] dumped leading line at t=${n.t} (ahead ${(n.refT - n.t).toFixed(1)} ms, ${n.speed.toFixed(0)} km/h) -> ${file}` });
      if (process.env.BDUMP_EXIT) return { name: cfg.name, finish: null, error: 'dump only' }; } }
    if (process.env.BTRACE) { const [a, b] = process.env.BTRACE.split('-').map(Number); if (prevTop && prevTop.t >= a && prevTop.t <= b && step % 2 === 0) {
      const k = topKid; process.send({ log: `TRACE t=${prevTop.t} top ahead=${(prevTop.refT - prevTop.t).toFixed(1)} speed=${(prevTop.speed||0).toFixed(0)} cp=${prevTop.cp} | its furthest child: ${k ? `ahead=${(k.refT - k.t).toFixed(1)} off=${k.off.toFixed(1)} dy=${k.dy.toFixed(1)} v=${k.speed.toFixed(0)} cp=${k.cp} pos=${k.pos.map(x => x.toFixed(1))}` : 'none'} | all children: ${JSON.stringify(why)}` }); } }
    if (process.env.BDEBUG && beam[0] && beam[0].t >= +process.env.BDEBUG && !globalThis.__dbg) {
      globalThis.__dbg = 1; const n = beam[0], j = Math.floor(n.refT), q = i => [P[3 * i], P[3 * i + 1], P[3 * i + 2]].map(x => x.toFixed(2)).join(',');
      const chainT = []; for (let a = n; a; a = a.parent) chainT.push(`${a.t}:${a.refT !== undefined ? (a.refT - a.t).toFixed(1) : '-'}`);
      process.send({ log: `DEBUG top t=${n.t} refT=${n.refT.toFixed(1)} pos=${n.pos.map(x => x.toFixed(2)).join(',')} speed=${n.speed.toFixed(1)} cp=${n.cp} | ref@refT=${q(j)} ref@t=${q(n.t)} refSpeed@t=${V[n.t].toFixed(1)} | ahead history (t:ms) ${chainT.slice(0, 60).reverse().join(' ')}` });
    }
    if (step % 50 === 0) {
      const top = beam[0];
      process.send({ log: `[${cfg.name}] t=${top ? top.t : '-'} beam=${beam.length} lines=${new Set(beam.map(n => n.coarse)).size} top ahead=${top ? (top.refT - top.t).toFixed(2) : '-'}ms score=${top ? top.score.toFixed(2) : '-'} ref=${beam.some(n => n.isRef) ? 'kept' : 'lost'} ${totalLeaks ? 'pages added ' + totalLeaks : ''} ${bestFin ? 'best finish so far ' + bestFin.t : ''} ${((Date.now() - t0) / 1000).toFixed(0)}s` });
    }
    if (bestFin && beam.length && beam[0].t > bestFin.t + (+process.env.NFIN_SLACK || 0)) break;
  }
  if (!bestFin) return { name: cfg.name, finish: null };
  const bitsOf = nd => { const chain = []; for (let n = nd; n.parent; n = n.parent) chain.push(n.segs); const bits = []; for (const segs of chain.reverse()) for (const [b, len] of segs) for (let k = 0; k < len; k++) bits.push(b); return bits.slice(0, nd.t + 1); };
  // NFIN=k: also return up to k distinct finishing lines (split from the reference >=150 ms apart)
  const alts = [];
  if (+process.env.NFIN > 1) {
    const used = [];
    for (const nd of finishers.sort((a, b) => a.t - b.t)) {
      const bits = bitsOf(nd); let split = 0; while (split < bits.length && bits[split] === refBits[split]) split++;
      if (used.some(u => Math.abs(u - split) < 150)) continue;
      used.push(split); alts.push({ finish: nd.t, split, events: toEvents(bitsToLists(bits)) });
      if (alts.length >= +process.env.NFIN) break;
    }
  }
  return { name: cfg.name, finish: bestFin.t, events: toEvents(bitsToLists(bitsOf(bestFin))), alts };
}

if (process.argv[2] === 'child') {
  process.on('message', async m => { try { process.send({ result: await beamChild(m.cfg, m.ref) }); } catch (e) { process.send({ result: { name: m.cfg.name, finish: null, error: String(e && e.stack || e).slice(0, 300) } }); } });
  return;
}

const refFile = process.argv[2] || 'inputs/summer1_opt.json', outFile = process.argv[3] || 'inputs/summer1_beam.json';
const only = process.env.CONFIGS ? process.env.CONFIGS.split(',') : ['b20', 'b15', 'b25', 'b20fine'];
(async () => {
  const cfgs = CONFIGS.filter(c => !only || only.includes(c.name));
  const results = await Promise.all(cfgs.map(cfg => new Promise(res => {
    const c = fork(__filename, ['child'], { serialization: 'advanced' });
    let done = false;
    c.on('message', m => { if (m.log) console.log(m.log); if (m.result) { done = true; res(m.result); c.kill(); } });
    c.on('exit', code => { if (!done) res({ name: cfg.name, finish: null, error: 'exited ' + code }); });
    c.send({ cfg, ref: refFile });
  })));
  // verify each result with the game's own clean recording path (no snapshots involved)
  const sim = await createSim();
  let best = null;
  for (const r of results) {
    if (!r.finish) { console.log(`${r.name}: no finish${r.error ? ' (' + r.error + ')' : ''}`); continue; }
    const L = { up: [], right: [], down: [], left: [], reset: [] }; for (const [f, k] of r.events) L[KEY[k]].push(f);
    const v = await sim.run(encodeRecording(L), 30000);
    console.log(`${r.name}: beam finish ${r.finish}, clean re-simulation ${v.frames}`);
    if (!best || v.frames < best.frames) best = { ...r, frames: v.frames };
    for (const [i, a] of (r.alts || []).entries()) {
      const AL = { up: [], right: [], down: [], left: [], reset: [] }; for (const [f, k] of a.events) AL[KEY[k]].push(f);
      const av = await sim.run(encodeRecording(AL), 30000);
      const f = outFile.replace(/\.json$/, `_${r.name}_alt${i}.json`); fs.writeFileSync(f, JSON.stringify(a.events));
      console.log(`  ${r.name} alt ${i}: splits from reference at ${a.split} ms, clean finish ${av.frames} -> ${f}`);
    }
  }
  if (best) { fs.writeFileSync(outFile, JSON.stringify(best.events)); console.log(`best: ${best.name} ${best.frames} frames -> ${outFile}`); }
  process.exit(0);
})();
