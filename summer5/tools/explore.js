// From-scratch search for a Summer 5 run: no reference run, no leaderboard input.
// Grows the run forward from the start with the game's own physics (offline, tools/sim.js).
//  - Every BLOCK ms each kept car state branches into ACTIONS (key combinations held for BLOCK ms).
//  - Score: checkpoints collected, then closeness to the next checkpoint (from the track's own
//    parts, sim_assets/track.json), plus a small speed bonus.
//  - Selection keeps three kinds of states so the search can find its way around walls:
//      lines:   the best state of each coarse (cell, heading) bin, up to K/3
//      novelty: states in the least-visited cells of the current checkpoint stage, up to K/4
//      score:   the rest, purely by score
//  - Car states are snapshots of only the heap pages physics changes (worker_inject.js beam ops).
//  - NK beams with different settings run in parallel; every finish is re-checked with a clean,
//    snapshot-free simulation.
//  - Every time a beam reaches a new checkpoint, its leading line is saved as <out>_cp<k>_<config>.json,
//    so a later search can resume from it: START=<inputs.json>[:frame] replays those inputs (up to
//    frame, default all of them) and grows the search from there.
// usage: [CONFIGS=a,b] [NK=4] [MAX_T=ms] [START=file[:frame]] node tools/explore.js [out=inputs/summer5_explore.json]
const { fork } = require('child_process'), fs = require('fs'), path = require('path');
const { createSim, encodeRecording } = require('./sim.js');
const NAME = { up: 'KeyW', right: 'KeyD', down: 'KeyS', left: 'KeyA' };
const BIT = { up: 1, right: 2, down: 4, left: 8 };
const MAX_T = +(process.env.MAX_T || 200000);   // game-time cap per line (ms)

const CONFIGS = [
  { name: 'e40', BLOCK: 40, K: 160, CELL: 4, NOV: 6, ACTIONS: [1, 9, 3, 8, 2, 0, 4] },
  { name: 'e50', BLOCK: 50, K: 200, CELL: 5, NOV: 8, ACTIONS: [1, 9, 3, 8, 2, 0, 4] },
  { name: 'e30', BLOCK: 30, K: 130, CELL: 4, NOV: 6, ACTIONS: [1, 9, 3, 0, 4] },
  { name: 'e60', BLOCK: 60, K: 240, CELL: 6, NOV: 10, ACTIONS: [1, 9, 3, 8, 2, 0, 4, 13, 7] },
];

