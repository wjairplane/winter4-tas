// Runs the TAS on Winter 4 in headless Chromium (needs: npm i playwright).
// usage: node tools/run_headless.js [userscript=tas-exact.user.js] [screenshot=result.png]
const { chromium } = require('playwright'), path = require('path'), fs = require('fs');
const script = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tas-exact.user.js')), shot = process.argv[3] || 'result.png';
const TRACK = 'Winter 4';
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader','--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  // never submit test runs to the online leaderboard: force the userscript's own block on,
  // and abort any submission that still reaches the network
  let blocked = 0;
  await p.route(/vps\.kodub\.com\/.*\/(leaderboard|verifyRecordings)(\?|$)/, r => r.request().method() === 'POST' ? (blocked++, r.abort()) : r.continue());
  p.on('console', msg => { if (msg.text().startsWith('[TAS]')) console.log(msg.text()); });
  await p.addInitScript({ content: fs.readFileSync(script, 'utf8').replace('const ALLOW_SUBMIT = true;', 'const ALLOW_SUBMIT = false;') });
  await p.goto('https://app-polytrack.kodub.com/0.6.3/', { waitUntil: 'load' });
  await p.waitForTimeout(6000);
  const ok = p.getByText('Ok', { exact: true }); if (await ok.count()) await ok.first().click();
  // the game opens on Summer 1: Exit -> official track list -> Winter 4 -> Play
  await p.getByText('Exit', { exact: true }).first().click(); await p.waitForTimeout(1500);
  await p.locator('button', { hasText: TRACK }).first().click(); await p.waitForTimeout(1500);
  await p.locator('button:visible', { hasText: /^\s*Play\s*$/ }).first().click(); await p.waitForTimeout(3000);
  const txt = () => p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  for (let k = 0; k < 10 && /Current 00:00\.000/.test(await txt()); k++) { // press W until the race starts
    await p.evaluate(() => { const e = t => new KeyboardEvent(t, { key: 'w', code: 'KeyW', keyCode: 87, which: 87, bubbles: true });
      document.body.dispatchEvent(e('keydown')); setTimeout(() => document.body.dispatchEvent(e('keyup')), 400); });
    await p.waitForTimeout(1200);
  }
  await p.waitForTimeout(28000);
  const t = await txt();
  // end screen text looks like "... 4/4 250km/h Record --- Current 00:12.345 00:19.311 Difference --- ... Winter 4 00:19.311 -"
  const m = t.match(new RegExp(TRACK + ' (\\d\\d:\\d\\d\\.\\d{3})')) || t.match(/(\d\d:\d\d\.\d{3}) Difference/), cps = (t.match(/(\d+)\/(\d+) \d+ ?km\/h/) || [, '?', '?']);
  console.log('final time:', m ? m[1] : 'not finished', `(checkpoints ${cps[1]}/${cps[2]}, submissions blocked: ${blocked})`);
  await p.screenshot({ path: shot });
  await b.close();
})();
