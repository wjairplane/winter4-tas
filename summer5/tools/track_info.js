// Dumps Summer 5's track parts and start transform to sim_assets/track.json.
const { createSim } = require('./sim.js'), fs = require('fs'), path = require('path');
(async () => {
  const sim = await createSim(); await sim.initFast();
  const t = await sim.trackInfo();
  fs.writeFileSync(path.join(__dirname, '..', 'sim_assets', 'track.json'), JSON.stringify({ parts: t.parts, start: t.start }));
  const counts = {}; for (const p of t.parts) counts[p.name] = (counts[p.name] || 0) + 1;
  console.log(t.parts.length, 'parts', JSON.stringify(counts));
  console.log('start', JSON.stringify(t.start));
  console.log('checkpoints/finish', JSON.stringify(t.parts.filter(p => p.cp != null || /Finish|Start/.test(p.name))));
  process.exit(0);
})();