// Distance along the track to each target: every drivable part is a node (centre = grid * 5 m),
// parts next to each other (<= 4 grid units in x and z, <= 2 levels apart) are linked, and
// Dijkstra from each checkpoint gives a distance field. A car's distance to the target is
// min over nearby nodes of (field at node + straight distance to that node).
function trackField() {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sim_assets', 'track.json')));
  const S = 5, LINK = +(process.env.LINK || 8), LINKY = +(process.env.LINKY || 3), WALLPEN = +(process.env.WALLPEN || 400), drivable = n => !/^(Block$|HalfBlock|Pillar|Sign|PlanePillar)/.test(n);
  const nodes = [], at = new Map();
  for (const p of t.parts) {
    if (!drivable(p.name)) continue;
    const k = p.x + ',' + p.y + ',' + p.z; if (at.has(k)) continue;
    at.set(k, nodes.length); nodes.push({ g: [p.x, p.y, p.z], c: [p.x * S, p.y * S, p.z * S], adj: [] });
  }
  // solid blocks are walls: a link should not pass through a cell that holds a block at the
  // heights it spans (checked at every intermediate cell, and both side cells of a diagonal step)
  const solid = new Set(t.parts.filter(p => /^(Block|HalfBlock)$/.test(p.name)).map(p => p.x + ',' + p.y + ',' + p.z));
  const wall = (x, z, y0, y1) => { for (let y = y0; y <= y1; y++) if (solid.has(x + ',' + y + ',' + z)) return true; return false; };
  const clear = (a, dx, dy, dz) => {
    const y0 = Math.min(a[1], a[1] + dy), y1 = Math.max(a[1], a[1] + dy) + 1, steps = Math.max(Math.abs(dx), Math.abs(dz)) / 4;
    for (let k = 0; k < steps; k++) {
      const x = a[0] + Math.sign(dx) * Math.min(Math.abs(dx), 4 * k), z = a[2] + Math.sign(dz) * Math.min(Math.abs(dz), 4 * k);
      const nx = a[0] + Math.sign(dx) * Math.min(Math.abs(dx), 4 * (k + 1)), nz = a[2] + Math.sign(dz) * Math.min(Math.abs(dz), 4 * (k + 1));
      if (k > 0 && wall(x, z, y0, y1)) return false;
      if (nx !== x && nz !== z && wall(nx, z, y0, y1) && wall(x, nz, y0, y1)) return false;
    }
    return true;
  };
  for (const [i, n] of nodes.entries()) for (let dx = -LINK; dx <= LINK; dx += 4) for (let dz = -LINK; dz <= LINK; dz += 4) for (let dy = -LINKY; dy <= LINKY; dy++) {
    if (!dx && !dz && !dy) continue;
    const j = at.get((n.g[0] + dx) + ',' + (n.g[1] + dy) + ',' + (n.g[2] + dz));
    if (j !== undefined) n.adj.push([j, Math.hypot(dx * S, dy * S, dz * S) + (clear(n.g, dx, dy, dz) ? 0 : WALLPEN)]);   // through a wall: allowed (jumps), but costly
  }
  const cpParts = t.parts.filter(p => p.cp != null).sort((a, b) => a.cp - b.cp).concat([t.parts.find(p => p.name === 'Finish')]);
  const fields = cpParts.map(p => {
    const src = at.get(p.x + ',' + p.y + ',' + p.z), D = new Float64Array(nodes.length).fill(Infinity);
    D[src] = 0; const done = new Uint8Array(nodes.length);
    for (;;) {                                // small graph: O(n^2) Dijkstra is fine
      let u = -1; for (let i = 0; i < nodes.length; i++) if (!done[i] && D[i] < Infinity && (u < 0 || D[i] < D[u])) u = i;
      if (u < 0) break; done[u] = 1;
      for (const [v, w] of nodes[u].adj) if (D[u] + w < D[v]) D[v] = D[u] + w;
    }
    return D;
  });
  const cells = new Map(), CS = 20, ck = (x, z) => Math.floor(x / CS) + ',' + Math.floor(z / CS);
  nodes.forEach((n, i) => { const k = ck(n.c[0], n.c[2]); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(i); });
  const dist = (ti, p) => {                    // along-track distance from position p to target ti
    let best = Infinity; const cx = Math.floor(p[0] / CS), cz = Math.floor(p[2] / CS), D = fields[ti];
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (const i of cells.get((cx + a) + ',' + (cz + b)) || []) {
      const c = nodes[i].c, dy = p[1] - c[1];
      if (dy < -6 || dy > 12) continue;          // a node on another level is not where the car is
      // only the parts the car is on or next to (a part is 20 m): measuring straight to a farther
      // node would cut through walls; farther nodes are a fallback, at a cost
      const h = Math.hypot(p[0] - c[0], p[2] - c[2]), d = D[i] + Math.hypot(h, dy) + (h > 16 ? 200 + 4 * h : 0);
      if (d < best) best = d;
    }
    return best;
  };
  return { dist, n: cpParts.length - 1, nodes: nodes.length, reach: fields.map(D => D.filter(x => x < Infinity).length) };
}

