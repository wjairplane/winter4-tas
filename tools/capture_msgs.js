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
  fs.writeFileSync(process.argv[2]+'/msgs.json', JSON.stringify(msgs.map(s=>JSON.parse(s)).filter(m=>!('up' in m && !m.trackData))));
  console.log(msgs.length, msgs.map(s=>{const m=JSON.parse(s);return m.messageType+':'+s.length}).join(' '));
  await b.close();
})();
