import { chromium } from "playwright";
import path from "node:path"; import fs from "node:fs";
import { PNG } from "pngjs"; import pixelmatch from "pixelmatch";
import { SWIFTSHADER_ARGS, __dirname, attachCollectors, pumpFrames, hideOverlays } from "./harness.mjs";
const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
async function loadReady(p, url){ for(let a=0;a<10;a++){ try{await p.goto(url,{waitUntil:"domcontentloaded",timeout:60000});}catch(e){} for(let i=0;i<50;i++){ const st=await p.evaluate(()=>({probe:!!window.__probe,hidden:(()=>{const l=document.getElementById("loading");return l&&l.classList.contains("hidden");})()})).catch(()=>({probe:false,hidden:false})); if(st.probe)return true; if(st.hidden&&!st.probe)break; await p.waitForTimeout(1200);} } return false; }
const ctx = await b.newContext({ viewport:{width:1280,height:720} });
const p = await ctx.newPage(); const bag = await attachCollectors(p);
const ok = await loadReady(p, "http://localhost:8347/index.html?probe&seed=20260718");
if(!ok){ console.log("LOAD FAILED (CDN)"); await b.close(); process.exit(1); }
await pumpFrames(p,20); await p.waitForTimeout(2500); await hideOverlays(p);
await p.evaluate(()=>{ const s=window.__probe.state; const d=()=>{try{(s.composer&&s.composerEnabled)?s.composer.render():s.renderer.render(s.scene,s.camera);}catch(e){}}; d();d(); });
const buf = await p.screenshot({ timeout:240000, animations:"disabled" });
fs.writeFileSync(path.join(__dirname,"output","p4b-index-seed20260718.png"), buf);
const png = PNG.sync.read(buf);
const base = PNG.sync.read(fs.readFileSync(path.join(__dirname,"baseline","index-seed20260718.png")));
const diff = new PNG({width:png.width,height:png.height});
const m = pixelmatch(base.data,png.data,diff.data,png.width,png.height,{threshold:0.2});
const frac = m/(png.width*png.height);
console.log(`seed20260718 mismatch=${(frac*100).toFixed(2)}% ${frac<=0.35?"PASS":"FAIL"} (threshold 35%) console-errs=${bag.consoleErrors.length}`);
await b.close();