async function child(cfg) {
  const { BLOCK, K, CELL, NOV, ACTIONS } = cfg;
  const F = trackField(), NCP = F.n;
  process.send({ log: `[${cfg.name}] track graph: ${F.nodes} nodes, reachable from each target: ${F.reach.join(' ')}` });
  const sim = await createSim(); await sim.initFast();
  // heap pages physics writes: probe a few plain drives; any page missed later is caught by bLeak
  const pages = new Set(); for (let i = 0; i < 40; i++) pages.add(i);
  for (const L of [{ up: [0] }, { up: [0], left: [500, 1500] }, { up: [0], right: [500, 1500], down: [3000, 3400] }]) {
    const full = { up: [], right: [], down: [], left: [], reset: [], ...L };
    for (const p of (await sim.probe(full, 6000, 100)).pages) pages.add(p);
  }
  await sim.raw({ op: 'bSetup', D: [...pages].sort((a, b) => a - b) });
  process.send({ log: `[${cfg.name}] setup: ${pages.size} snapshot pages` });

  const visits = new Map();
  const cellOf = (cp, p) => cp + ':' + Math.floor(p[0] / CELL) + ',' + Math.floor(p[1] / CELL) + ',' + Math.floor(p[2] / CELL);
  const score = (cp, p, v) => cp * 1e5 - Math.min(5e4, F.dist(Math.min(cp, NCP), p)) + Math.max(0, v) / 3.6 * 0.3;
  let beam = [{ id: 0, t: 0, pos: null, cp: 0, parent: null, segs: null }];
  if (process.env.START) {
    const [file, upTo] = process.env.START.split(':'), segs = eventsToSegs(JSON.parse(fs.readFileSync(file)), upTo ? +upTo : null);
    const { res } = await sim.raw({ op: 'bExpand', jobs: [{ pid: 0, cid: 1, segs }] }), r = res[0];
    if (r.err || r.fin) throw new Error('START prefix ' + (r.err || 'already finishes'));
    beam = [{ id: 1, t: r.frames, pos: r.pos, cp: r.cp, speed: r.speed, parent: beam[0], segs }];
    await sim.raw({ op: 'bKeep', ids: [1] });
    process.send({ log: `[${cfg.name}] start from ${file} at ${r.frames} ms: checkpoint ${r.cp}, ${r.speed.toFixed(0)} km/h` });
  }
  let nextId = 2, step = 0, bestFin = null, maxCp = beam[0].cp, leaksTotal = 0;
  const t0 = Date.now();
  while (beam.length) {
    step++;
    const jobs = [], meta = [];
    for (const nd of beam) for (const a of ACTIONS) { const cid = nextId++, segs = [[a, BLOCK]]; jobs.push({ pid: nd.id, cid, segs }); meta.push({ parent: nd, segs }); }
    let res;
    for (;;) { ({ res } = await sim.raw({ op: 'bExpand', jobs })); const lk = await sim.raw({ op: 'bLeak' }); if (!lk.leak.length) break; leaksTotal += lk.leak.length; }
    const fine = new Map();
    res.forEach((r, i) => {
      if (r.err) return;
      const nd = { id: r.cid, t: r.frames, pos: r.pos, cp: r.cp, speed: r.speed, parent: meta[i].parent, segs: meta[i].segs };
      if (r.fin) { if (!bestFin || nd.t < bestFin.t) { bestFin = nd; process.send({ log: `[${cfg.name}] finish at ${nd.t} (step ${step})` }); } return; }
      if (r.pos[1] < -40) return;                                 // fell off the world
      const pp = nd.parent.pos, dt = Math.max(1, nd.t - nd.parent.t);
      const head = pp ? Math.round(Math.atan2(r.pos[0] - pp[0], r.pos[2] - pp[2]) / (Math.PI / 8)) : 0;
      nd.score = score(nd.cp, r.pos, r.speed);
      nd.cell = cellOf(nd.cp, r.pos); nd.coarse = nd.cell + '|' + head;
      const fk = nd.cp + ':' + r.pos.map(x => Math.round(x / 0.4)).join(',') + '|' + Math.round(Math.atan2(r.pos[0] - (pp || r.pos)[0], r.pos[2] - (pp || r.pos)[2]) / 0.05) + '|' + Math.round(r.speed / 3);
      const c = fine.get(fk); if (!c || nd.score > c.score) fine.set(fk, nd);
    });
    const all = [...fine.values()].sort((a, b) => b.score - a.score);
    if (!all.length) break;
    for (const nd of all) visits.set(nd.cell, (visits.get(nd.cell) || 0) + 1);
    const picked = new Set(), seen = new Set();
    for (const nd of all) { if (picked.size >= Math.floor(K / 3)) break; if (!seen.has(nd.coarse)) { seen.add(nd.coarse); picked.add(nd); } }
    const top = all[0].cp;
    const fresh = all.filter(n => n.cp === top && !picked.has(n)).sort((a, b) => (visits.get(a.cell) - visits.get(b.cell)) || (b.score - a.score));
    const novCells = new Set();
    // least-visited cells first, always (a fixed visit threshold stops exploring once a dead end is crowded)
    for (const nd of fresh) { if (picked.size >= Math.floor(K / 3) + Math.floor(K / 4)) break; if (!novCells.has(nd.cell)) { novCells.add(nd.cell); picked.add(nd); } }
    for (const nd of all) { if (picked.size >= K) break; picked.add(nd); }
    beam = [...picked].sort((a, b) => b.score - a.score);
    // stop: past the time cap, or nothing alive can still beat the best finish
    beam = beam.filter(n => n.t < MAX_T && (!bestFin || n.t < bestFin.t));
    await sim.raw({ op: 'bKeep', ids: beam.map(n => n.id) });
    if (beam.length && beam[0].cp > maxCp) {
      maxCp = beam[0].cp;
      process.send({ log: `[${cfg.name}] checkpoint ${maxCp}/${NCP} at ${beam[0].t} ms (step ${step}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`, dump: { cp: maxCp, events: lineEvents(beam[0]) } });
    }
    if (step % (+process.env.LOGEVERY || 100) === 0 && beam.length) process.send({ log: `[${cfg.name}] step ${step} t=${beam[0].t} cp=${beam[0].cp} dist=${(beam[0].cp * 1e5 - beam[0].score).toFixed(1)} v=${beam[0].speed.toFixed(0)} pos=${beam[0].pos.map(x => x.toFixed(0)).join(',')} leaks=${leaksTotal} ${((Date.now() - t0) / 1000).toFixed(0)}s` });
  }
  if (!bestFin) return { name: cfg.name, finish: null, maxCp };
  return { name: cfg.name, finish: bestFin.t, events: lineEvents(bestFin) };
}

