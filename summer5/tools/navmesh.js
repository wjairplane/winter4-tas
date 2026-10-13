// Builds a "where have we actually driven" map from our own saved runs, for explore.js (EMP=...).
// Every run is replayed in the offline simulator; its positions are put in 3 m cells, and each move
// from one cell to the next becomes a directed edge costing the time it took. For each target
// (checkpoint k, then the finish), a backward Dijkstra from the cells where that target was
// collected gives the fastest known time-to-go from every visited cell.
// usage: node tools/navmesh.js <out.json> <run.json[:end_frame]> ...
//   runs: event lists or beam.js BDUMP files (our own runs only)
const { createSim } = require('./sim.js'), fs = require('fs');
const CELL = 3, STEP = 20;          // cell size (m), sample every STEP frames
const KEY = { KeyW: 'up', KeyD: 'right', KeyS: 'down', KeyA: 'left' };
const cellKey = p => Math.floor(p[0] / CELL) + ',' + Math.floor(p[1] / CELL) + ',' + Math.floor(p[2] / CELL);

function listsOf(file) {
  const saved = JSON.parse(fs.readFileSync(file)), L = { up: [], right: [], down: [], left: [], reset: [] };
  if (Array.isArray(saved)) { for (const [f, k] of saved) L[KEY[k]].push(f); return { L, end: Math.max(0, ...saved.map(e => e[0])) + 1 }; }
  const K = { 1: 'up', 2: 'right', 4: 'down', 8: 'left' };       // BDUMP: per-frame bits
  for (const bit of [1, 2, 4, 8]) { let on = false; saved.bits.forEach((b, f) => { const w = !!(b & bit); if (w !== on) { L[K[bit]].push(f); on = w; } }); }
  return { L, end: saved.bits.length };
}

(async () => {
  const [out, ...runs] = process.argv.slice(2);
  const sim = await createSim(); await sim.initFast();
  const edges = new Map();               // "from>to" -> min frames
  const arrive = new Map();              // target index -> Set of cells where it was collected
  let samples = 0;
  for (const spec of runs) {
    const [file, endArg] = spec.split(':'); const { L, end } = listsOf(file), cap = endArg ? +endArg : end + 3000;
    const r = await sim.setBase(L, cap);  // records position (P) and checkpoint count (C) per frame
    const P = r.P, C = r.C, n = C.length;
    let prev = null, prevF = 0;
    for (let f = STEP; f < n; f += STEP) {
      const p = [P[3 * f], P[3 * f + 1], P[3 * f + 2]], c = cellKey(p);
      if (C[f] > C[f - STEP]) { const k = C[f] - 1; if (!arrive.has(k)) arrive.set(k, new Set()); arrive.get(k).add(c); }
      if (prev && prev !== c) { const e = prev + '>' + c, w = f - prevF; if (!edges.has(e) || w < edges.get(e)) edges.set(e, w); prev = c; prevF = f; }
      else if (!prev) { prev = c; prevF = f; }
      samples++;
    }
    if (r.fin) { const k = Math.max(...C); const c = cellKey([P[3 * (n - 1)], P[3 * (n - 1) + 1], P[3 * (n - 1) + 2]]); if (!arrive.has(k)) arrive.set(k, new Set()); arrive.get(k).add(c); }
    console.log(`${file}: ${n} frames, checkpoints ${Math.max(...C)}${r.fin ? ', finished' : ''}`);
  }
  // backward Dijkstra per target over reversed edges, with a binary heap
  const heap = () => { const a = []; return {
    get size() { return a.length; },
    push(x) { a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } },
    pop() { const top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; } }; };
  const rev = new Map(); for (const [e, w] of edges) { const [a, b] = e.split('>'); if (!rev.has(b)) rev.set(b, []); rev.get(b).push([a, w]); }
  const fields = {};
  for (const [k, cells] of [...arrive].sort((a, b) => a[0] - b[0])) {
    const D = new Map(), queue = heap();
    for (const c of cells) { D.set(c, 0); queue.push([0, c]); }
    while (queue.size) {
      const [d, u] = queue.pop();
      if (d > D.get(u)) continue;
      for (const [v, w] of rev.get(u) || []) { const nd = d + w; if (!D.has(v) || nd < D.get(v)) { D.set(v, nd); queue.push([nd, v]); } }
    }
    fields[k] = Object.fromEntries(D);
    console.log(`target ${k}: ${cells.size} arrival cells, ${D.size} cells with a known time-to-go`);
  }
  fs.writeFileSync(out, JSON.stringify({ cell: CELL, fields }));
  console.log(`${samples} samples, ${edges.size} edges -> ${out}`);
  process.exit(0);
})();
