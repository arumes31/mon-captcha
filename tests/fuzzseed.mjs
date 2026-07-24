/* ============================================================
   fuzzseed.mjs — many-seed invariance sweep (item 391)
   ------------------------------------------------------------
   Loads N (>= 25) pinned ?seed= worlds and asserts, per seed:

     - zero console ERRORS / pageerrors / WebGL context-loss,
     - spawn success  : the surface creature deck actually placed
       (state.creatures.length above a healthy floor; the
       "spawned N/x" shortfall warning is tolerated but logged),
     - budget          : InstancedMesh total within the ceiling,
     - cave-traversal invariants exposed on ?probe:
         * every seeded cave has >=1 entrance and a main path,
         * caveDeepPoint(cave) lands INSIDE the cave (caveAt truthy)
           and its passage is wide enough for the player to fit
           (hw >= PLAYER_RADIUS + margin) — i.e. the deepest node is
           actually reachable, never a clip-through-rock dead spot,
         * caveDeadEnds(cave) returns an array (dead-end registry
           the cave-capture rewards read).

   A seed with zero caves is valid (some worlds have none) and its
   cave asserts are skipped with a note.

   Usage:  node fuzzseed.mjs [count]   (default 30)
   Exit:   0 = all seeds clean, 1 = any failure.
   ============================================================ */

import { chromium } from 'playwright';
import {
  BASE_URL, SWIFTSHADER_ARGS, attachCollectors, waitForReady,
  readInstanceTotal, makeReporter,
} from './harness.mjs';

const COUNT = Math.max(25, parseInt(process.argv[2] || '30', 10) || 30);
const INSTANCE_CEILING = 42000;
const SPAWN_FLOOR = 18;          // healthy surface-population floor (deck target is 75/34)

// Deterministic spread of seeds (1..COUNT plus a few large ones mixed in).
function seedList(n) {
  const seeds = [];
  for (let i = 1; i <= n; i++) seeds.push((i * 2654435761) >>> 0); // knuth-hash spread, still fixed
  return seeds;
}

async function probeWorld(page) {
  return page.evaluate(() => {
    const p = window.__probe;
    if (!p) return { ok: false, reason: 'no __probe' };
    const s = p.state;
    const out = {
      ok: true,
      seed: p.CONFIG.WORLD_SEED,
      creatures: s.creatures.length,
      minNavHw: p.CONFIG.CAVE_MIN_NAV_HW,
      playerR: p.CONFIG.PLAYER_RADIUS,
      caveCount: p.CAVES.length,
      caves: [],
    };
    const fitFloor = p.CONFIG.PLAYER_RADIUS + 0.5; // player physically fits
    for (const c of p.CAVES) {
      const dp = p.caveDeepPoint(c);
      const inside = !!p.caveAt(dp.x, dp.z);
      const frame = p.sampleCave(dp.x, dp.z);
      const hw = frame ? frame.hw : 0;
      const deadEnds = p.caveDeadEnds(c);
      // minimum half-width along the main path (informational vs CAVE_MIN_NAV_HW)
      let minHw = Infinity;
      for (const path of c.paths) for (const node of path) if (node.hw < minHw) minHw = node.hw;
      out.caves.push({
        entrances: (c.entrances && c.entrances.length) || 0,
        pathNodes: (c.paths && c.paths[0] && c.paths[0].length) || 0,
        deepInside: inside,
        deepHw: hw,
        fits: hw >= fitFloor,
        deadEnds: Array.isArray(deadEnds) ? deadEnds.length : -1,
        minHw: isFinite(minHw) ? minHw : null,
      });
    }
    return out;
  });
}

async function main() {
  const rep = makeReporter(`fuzzseed (${COUNT} seeds)`);
  const browser = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
  const seeds = seedList(COUNT);

  let cleanSeeds = 0, spawnOk = 0, budgetOk = 0, caveOk = 0, caveSeeds = 0, worstInst = 0;
  let minSpawn = Infinity, minCaveHw = Infinity;
  const failures = [];

  try {
    for (const seed of seeds) {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await context.newPage();
      const bag = await attachCollectors(page);
      const url = `${BASE_URL}/index.html?probe&seed=${seed}`;

      let world = null, inst = null, hardErr = null;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitForReady(page);
        inst = await readInstanceTotal(page);
        world = await probeWorld(page);
      } catch (e) {
        hardErr = String(e && e.message || e);
      }
      await context.close();

      const clean = bag.pageErrors.length === 0 && bag.consoleErrors.length === 0 && bag.contextLost.length === 0 && !hardErr;
      if (clean) cleanSeeds++;
      else failures.push(`seed ${seed}: ${hardErr || bag.pageErrors[0] || bag.consoleErrors[0] || bag.contextLost[0]}`);

      const creatures = world && world.ok ? world.creatures : 0;
      minSpawn = Math.min(minSpawn, creatures);
      if (creatures >= SPAWN_FLOOR) spawnOk++;
      else failures.push(`seed ${seed}: only ${creatures} creatures (< ${SPAWN_FLOOR})`);

      const total = inst ? inst.total : Infinity;
      worstInst = Math.max(worstInst, inst ? inst.total : 0);
      if (total <= INSTANCE_CEILING) budgetOk++;
      else failures.push(`seed ${seed}: ${total} instances (> ${INSTANCE_CEILING})`);

      // cave invariants
      if (world && world.ok && world.caveCount > 0) {
        caveSeeds++;
        let caveGood = true;
        for (const c of world.caves) {
          if (c.entrances < 1 || c.pathNodes < 2) caveGood = false;
          if (!c.deepInside) caveGood = false;
          if (!c.fits) caveGood = false;
          if (c.deadEnds < 0) caveGood = false;
          if (c.minHw !== null) minCaveHw = Math.min(minCaveHw, c.minHw);
        }
        if (caveGood) caveOk++;
        else failures.push(`seed ${seed}: cave invariant breach ${JSON.stringify(world.caves)}`);
      }

      const warnTag = bag.warnings.some((w) => /spawned \d+\/\d+/.test(w)) ? ' (spawn-shortfall warn)' : '';
      rep.info(`seed ${String(seed).padStart(10)}  creatures=${creatures}  instances=${inst ? inst.total : '?'}  caves=${world && world.ok ? world.caveCount : '?'}${clean ? '' : '  !DIRTY'}${warnTag}`);
    }
  } finally {
    await browser.close();
  }

  console.log('');
  rep.check(`all ${COUNT} seeds clean (no errors/pageerrors/context-loss)`, cleanSeeds === COUNT, `${cleanSeeds}/${COUNT}`);
  rep.check(`spawn success on all seeds (>= ${SPAWN_FLOOR} creatures)`, spawnOk === COUNT, `${spawnOk}/${COUNT}, min=${minSpawn}`);
  rep.check(`instance budget within ceiling on all seeds`, budgetOk === COUNT, `${budgetOk}/${COUNT}, worst=${worstInst}`);
  rep.check(`cave-traversal invariants hold on all cave seeds`, caveOk === caveSeeds, `${caveOk}/${caveSeeds} cave-seeds`);
  rep.info(`observed min main-path cave half-width: ${isFinite(minCaveHw) ? minCaveHw.toFixed(2) : 'n/a'} (CAVE_MIN_NAV_HW target 1.3)`);

  if (failures.length) { console.log('\n  failures:'); for (const f of failures.slice(0, 20)) console.log('   - ' + f); }

  const ok = rep.summary();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('fuzzseed crashed:', e); process.exit(2); });
