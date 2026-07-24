/* ============================================================
   perfbudget.mjs — instance-budget + init + fps guardrails (item 387)
   ------------------------------------------------------------
   Asserts three performance invariants the whole EXPANSION program
   quotes against:

     1. INSTANCE TOTAL  <= 42,000. The measured worst-case ceiling
        for the program. Read straight off ?probe by summing every
        InstancedMesh.count in the live scene graph. Sampled across
        several pinned seeds; the worst (max) is the number every
        later phase's handoff must stay under.

     2. INIT-TIME bound. Wall-clock from navigation to "world ready"
        (#loading hidden + window.__captcha live). Loose, because it
        includes the three.js CDN fetch and SwiftShader's software
        GL compile — this is a smoke ceiling, not a benchmark.

     3. FPS FLOOR. After pumping frames, getFps() must be above a
        SwiftShader-tolerant floor (software GL runs ~10 fps; the
        loop is dt-clamped, so any positive, non-trivial fps proves
        the rAF loop is live and not wedged).

   Usage:  node perfbudget.mjs
   Exit:   0 = all pass, 1 = any budget breach.
   ============================================================ */

import { chromium } from 'playwright';
import {
  BASE_URL, SWIFTSHADER_ARGS, attachCollectors, waitForReady, pumpFrames,
  readInstanceTotal, makeReporter, checkClean, nowMs,
} from './harness.mjs';

// Budgets / tolerances (documented; see README threshold rationale).
const INSTANCE_CEILING = 42000;  // program-wide worst-case ceiling
const INIT_BUDGET_MS = 60000;    // loose smoke ceiling incl. CDN fetch + SwiftShader
                                 // shader compile (software GL is slow, esp. cold);
                                 // catches a hang, not micro-perf.
const FPS_FLOOR = 3;             // SwiftShader-tolerant floor (software GL ~10 fps)
// item 493: draw-call budget alert so future content additions (more crystal
// clusters, more decor) don't silently regress frame time without anything
// failing. Same headroom ratio as INSTANCE_CEILING vs its measured worst-case
// (~1.2x), applied to the worst observed drawCalls (455, seed 20260718).
const DRAWCALL_CEILING = 600;

// Pinned seeds for the RENDER-based perf sample. Kept small on purpose: each
// seed here renders under SwiftShader (per-context software shader compile is
// slow), and the BROAD instance-total worst-case sweep already lives in
// fuzzseed.mjs (25+ seeds, no render). These four are a representative spread
// (two of them are the visreg pinned worlds) for the fps / init / draw budgets.
const SEEDS = [1, 777, 4242, 20260718];

async function sampleSeed(browser, seed, rep) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const bag = await attachCollectors(page);

  const url = `${BASE_URL}/index.html?probe&seed=${seed}`;
  const t0 = nowMs();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForReady(page);
  const initMs = nowMs() - t0;

  await pumpFrames(page, 30);
  const fps = await page.evaluate(() => window.__captcha.getFps());
  const inst = await readInstanceTotal(page);
  // Force one direct scene render so renderer.info reflects a real full-scene
  // draw (the parked rAF loop otherwise leaves stale 1-call/1-tri counts, and
  // the composer path hides the scene pass behind its post chain).
  const info = await page.evaluate(() => {
    const s = window.__probe && window.__probe.state;
    if (!s || !s.renderer || !s.scene || !s.camera) return null;
    try { s.renderer.render(s.scene, s.camera); } catch (e) { /* ignore */ }
    const r = s.renderer;
    return {
      calls: r.info.render.calls, triangles: r.info.render.triangles,
      geometries: r.info.memory.geometries, textures: r.info.memory.textures,
    };
  });

  await context.close();

  const total = inst ? inst.total : null;
  rep.info(`seed ${String(seed).padEnd(9)} instances=${total}  meshes=${inst ? inst.meshes : '?'}  ` +
           `init=${initMs}ms  fps=${fps}  drawCalls=${info ? info.calls : '?'}  tris=${info ? info.triangles : '?'}`);

  return { seed, total, initMs, fps, info, bag };
}

async function main() {
  const rep = makeReporter('perfbudget');
  const browser = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
  const samples = [];
  try {
    for (const seed of SEEDS) samples.push(await sampleSeed(browser, seed, rep));
  } finally {
    await browser.close();
  }

  const totals = samples.map((s) => s.total).filter((v) => typeof v === 'number');
  const worst = totals.length ? Math.max(...totals) : null;
  const worstSeed = samples.find((s) => s.total === worst);
  const maxInit = Math.max(...samples.map((s) => s.initMs));
  const minFps = Math.min(...samples.map((s) => s.fps));
  const drawCalls = samples.map((s) => (s.info ? s.info.calls : null)).filter((v) => typeof v === 'number');
  const worstDraw = drawCalls.length ? Math.max(...drawCalls) : null;
  const worstDrawSeed = samples.find((s) => s.info && s.info.calls === worstDraw);

  console.log('');
  rep.check('every seed reported an instance total', totals.length === SEEDS.length,
    `${totals.length}/${SEEDS.length}`);
  rep.check(`worst-case instance total <= ${INSTANCE_CEILING}`, worst !== null && worst <= INSTANCE_CEILING,
    `worst=${worst} (seed ${worstSeed ? worstSeed.seed : '?'})`);
  rep.check(`init time <= ${INIT_BUDGET_MS}ms (all seeds)`, maxInit <= INIT_BUDGET_MS, `max=${maxInit}ms`);
  rep.check(`fps floor > ${FPS_FLOOR} (all seeds)`, minFps > FPS_FLOOR, `min=${minFps}`);
  rep.check(`worst-case draw calls <= ${DRAWCALL_CEILING}`, worstDraw !== null && worstDraw <= DRAWCALL_CEILING,
    `worst=${worstDraw} (seed ${worstDrawSeed ? worstDrawSeed.seed : '?'})`);

  // Cleanliness across the whole run.
  const merged = { pageErrors: [], consoleErrors: [], contextLost: [] };
  for (const s of samples) {
    merged.pageErrors.push(...s.bag.pageErrors);
    merged.consoleErrors.push(...s.bag.consoleErrors);
    merged.contextLost.push(...s.bag.contextLost);
  }
  checkClean(rep, merged, 'all seeds');

  console.log(`\n  >>> MEASURED WORST-CASE INSTANCE TOTAL: ${worst} (seed ${worstSeed ? worstSeed.seed : '?'}) — headroom to ${INSTANCE_CEILING}: ${worst !== null ? INSTANCE_CEILING - worst : '?'}`);

  const ok = rep.summary();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('perfbudget crashed:', e); process.exit(2); });
