// Hill-climbing search for a faster Summer 1 run using the offline simulator.
// usage: node tools/optimize.js [minutes=10] [in=inputs/summer1.json] [out=inputs/summer1_opt.json]
const { fork } = require('child_process'), fs = require('fs');
const { createSim, encodeRecording, decodePos } = require('./sim.js');
const KEY = { KeyW: 'up', KeyD: 'right', KeyS: 'down', KeyA: 'left', Reset: 'reset' };
const NAME = Object.fromEntries(Object.entries(KEY).map(([a, b]) => [b, a]));

if (process.argv[2] === 'child') {
  (async () => {
    const sim = await createSim();
    await sim.initFast();
    process.send({ ready: true });
    process.on('message', async m => {
      const r = m.op === 'setBase' ? await sim.setBase(m.L, m.cap) : await sim.evalFrom(m.L, m.from, m.cap);
      process.send({ id: m.id, frames: r.frames, fin: r.fin, pos: decodePos(r.last) });
    });
  })();
} else {
  const minutes = +(process.argv[2] || 10);
  const inFile = process.argv[3] || 'inputs/summer1.json', outFile = process.argv[4] || 'inputs/summer1_opt.json';
  const lists = { up: [], right: [], down: [], left: [], reset: [] };
  for (const [f, k, d] of JSON.parse(fs.readFileSync(inFile))) lists[KEY[k]].push(f);
  for (const k in lists) lists[k].sort((a, b) => a - b);
  const clone = L => Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.slice()]));
  const rnd = n => Math.floor(Math.random() * n);
  const pick = a => a[rnd(a.length)];
  const STEER = ['right', 'left', 'down'];
  const valid = L => ['up', 'right', 'down', 'left'].every(k => L[k].every((f, i) => f >= 0 && (i === 0 || f > L[k][i - 1])));

  function mutate(L) {
    const M = clone(L), r = Math.random();
    const k = pick(STEER), l = M[k];
    if (!l.length) return null;
    const i = Math.random() < 0.5 ? Math.max(0, l.length - 1 - rnd(Math.ceil(l.length * 0.3))) : rnd(l.length);
    const d = pick([-1, 1, -2, 2, -3, 3, -5, 5, -8, 8, -15, 15, -30, 30]);
    if (r < 0.6) l[i] += d;                                           // move one toggle
    else if (r < 0.8) { const j = i ^ 1; if (j < l.length) { l[i] += d; l[j] += d; } } // move a whole tap
    else if (r < 0.9 && l.length > 2) { const j = i - (i % 2); l.splice(j, 2); }       // drop a tap
    else { const t = rnd(21500) + 200, w = 15 + rnd(60); l.push(t, t + w); l.sort((a, b) => a - b); } // add a tap
    return valid(M) ? M : null;
  }

  (async () => {
    const kids = []; const NK = 4;
    for (let i = 0; i < NK; i++) { const c = fork(__filename, ['child']); await new Promise(r => c.once('message', r)); kids.push(c); }
    let nextId = 0; const pending = new Map();
    kids.forEach(c => c.on('message', m => { const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } }));
    const send = (c, m) => new Promise(res => { const id = nextId++; pending.set(id, res); c.send({ id, ...m }); });
    const setBase = (L, cap) => Promise.all(kids.map(c => send(c, { op: 'setBase', L, cap })));
    const firstDiff = (A, B) => { let m = Infinity; for (const k of ['up', 'right', 'down', 'left']) { const n = Math.max(A[k].length, B[k].length); for (let i = 0; i < n; i++) if (A[k][i] !== B[k][i]) { m = Math.min(m, A[k][i] ?? Infinity, B[k][i] ?? Infinity); break; } } return m; };

    let best = lists, cap = 22113;                  // goal: finish at frame <= cap
    const base = (await setBase(best, 30000))[0];
    console.log('baseline frames', base.frames);
    cap = base.frames - 1;
    // reference point = where the baseline run is at the finish; closeness to it at frame `cap` = progress
    let ref = base.pos;
    const dist = p => Math.hypot(p[0] - ref[0], p[1] - ref[1], p[2] - ref[2]);
    const score = r => r.fin ? -1e6 + r.frames : dist(r.pos);
    let bestScore = score((await setBase(best, cap))[0]);
    console.log('start score', bestScore.toFixed(4));
    const t0 = Date.now(); let rounds = 0, improved = 0;
    while (Date.now() - t0 < minutes * 60000) {
      const muts = []; while (muts.length < 16 * NK) { const m = mutate(best); if (m) muts.push(m); }
      const rs = await Promise.all(muts.map((m, i) => send(kids[i % NK], { op: 'eval', L: m, from: firstDiff(best, m), cap })));
      let bi = -1, bs = bestScore;
      rs.forEach((r, i) => { const s = score(r); if (s < bs) { bs = s; bi = i; } });
      rounds++;
      if (bi >= 0) {
        best = muts[bi]; bestScore = bs; improved++;
        const finished = rs[bi].fin;
        console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] round ${rounds} score ${bs.toFixed(4)}${finished ? ` FINISHED at frame ${rs[bi].frames}` : ''}`);
        const ev = []; for (const k of ['up', 'right', 'down', 'left']) best[k].forEach((f, i) => ev.push([f, NAME[k], i % 2 === 0]));
        ev.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
        fs.writeFileSync(outFile, JSON.stringify(ev));
        if (finished) { ref = rs[bi].pos; cap = rs[bi].frames - 1; }
        bestScore = score((await setBase(best, cap))[0]);           // refresh snapshots on every worker
        if (finished) console.log('new cap', cap, 'score', bestScore.toFixed(4));
      }
    }
    console.log(`done: ${rounds} rounds, ${improved} improvements, best score ${bestScore.toFixed(4)}, cap ${cap}`);
    kids.forEach(c => c.kill()); process.exit(0);
  })();
}
