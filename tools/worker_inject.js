// Injected into PolyTrack's physics worker (same scope as its message handler) by tools/sim.js.
// Gives a single-car simulator with heap snapshots so runs can resume mid-way.
const __S={snaps:new Map(),K:1000,zero:null};
const __KEYS=["up","right","down","left","reset"];
function __pos(b){const v=new DataView(b);const u=new Uint8Array(b);const o=(u[11]&2)?17:14;return[v.getFloat32(o,!0),v.getFloat32(o+4,!0),v.getFloat32(o+8,!0)]}
function __quat(b){const u=new Uint8Array(b),v=new DataView(b),o=((u[11]&2)?17:14)+12;return[v.getFloat32(o,!0),v.getFloat32(o+4,!0),v.getFloat32(o+8,!0),v.getFloat32(o+12,!0)]}
function __cp(b){const u=new Uint8Array(b);return new DataView(b).getUint16((u[11]&2)?15:12,!0)}
function __go(L,h,cap,record,sample,cpStop){
  const idx={},ctl={};let last=null;
  const S=sample?[]:null;
  const P=record?new Float32Array(3*(cap+1)):null,V=record?new Float32Array(cap+1):null,C=record?new Uint16Array(cap+1):null;
  for(const k of __KEYS)idx[k]=0;
  const sp=self.__wx&&typeof self.__wx.w==="function"?self.__wx.w():null;let crashed=null;
  try{
  while(!h.hasFinished&&h.frames<cap){
    const f=h.frames;
    for(const k of __KEYS){const a=L[k];let i=idx[k];while(i<a.length&&a[i]<=f)i++;idx[k]=i;ctl[k]=(i&1)==1}
    const b=n(h,ctl);h.hasFinished=Xo(new Uint8Array(b));h.frames++;last=b;
    if(cpStop&&__cp(b)>=cpStop)break;
    if(sample&&h.frames%sample==0)S.push(h.frames,...__pos(b));
    if(record){const p=__pos(b);P.set(p,3*h.frames);V[h.frames]=new DataView(b).getFloat32(7,!0);C[h.frames]=__cp(b);
      if(h.frames%__S.K==0&&!h.hasFinished)__S.snaps.set(h.frames,new Uint8Array(t.HEAPU8));}
  }
  }catch(e){if(sp!==null)self.__wx.u(sp);crashed=String(e&&e.message||e).slice(0,120)}
  // a physics trap, or no frame simulated (cap <= start): report a far-away, unfinished state instead of throwing
  if(crashed||!last){const r={op:"res",frames:h.frames,fin:false,last:null,pos:[1e9,1e9,1e9],speed:0,cp:0,err:crashed||"no frames simulated"};
    if(sample)r.S=S;if(record){r.P=P.subarray(0,3*(h.frames+1));r.V=V.subarray(0,h.frames+1);r.C=C.subarray(0,h.frames+1)}return r}
  const r={op:"res",frames:h.frames,fin:h.hasFinished,last:new Uint8Array(last),pos:__pos(last),speed:new DataView(last).getFloat32(7,!0),cp:__cp(last)};
  if(sample)r.S=S;
  if(record){r.P=P.subarray(0,3*(h.frames+1));r.V=V.subarray(0,h.frames+1);r.C=C.subarray(0,h.frames+1)}
  return r;
}

