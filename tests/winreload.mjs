/* Phase 4b standard checks: 6-point WIN-FEASIBILITY + DOUBLE-RELOAD seed check.
   4b is perf-only (capture/projectiles/targeting/viewmodel/spawn are unchanged),
   so feasibility is shown by the capturable point pool + a live creature-behaviour
   drive (which exercises the new distance-LOD path) staying clean, rather than by
   scripting the pointer-locked capture UI (no gameplay hooks added on ?probe). */
import { chromium } from 'playwright';
import { SWIFTSHADER_ARGS, attachCollectors } from './harness.mjs';

const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
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

async function worldFacts(seed) {
  const ctx = await b.newContext({ viewport: { width: 900, height: 600 } });
  const p = await ctx.newPage();
  const bag = await attachCollectors(p);
  const url = seed == null ? 'http://localhost:8347/index.html?probe' : `http://localhost:8347/index.html?probe&seed=${seed}`;
  const ok = await loadReady(p, url);
  if (!ok) { await ctx.close(); return { fail: true }; }
  const f = await p.evaluate(() => {
    const P = window.__probe, s = P.state, C = P.CONFIG;
    // drive the live creature behaviour (exercises the 4b distance-LOD path) ~3s
    for (let i = 0; i < 180; i++) { try { P.updateCreatures(1 / 60, i / 60); } catch (e) { return { err: String(e) }; } }
    let total = 0, commons = 0, alive = 0, capturable = 0;
    for (const c of s.creatures) {
      if (!c.alive) continue;
      alive++;
      const tier = c.def && c.def.tier;
      const surface = !(c.def && (c.def.cave || c.def.caveBehavior));
      if (c.hitRadius > 0) capturable++;
      const pts = (tier === 'common') ? C.POINTS_COMMON : C.POINTS_SPECIAL;
      total += pts;
      if (tier === 'common' && surface) commons++;
    }
    return {
      seed: C.WORLD_SEED, spawnX: +s.controls.getObject().position.x.toFixed(2),
      spawnZ: +s.controls.getObject().position.z.toFixed(2),
      creatures: s.creatures.length, alive, capturable,
      pointPool: total, surfaceCommons: commons,
      required: C.CAPTURES_REQUIRED, maxChance: C.CAPTURE_MAX_CHANCE,
    };
  });
  await ctx.close();
  return { ...f, clean: bag.consoleErrors.length === 0 && bag.pageErrors.length === 0, errs: bag.consoleErrors.length + bag.pageErrors.length };
}

console.log('WIN_BEGIN');
// --- 6-point win-feasibility (pinned seed) ---
const w = await worldFacts(777);
console.log('win-feasibility (seed 777):', JSON.stringify(w));
const feasible = !w.fail && !w.err && w.pointPool >= w.required && w.surfaceCommons >= w.required;
console.log(`  WIN FEASIBLE: ${feasible}  (need ${w.required} pts; pool=${w.pointPool}, surface-commons=${w.surfaceCommons}, capturable=${w.capturable})`);

// --- double-reload seed check (two fresh loads -> different worlds, both clean) ---
const r1 = await worldFacts(null);
const r2 = await worldFacts(null);
const diffSeed = !r1.fail && !r2.fail && r1.seed !== r2.seed;
const spawnDelta = (!r1.fail && !r2.fail) ? Math.hypot(r1.spawnX - r2.spawnX, r1.spawnZ - r2.spawnZ).toFixed(1) : '?';
console.log('reload#1:', JSON.stringify({ seed: r1.seed, spawnX: r1.spawnX, spawnZ: r1.spawnZ, creatures: r1.creatures, clean: r1.clean }));
console.log('reload#2:', JSON.stringify({ seed: r2.seed, spawnX: r2.spawnX, spawnZ: r2.spawnZ, creatures: r2.creatures, clean: r2.clean }));
console.log(`  DIFFERENT WORLDS: ${diffSeed}  spawnDelta=${spawnDelta}u  bothClean=${r1.clean && r2.clean}`);
console.log('WIN_END');
await b.close();
