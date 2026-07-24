/* Robust visreg wrapper (Phase 4b): identical baselines + pixelmatch + 0.35
   threshold as visreg.mjs, but timer-based readiness (loadReady) + composite
   forced inside evaluate, to sidestep this environment's cold-SwiftShader
   rAF-polled waitForReady timeouts. Does NOT touch baselines. Dev-only. */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { SWIFTSHADER_ARGS, __dirname, attachCollectors, pumpFrames, hideOverlays } from './harness.mjs';

const BASELINE_DIR = path.join(__dirname, 'baseline');
const OUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });
const WIDTH = 1280, HEIGHT = 720, MISMATCH_MAX = 0.35, PIXELMATCH_THRESHOLD = 0.2;
const CASES = [
  { name: 'index-seed777', seed: 777 },
  { name: 'index-seed4242', seed: 4242 },
  { name: 'index-seed20260718', seed: 20260718 },
];

async function loadReady(p, url) {
  for (let a = 0; a < 6; a++) {
    try { await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) {}
    for (let i = 0; i < 45; i++) {
      const st = await p.evaluate(() => ({ probe: !!window.__probe, hidden: (() => { const l = document.getElementById('loading'); return l && l.classList.contains('hidden'); })() })).catch(() => ({ probe: false, hidden: false }));
      if (st.probe) return true;
      if (st.hidden && !st.probe) break;
      await p.waitForTimeout(1200);
    }
  }
  return false;
}

const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
let allPass = true;
for (const c of CASES) {
  const ctx = await b.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const p = await ctx.newPage();
  const bag = await attachCollectors(p);
  const ok = await loadReady(p, `http://localhost:8347/index.html?probe&seed=${c.seed}`);
  if (!ok) { console.log(`${c.name}: LOAD FAILED (CDN)`); allPass = false; await ctx.close(); continue; }
  await pumpFrames(p, 20);
  await p.waitForTimeout(2500);
  await hideOverlays(p);
  // force the heavy composite inside evaluate (no action timeout)
  await p.evaluate(() => {
    const s = window.__probe && window.__probe.state; if (!s || !s.renderer) return;
    const draw = () => { try { (s.composer && s.composerEnabled) ? s.composer.render() : s.renderer.render(s.scene, s.camera); } catch (e) {} };
    draw(); draw();
  });
  const buffer = await p.screenshot({ timeout: 240000, animations: 'disabled' });
  fs.writeFileSync(path.join(OUT_DIR, `p4b-${c.name}.png`), buffer);
  const png = PNG.sync.read(buffer);
  const base = PNG.sync.read(fs.readFileSync(path.join(BASELINE_DIR, `${c.name}.png`)));
  let verdict = 'DIM MISMATCH';
  if (base.width === png.width && base.height === png.height) {
    const diff = new PNG({ width: png.width, height: png.height });
    const mism = pixelmatch(base.data, png.data, diff.data, png.width, png.height, { threshold: PIXELMATCH_THRESHOLD });
    const frac = mism / (png.width * png.height);
    const pass = frac <= MISMATCH_MAX;
    if (!pass) allPass = false;
    verdict = `${(frac * 100).toFixed(2)}% ${pass ? 'PASS' : 'FAIL'} (threshold ${MISMATCH_MAX * 100}%)`;
  } else { allPass = false; }
  console.log(`${c.name.padEnd(20)} mismatch=${verdict}  console-errs=${bag.consoleErrors.length}`);
  await ctx.close();
}
await b.close();
console.log(allPass ? 'ROBUSTVISREG: ALL PASS' : 'ROBUSTVISREG: SOME FAIL');
