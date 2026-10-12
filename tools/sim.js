// Offline simulator: runs PolyTrack's own physics worker + wasm in Node.
// Needs (see tools/fetch_sim_assets.sh): sim_assets/{worker.js,polytrack_physics.js,polytrack_physics.wasm,msgs.json}
const fs = require('fs'), path = require('path'), vm = require('vm');
const A = path.join(__dirname, '..', 'sim_assets');
const dec = v => {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === 'object') {
    if (v.__t && v.b64 !== undefined) { const b = Buffer.from(v.b64, 'base64'); const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length); return new globalThis[v.__t](ab); }
    const o = {}; for (const k in v) o[k] = dec(v[k]); return o;
  }
  return v;
};

async function createSim() {
  const msgs = JSON.parse(fs.readFileSync(path.join(A, 'msgs.json')));
  const init = dec(msgs.find(m => m.messageType === 0 && m.isRealtime === false));
  const create = dec(msgs.find(m => m.messageType === 3));
  let src = fs.readFileSync(path.join(A, 'worker.js'), 'utf8');
  // report the final state buffer too
  src = src.replace('function r(i){const r=i.data;switch(r.messageType){case Ki.Init:', fs.readFileSync(path.join(__dirname, 'worker_inject.js'), 'utf8') + 'function r(i){const r=i.data;if(r.messageType===77){__custom(r);return}switch(r.messageType){case Ki.Init:');
  src = src.replace('postMessage({messageType:Ki.VerifyResult,carId:l,result:A})',
    'postMessage({messageType:Ki.VerifyResult,carId:l,result:A,frames:h.frames,last:new Uint8Array(h.last)})');
  src = src.replace('h.hasFinished=Xo(new Uint8Array(t)),h.frames++', 'h.last=t,h.hasFinished=Xo(new Uint8Array(t)),h.frames++');
  const g = globalThis;
  g.self = g; g.addEventListener = () => {}; g.onmessage = null;
  g.location = { href: 'https://x/0.6.3/simulation_worker.bundle.js' };
  const realProcess = g.process;
  const asBrowser = fn => { Object.defineProperty(g, 'process', { value: undefined, configurable: true, writable: true }); try { return fn(); } finally { Object.defineProperty(g, 'process', { value: realProcess, configurable: true, writable: true }); } };
  g.importScripts = f => asBrowser(() => vm.runInThisContext(fs.readFileSync(path.join(A, 'polytrack_physics.js'), 'utf8')));
  g.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => { const b = fs.readFileSync(path.join(A, 'polytrack_physics.wasm')); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  // keep the wasm exports (stackSave = w, stackRestore = u) so a trapped step can reset the stack pointer
  if (!WebAssembly.__tasWrapped) {
    const wi = WebAssembly.instantiate;
    WebAssembly.instantiate = async (...a) => {
      const r = await wi.apply(WebAssembly, a), ex = (r.instance || r).exports;
      if (typeof ex.u === 'function' && typeof ex.w === 'function' && typeof ex.r === 'function') g.__wx = ex;   // the physics module (a maths module is loaded too)
      return r;
    };
    WebAssembly.__tasWrapped = true;
  }
  let resolveNext;
  const waiters = new Map();
  g.postMessage = m => { if (m.op) { const key = m.id !== undefined ? m.id : m.op; const w = waiters.get(key); if (w) { waiters.delete(key); w(m); } return; } if (m.messageType === 8 && resolveNext) { const r = resolveNext; resolveNext = null; r(m); } };
  g.requestAnimationFrame = undefined;
  asBrowser(() => vm.runInThisContext(src));
  await new Promise(r => setTimeout(r, 1000));            // wasm init
  g.onmessage({ data: init });
  const run = (recordingB64, targetFrames) => new Promise(res => {
    resolveNext = res;
    g.onmessage({ data: { messageType: 1, carId: 0, trackData: create.trackData, mountainVertices: create.mountainVertices,
      mountainOffset: create.mountainOffset, carRecording: recordingB64, targetFrames } });
  });
  let cid = 1;
  const call = (msg, key) => new Promise(res => { waiters.set(key, res); g.onmessage({ data: { messageType: 77, ...msg } }); });
  const initFast = () => call({ op: 'init', trackData: create.trackData, mountainVertices: create.mountainVertices, mountainOffset: create.mountainOffset }, 'init');
  const setBase = (L, cap) => { const id = cid++; return call({ op: 'setBase', L, cap, id }, id); };
  const evalFrom = (L, from, cap, sample, cpStop) => { const id = cid++; return call({ op: 'eval', L, from, cap, sample, cpStop, id }, id); };
  const probe = (L, cap, every) => { const id = cid++; return call({ op: 'probe', L, cap, every, id }, id); };
  const raw = msg => { const id = cid++; return call({ ...msg, id }, id); };
  return { run, initFast, setBase, evalFrom, probe, raw };
}
module.exports = { createSim };

// ---- recording encode/decode (format reverse-engineered from the game) ----
const zlib = require('zlib');
const LISTS = ['up', 'right', 'down', 'left', 'reset'];
function encodeRecording(lists) {            // lists: {up:[frames],...}; frames strictly increasing
  const parts = [];
  for (const k of LISTS) {
    const l = lists[k] || [], b = Buffer.alloc(3 + 3 * l.length);
    b.writeUIntLE(l.length, 0, 3);
    let prev = 0;
    l.forEach((f, i) => { b.writeUIntLE(i === 0 ? f : f - prev, 3 + 3 * i, 3); prev = f; });
    parts.push(b);
  }
  return zlib.deflateSync(Buffer.concat(parts)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodePos(last) {                   // car position from the worker state buffer
  const b = Buffer.from(last);
  const off = (b[11] & 2) ? 17 : 14;
  return [b.readFloatLE(off), b.readFloatLE(off + 4), b.readFloatLE(off + 8)];
}
module.exports.encodeRecording = encodeRecording;
module.exports.decodePos = decodePos;