function lineEvents(nd) {                  // a node's whole input history -> [frame, key, pressed] toggles
  const chain = []; for (let n = nd; n.parent; n = n.parent) chain.push(n.segs); chain.reverse();
  const ev = [], on = { up: false, right: false, down: false, left: false }; let f = 0;
  for (const segs of chain) for (const [a, len] of segs) {
    for (const k in BIT) { const want = !!(a & BIT[k]); if (want !== on[k]) { ev.push([f, NAME[k], want]); on[k] = want; } }
    f += len;
  }
  return ev.sort((x, y) => x[0] - y[0] || x[1].localeCompare(y[1]));
}
function eventsToSegs(events, upTo) {      // [frame, key, pressed] toggles -> [[bits, frames], ...]
  const KB = { KeyW: 1, KeyD: 2, KeyS: 4, KeyA: 8 }, end = upTo ?? Math.max(0, ...events.map(e => e[0])) + 1;
  const ev = events.filter(e => KB[e[1]]).sort((x, y) => x[0] - y[0]), segs = []; let bits = 0, f = 0, i = 0;
  while (f < end) {
    while (i < ev.length && ev[i][0] <= f) { bits = ev[i][2] ? bits | KB[ev[i][1]] : bits & ~KB[ev[i][1]]; i++; }
    const next = Math.min(end, i < ev.length ? ev[i][0] : end);
    segs.push([bits, next - f]); f = next;
  }
  return segs;
}

if (process.argv[2] === 'child') {
  process.on('message', async m => { try { process.send({ result: await child(m.cfg) }); } catch (e) { process.send({ result: { name: m.cfg.name, finish: null, error: String(e && e.stack || e).slice(0, 400) } }); } });
} else {
  const outFile = process.argv[2] || 'inputs/summer5_explore.json';
  const only = process.env.CONFIGS ? process.env.CONFIGS.split(',') : CONFIGS.slice(0, +(process.env.NK || 4)).map(c => c.name);
  (async () => {
    const results = await Promise.all(CONFIGS.filter(c => only.includes(c.name)).map(cfg => new Promise(res => {
      const c = fork(__filename, ['child'], { serialization: 'advanced' });
      let done = false;
      c.on('message', m => { if (m.log) console.log(m.log); if (m.dump) fs.writeFileSync(outFile.replace(/\.json$/, `_cp${m.dump.cp}_${cfg.name}.json`), JSON.stringify(m.dump.events)); if (m.result) { done = true; res(m.result); c.kill(); } });
      c.on('exit', code => { if (!done) res({ name: cfg.name, finish: null, error: 'exited ' + code }); });
      c.send({ cfg });
    })));
    const sim = await createSim(); let best = null;
    for (const r of results) {
      if (!r.finish) { console.log(`${r.name}: no finish (max checkpoint ${r.maxCp ?? '?'})${r.error ? ' ' + r.error : ''}`); continue; }
      const L = { up: [], right: [], down: [], left: [], reset: [] }; const K2 = { KeyW: 'up', KeyD: 'right', KeyS: 'down', KeyA: 'left' };
      for (const [f, k] of r.events) L[K2[k]].push(f);
      const v = await sim.run(encodeRecording(L), 90000);
      console.log(`${r.name}: search finish ${r.finish}, clean re-simulation ${v.frames}`);
      fs.writeFileSync(outFile.replace(/\.json$/, `_${r.name}.json`), JSON.stringify(r.events));
      if (!best || v.frames < best.frames) best = { ...r, frames: v.frames };
    }
    if (best) { fs.writeFileSync(outFile, JSON.stringify(best.events)); console.log(`best: ${best.name} ${best.frames} -> ${outFile}`); }
    process.exit(0);
  })();
}
