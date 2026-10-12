// Captures the Init and Summer 5 track messages the physics worker needs (for tools/sim.js).
// usage: node tools/capture_msgs.js sim_assets
const { chromium } = require('playwright'); const fs = require('fs');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader','--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const msgs = [];
  await p.exposeFunction('__cap', s => msgs.push(s));
  await p.addInitScript(() => {
    const enc = v => {
      if (ArrayBuffer.isView(v)) { let s=''; const u=new Uint8Array(v.buffer,v.byteOffset,v.byteLength); for (let i=0;i<u.length;i+=8192) s+=String.fromCharCode.apply(null,u.subarray(i,i+8192)); return {__t:v.constructor.name,b64:btoa(s)}; }
      if (Array.isArray(v)) return v.map(enc);
      if (v && typeof v==='object') { const o={}; for (const k in v) o[k]=enc(v[k]); return o; }
      return v;
    };
    const W = window.Worker;
    window.Worker = function(u,o){ const w=new W(u,o); const pm=w.postMessage.bind(w);
      w.postMessage=(m,t)=>{ try{ if(m&&(m.messageType===0||m.messageType===1||m.messageType===undefined||true)) window.__cap(JSON.stringify(enc(m))); }catch(e){} return pm(m,t); }; return w; };
  });
  await p.goto('https://app-polytrack.kodub.com/0.6.3/', { waitUntil: 'load' });
  await p.waitForTimeout(8000);
  // the page opens on Summer 1; drop its messages (keep the Init ones) and load Summer 5
  const ok = p.getByText('Ok', { exact: true }); if (await ok.count()) await ok.first().click();
  await p.getByText('Exit', { exact: true }).first().click(); await p.waitForTimeout(1500);
  msgs.splice(0, msgs.length, ...msgs.filter(s => JSON.parse(s).messageType === 0));
  await p.locator('button', { hasText: 'Summer 5' }).first().click(); await p.waitForTimeout(1500);
  await p.locator('button:visible', { hasText: /^\s*Play\s*$/ }).first().click(); await p.waitForTimeout(5000);
  fs.writeFileSync(process.argv[2]+'/msgs.json', JSON.stringify(msgs.map(s=>JSON.parse(s)).filter(m=>!('up' in m && !m.trackData))));
  console.log(msgs.length, msgs.map(s=>{const m=JSON.parse(s);return m.messageType+':'+s.length}).join(' '));
  await b.close();
})();
