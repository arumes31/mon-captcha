import { chromium } from "playwright";
import { SWIFTSHADER_ARGS, attachCollectors } from "./harness.mjs";
const SEEDS = [777, 4242, 20260718];
const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
async function loadReady(p, url) {
  for (let a=0;a<6;a++){
    try { await p.goto(url,{waitUntil:"domcontentloaded",timeout:60000}); } catch(e){}
    for (let i=0;i<40;i++){
      const st = await p.evaluate(()=>({probe:!!window.__probe,hidden:(()=>{const l=document.getElementById("loading");return l&&l.classList.contains("hidden");})()})).catch(()=>({probe:false,hidden:false}));
      if (st.probe) return true;
      if (st.hidden && !st.probe) break;
      await p.waitForTimeout(1000);
    }
  }
  return false;
}
async function measure(seed) {
  const ctx = await b.newContext({ viewport:{width:1280,height:720} });
  const p = await ctx.newPage();
  const bag = await attachCollectors(p);
  const ok = await loadReady(p, `http://localhost:8347/index.html?probe&seed=${seed}`);
  if (!ok){ await ctx.close(); return {seed,fail:true}; }
  const r = await p.evaluate(()=>{
    const P=window.__probe, s=P.state;
    try { s.renderer.render(s.scene, s.camera); } catch(e){}
    try { P.updateCulling(); } catch(e){}
    try { s.renderer.render(s.scene, s.camera); } catch(e){}
    const S = P.perf.sample();
    return { total:S.totalInstances, before:S.baselineDrawn, after:S.drawnInstances,
             cut:S.drawCut, chunkTotal:S.chunkTotal, chunkDrawn:S.chunkDrawn,
             meshes:S.drawnMeshes+"/"+S.totalMeshes, occ:S.counters.occludedChunks, calls:S.info.calls };
  });
  await ctx.close();
  return { seed, ...r, err: bag.consoleErrors.length+bag.pageErrors.length };
}
const rows=[];
for (const seed of SEEDS){ rows.push(await measure(seed)); }
await b.close();
console.log("RESULTS_BEGIN");
console.log("seed        total  before  after  drawCut%  chunk(d/t)     meshes(d/t)  occl  calls  err");
for (const r of rows){
  if (r.fail){ console.log(`${String(r.seed).padStart(9)}  LOAD FAILED (CDN)`); continue; }
  console.log(`${String(r.seed).padStart(9)}  ${String(r.total).padStart(5)}  ${String(r.before).padStart(6)}  ${String(r.after).padStart(5)}  ${(r.cut*100).toFixed(1).padStart(7)}  ${(r.chunkDrawn+"/"+r.chunkTotal).padStart(12)}  ${r.meshes.padStart(9)}  ${String(r.occ).padStart(4)}  ${String(r.calls).padStart(5)}  ${r.err}`);
}
console.log("RESULTS_END");
