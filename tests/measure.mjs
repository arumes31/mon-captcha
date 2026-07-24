import { chromium } from "playwright";
import { SWIFTSHADER_ARGS, attachCollectors, pumpFrames } from "./harness.mjs";

const SEEDS = [20260718, 777];
const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });

async function loadReady(p, url) {
  for (let attempt=0; attempt<6; attempt++) {
    try { await p.goto(url, { waitUntil:"domcontentloaded", timeout:60000 }); } catch(e){}
    for (let i=0;i<40;i++){
      const st = await p.evaluate(()=>({ probe: !!window.__probe, hidden: (()=>{const l=document.getElementById("loading"); return l&&l.classList.contains("hidden");})() })).catch(()=>({probe:false,hidden:false}));
      if (st.probe) return true;
      if (st.hidden && !st.probe) break;
      await p.waitForTimeout(1200);
    }
  }
  return false;
}

async function measure(seed, nochunk) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  const bag = await attachCollectors(p);
  const q = nochunk ? "probe&nochunk" : "probe";
  const ok = await loadReady(p, `http://localhost:8347/index.html?${q}&seed=${seed}`);
  if (!ok) { await ctx.close(); return { seed, nochunk, fail:true }; }
  await pumpFrames(p, 16);
  const r = await p.evaluate(() => {
    const P = window.__probe; const s = P.state;
    try { s.renderer.render(s.scene, s.camera); } catch(e) {}
    try { P.updateCulling(); } catch(e) {}
    try { s.renderer.render(s.scene, s.camera); } catch(e) {}
    const samp = P.perf.sample();
    return { total: samp.totalInstances, drawn: samp.drawnInstances,
             totalMeshes: samp.totalMeshes, drawnMeshes: samp.drawnMeshes,
             occluded: samp.counters.occludedChunks, calls: samp.info.calls, tris: samp.info.triangles };
  });
  await ctx.close();
  return { seed, nochunk, ...r, dirty: bag.consoleErrors.length + bag.pageErrors.length };
}

const rows = [];
for (const seed of SEEDS) { rows.push(await measure(seed, true)); rows.push(await measure(seed, false)); }
await b.close();
console.log("RESULTS_BEGIN");
console.log("seed        mode      total  drawn  cut%   meshes(d/t)  occl  drawCalls  tris      dirty");
for (const r of rows) {
  if (r.fail) { console.log(`${String(r.seed).padStart(9)}  ${(r.nochunk?"NOCHUNK":"chunked").padEnd(8)}  LOAD FAILED (CDN)`); continue; }
  const cut = ((1 - r.drawn / r.total) * 100).toFixed(1);
  console.log(`${String(r.seed).padStart(9)}  ${(r.nochunk?"NOCHUNK":"chunked").padEnd(8)}  ${String(r.total).padStart(5)}  ${String(r.drawn).padStart(5)}  ${cut.padStart(5)}  ${(r.drawnMeshes+"/"+r.totalMeshes).padStart(9)}  ${String(r.occluded).padStart(4)}  ${String(r.calls).padStart(8)}  ${String(r.tris).padStart(8)}  ${r.dirty}`);
}
console.log("RESULTS_END");
