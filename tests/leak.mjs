/* Phase 4b leak audit (item 351): init -> destroy x5, watch renderer.info +
   scene object counts for monotonic growth. Uses ?probe + __captcha.init/destroy.
   NOT part of the standard suite — a one-off audit tool run for the 4b handoff. */
import { chromium } from 'playwright';
import { SWIFTSHADER_ARGS, attachCollectors, pumpFrames } from './harness.mjs';

const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });

async function loadReady(p, url) {
  for (let a = 0; a < 6; a++) {
    try { await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) {}
    for (let i = 0; i < 40; i++) {
      const st = await p.evaluate(() => ({ probe: !!window.__probe, hidden: (() => { const l = document.getElementById('loading'); return l && l.classList.contains('hidden'); })() })).catch(() => ({ probe: false, hidden: false }));
      if (st.probe) return true;
      if (st.hidden && !st.probe) break;
      await p.waitForTimeout(1200);
    }
  }
  return false;
}

const ctx = await b.newContext({ viewport: { width: 1024, height: 640 } });
const p = await ctx.newPage();
const bag = await attachCollectors(p);
const ok = await loadReady(p, 'http://localhost:8347/index.html?probe&seed=4242');
if (!ok) { console.log('LOAD FAILED (CDN)'); await b.close(); process.exit(2); }
await pumpFrames(p, 14);

async function snap(label) {
  return p.evaluate((label) => {
    const s = window.__probe.state;
    try { s.renderer.render(s.scene, s.camera); } catch (e) {}
    const r = s.renderer.info;
    let inst = 0, meshes = 0, sceneKids = s.scene ? s.scene.children.length : -1;
    s.scene.traverse((o) => { if (o.isInstancedMesh) { inst += o.count || 0; meshes++; } });
    return { label, geometries: r.memory.geometries, textures: r.memory.textures,
             programs: r.programs ? r.programs.length : -1, instances: inst, instMeshes: meshes, sceneKids };
  }, label);
}

const rows = [await snap('init#1')];
for (let i = 2; i <= 6; i++) {
  await p.evaluate(() => window.__captcha.destroy());
  await p.waitForTimeout(300);
  await p.evaluate(() => window.__captcha.init());
  await p.waitForTimeout(800);
  await pumpFrames(p, 10);
  rows.push(await snap('init#' + i));
}

console.log('LEAK_BEGIN');
console.log('cycle    geometries  textures  programs  instances  instMeshes  sceneKids');
for (const r of rows) {
  console.log(`${r.label.padEnd(7)}  ${String(r.geometries).padStart(10)}  ${String(r.textures).padStart(8)}  ${String(r.programs).padStart(8)}  ${String(r.instances).padStart(9)}  ${String(r.instMeshes).padStart(10)}  ${String(r.sceneKids).padStart(9)}`);
}
console.log(`console errors: ${bag.consoleErrors.length}  pageerrors: ${bag.pageErrors.length}`);
console.log('LEAK_END');
await b.close();