// ---- beam search support: many car states kept as snapshots of only the heap pages that change ----
const __B={D:null,states:new Map(),PG:4096};
function __snapD(){const D=__B.D,H=t.HEAPU8,P=__B.PG,o=new Uint8Array(D.length*P);for(let i=0;i<D.length;i++)o.set(H.subarray(D[i]*P,D[i]*P+P),i*P);return o}
function __restD(s){const D=__B.D,H=t.HEAPU8,P=__B.PG;for(let i=0;i<D.length;i++)H.set(s.subarray(i*P,i*P+P),D[i]*P)}
function __beam(m){
  if(m.op==="bSetup"){t.HEAPU8.set(__S.zero);__B.D=m.D.slice();__B.states.clear();__B.states.set(0,{snap:__snapD(),frames:0,fin:false});return{ok:true,pages:__B.D.length}}
  if(m.op==="bExpand"){
    const out=[],ctl={up:false,right:false,down:false,left:false,reset:false};
    const sp=self.__wx&&typeof self.__wx.w==="function"?self.__wx.w():null;   // stackSave: a wasm trap leaves the stack pointer where it was
    for(const j of m.jobs){
      try{
        const st=__B.states.get(j.pid);__restD(st.snap);
        const h={id:0,hasFinished:st.fin,frames:st.frames};let last=null;
        for(const sg of j.segs){const b=sg[0];ctl.up=!!(b&1);ctl.right=!!(b&2);ctl.down=!!(b&4);ctl.left=!!(b&8);
          for(let k=0;k<sg[1]&&!h.hasFinished;k++){last=n(h,ctl);h.hasFinished=Xo(new Uint8Array(last));h.frames++}}
        __B.states.set(j.cid,{snap:__snapD(),frames:h.frames,fin:h.hasFinished});
        out.push({cid:j.cid,frames:h.frames,fin:h.hasFinished,pos:__pos(last),speed:new DataView(last).getFloat32(7,!0),cp:__cp(last)});
      }catch(e){ // usually a page outside D written by an earlier job of this step; the caller leak-checks and re-runs
        if(sp!==null)self.__wx.u(sp);
        out.push({cid:j.cid,err:String(e&&e.message||e).slice(0,120)});
      }
    }
    return{res:out};
  }
  if(m.op==="bKeep"){const keep=new Set(m.ids);for(const k of [...__B.states.keys()])if(!keep.has(k))__B.states.delete(k);return{n:__B.states.size}}
  if(m.op==="bLeak"){ // pages outside D that differ from the post-init heap = pages the snapshots miss
    const P=__B.PG,inD=new Uint8Array(Math.ceil(__S.zero.length/P));for(const pg of __B.D)inD[pg]=1;
    const H=new Int32Array(t.HEAPU8.buffer,0,__S.zero.length>>2),Z=new Int32Array(__S.zero.buffer,__S.zero.byteOffset,__S.zero.length>>2),W=P>>2,leak=[];
    for(let pg=0;pg<inD.length;pg++){if(inD[pg])continue;const o=pg*W;for(let i=o;i<o+W;i++)if(H[i]!==Z[i]){leak.push(pg);break}}
    if(leak.length){ // extend D; stored snapshots never touched these pages (checked every step), so post-init content is exact
      const Zb=__S.zero;
      for(const [id,st] of __B.states){const ns=new Uint8Array((__B.D.length+leak.length)*P);ns.set(st.snap);leak.forEach((pg,i)=>ns.set(Zb.subarray(pg*P,pg*P+P),(__B.D.length+i)*P));st.snap=ns}
      __B.D=__B.D.concat(leak);
    }
    return{leak};
  }
  return null;
}

// ---- closed-loop tail: replay the reference by track progress, correct steering when off-heading ----
const __C={P:null,bits:null,N:0};
function __yaw(q){const[x,y,z,w]=q;const fx=2*(x*z+w*y),fz=1-2*(x*x+y*y);return Math.atan2(fx,fz)}  // heading of local +z
function __ctlRun(m){
  let F=0;for(const k of __S.snaps.keys())if(k<=m.from&&k>F)F=k;t.HEAPU8.set(__S.snaps.get(F));
  const P=__C.P,RB=__C.bits,N=__C.N,h={id:0,hasFinished:false,frames:F},idx={},ctl={},out=new Uint8Array(m.cap+1);
  for(const k of __KEYS)idx[k]=0;
  let j=F,last=null,over=0,lastOff=0,corr=false;
  const near=(p)=>{let bd=1e18,bj=j;const lo=Math.max(0,Math.floor(j)-30),hi=Math.min(N-2,Math.floor(j)+90);
    for(let i=lo;i<hi;i++){const ax=P[3*i],az=P[3*i+2],bx=P[3*i+3]-ax,bz=P[3*i+5]-az,L2=bx*bx+bz*bz||1e-12;
      let u=((p[0]-ax)*bx+(p[2]-az)*bz)/L2;u=Math.max(0,Math.min(1,u));const dx=ax+u*bx-p[0],dz=az+u*bz-p[2],d=dx*dx+dz*dz;if(d<bd){bd=d;bj=i+u}}
    j=bj;return Math.sqrt(bd)};
  while(!h.hasFinished&&h.frames<m.cap){
    const f=h.frames;let bits=0;
    if(f<m.cut){for(const k of __KEYS){const a=m.L[k];let i=idx[k];while(i<a.length&&a[i]<=f)i++;idx[k]=i;if(i&1)bits|=({up:1,right:2,down:4,left:8})[k]||0}}
    else{
      const ji=Math.max(0,Math.min(N-1,Math.round(j)));bits=RB[ji];
      if(last){const p=__pos(last),q=__quat(last),tg=Math.min(N-2,ji+m.look);
        const want=Math.atan2(P[3*tg]-p[0],P[3*tg+2]-p[2]);let e=want-__yaw(q);while(e>Math.PI)e-=2*Math.PI;while(e<-Math.PI)e+=2*Math.PI;
        if(m.mode==='off'){ // correct only when sideways off the reference line by > dOff, until back within dOff/2
          if(lastOff>m.dOff)corr=true;else if(lastOff<m.dOff*0.5)corr=false;
          if(corr){bits&=~10;if(e>m.thr)bits|=8;else if(e<-m.thr)bits|=2;over++}
        }else if(m.mode==='pp'||Math.abs(e)>m.thr){bits&=~10;if(e>m.thr*0.5)bits|=8;else if(e<-m.thr*0.5)bits|=2;over++}}
    }
    ctl.up=!!(bits&1);ctl.right=!!(bits&2);ctl.down=!!(bits&4);ctl.left=!!(bits&8);ctl.reset=false;
    const b=n(h,ctl);h.hasFinished=Xo(new Uint8Array(b));out[f]=bits;h.frames++;last=b;lastOff=near(__pos(b));
  }
  return{frames:h.frames,fin:h.hasFinished,cp:__cp(last),pos:__pos(last),speed:new DataView(last).getFloat32(7,!0),overrides:over,bits:out.slice(0,h.frames)};
}
function __custom(m){
  if(m.op==='ctlSetup'){__C.P=m.P;__C.bits=m.bits;__C.N=m.N;postMessage({op:'res',id:m.id,ok:true});return}
  if(m.op==='ctlRun'){const r=__ctlRun(m);r.op='res';r.id=m.id;postMessage(r);return}
  if(m.op&&m.op[0]==='b'&&m.op!=='bad'){const r=__beam(m);if(r){r.op='res';r.id=m.id;postMessage(r);return}}
  if(m.op==="init"){
    const i=Ko.fromSaveString(m.trackData);const o=i.getStartTransform();
    s(0,m.mountainVertices,new R(m.mountainOffset.x,m.mountainOffset.y,m.mountainOffset.z),i,o);
    __S.zero=new Uint8Array(t.HEAPU8);__S.snaps.set(0,__S.zero);
    postMessage({op:"init",heap:t.HEAPU8.length});
  }else if(m.op==="setBase"){
    __S.snaps.clear();__S.snaps.set(0,__S.zero);t.HEAPU8.set(__S.zero);
    const r=__go(m.L,{id:0,hasFinished:false,frames:0},m.cap,true);r.id=m.id;postMessage(r);
  }else if(m.op==="quatProbe"){
    t.HEAPU8.set(__S.zero);const h={id:0,hasFinished:false,frames:0},out=[],ctl={},idx={};for(const k of __KEYS)idx[k]=0;
    while(!h.hasFinished&&h.frames<m.cap){const f=h.frames;for(const k of __KEYS){const a=m.L[k];let i=idx[k];while(i<a.length&&a[i]<=f)i++;idx[k]=i;ctl[k]=(i&1)==1}
      const b=n(h,ctl);h.hasFinished=Xo(new Uint8Array(b));h.frames++;if(h.frames%m.every==0)out.push([h.frames,...__pos(b),...__quat(b)])}
    postMessage({op:"res",id:m.id,out});
  }else if(m.op==="probe"){
    // which 4 KB heap pages ever differ from the post-init heap while driving L?
    t.HEAPU8.set(__S.zero);const PG=4096,Z=__S.zero,dirty=new Set();
    const h={id:0,hasFinished:false,frames:0};
    for(let stop=m.every;stop<=m.cap;stop+=m.every){
      __go(m.L,h,stop,false);const H=t.HEAPU8;
      for(let pg=0;pg*PG<Z.length;pg++){if(dirty.has(pg))continue;const o=pg*PG;
        for(let i=o;i<o+PG;i+=8)if(H[i]!==Z[i]||H[i+1]!==Z[i+1]||H[i+2]!==Z[i+2]||H[i+3]!==Z[i+3]||H[i+4]!==Z[i+4]||H[i+5]!==Z[i+5]||H[i+6]!==Z[i+6]||H[i+7]!==Z[i+7]){dirty.add(pg);break}}
      if(h.hasFinished)break;
    }
    postMessage({op:"res",id:m.id,pages:[...dirty].sort((a,b)=>a-b),heap:t.HEAPU8.length});
  }else if(m.op==="eval"){
    let F=0;for(const k of __S.snaps.keys())if(k<=m.from&&k>F)F=k;
    t.HEAPU8.set(__S.snaps.get(F));
    const r=__go(m.L,{id:0,hasFinished:false,frames:F},m.cap,false,m.sample||0,m.cpStop||0);r.id=m.id;r.resumedFrom=F;postMessage(r);
  }
}
