/* ============================================================
   Cave-Life Spawning — Phase 2j (items 65–76)
   ------------------------------------------------------------
   Places the cave-EXCLUSIVE creatures INSIDE the seeded caves,
   biased by the 2e theme `spawnBias` (read from the theme registry,
   so the theme→creature mapping stays declarative in caves-themes.js).
   Runs AFTER the surface win-fuel deck (spawn.js) — cave life is bonus.

   Placement respects the FINAL 2m cave geometry + 2i water:
     - bat colonies hang from the vault (caveCeilingAt)
     - the cathedral legendary sits in the biggest chamber (topo.cathedral)
     - glowfish shoals go into a cave WATER pool (cave.pools, non-ice)
     - wardens / sleepers take a roomy chamber; the rest ride passage nodes
   All records go through makeRecord (shared shape), so the catch flow,
   targeting, grounding and confinement work exactly as elsewhere.
   ============================================================ */

import { CONFIG } from '../config.js';
import { CAVES, getGroundY, caveCeilingAt } from '../heightfield.js';
import { getCaveThemeDescriptor } from '../caves/caves-registry.js';
import { CREATURE_TYPES } from './bestiary.js';
import { makeRecord } from './spawn.js';
import { caveDeadEnds, caveDeepPoint } from '../caves/caves-gameplay.js';

const byId = (id) => CREATURE_TYPES.find(t => t.id === id);

// Types placed by dedicated feature logic (not the generic passage pass).
const SPECIAL = new Set(['colonyBat', 'gloomwyrm', 'caveGlowfish', 'crystalWarden', 'slumberTroll']);

/* ---- geometry helpers ---- */
function midPoint(cave) {
    const path = cave.paths[0];
    const i = Math.floor(path.length / 2);
    return { x: path[i].x, z: path[i].z, i };
}
function pickChamber(cave) {
    if (cave.topo && cave.topo.cathedral) return cave.topo.cathedral;
    if (cave.chambers && cave.chambers.length) return cave.chambers[Math.floor(Math.random() * cave.chambers.length)];
    return midPoint(cave);
}
// a walkable point inside the main passage (interior node + lateral offset clear of the walls)
function passagePoint(cave) {
    const path = cave.paths[0];
    if (path.length < 3) return null;
    const i = 1 + Math.floor(Math.random() * (path.length - 2));
    const n = path[i], prev = path[i - 1];
    let tx = n.x - prev.x, tz = n.z - prev.z; const l = Math.hypot(tx, tz) || 1;
    const lat = (Math.random() * 2 - 1) * Math.max(0, n.hw - 0.8);
    return { x: n.x + (-tz / l) * lat, z: n.z + (tx / l) * lat };
}
function roomiest() {
    let best = null, bs = -1;
    for (const c of CAVES) {
        const s = (c.chambers ? c.chambers.length : 0) * 100 + c.paths[0].length;
        if (s > bs) { bs = s; best = c; }
    }
    return best;
}
function waterPool(cave) { return !!(cave.pools && cave.pools.some(p => p.kind !== 'ice')); }

// Phase 2k item 77: the chamber furthest from any mouth — high-value rares are
// biased HERE so reaching them is an exploration reward, not a doorstep grab.
function deepestChamber(cave) {
    if (!cave.chambers || !cave.chambers.length) return caveDeepPoint(cave);
    let best = cave.chambers[0], bd = -1;
    for (const ch of cave.chambers) {
        let md = Infinity;
        for (const e of cave.entrances) md = Math.min(md, Math.hypot(ch.x - e.x, ch.z - e.z));
        if (md > bd) { bd = md; best = ch; }
    }
    return best;
}

/* ---- record placement + per-behavior scratch init ---- */
function initScratch(rec) {
    switch (rec.def.caveBehavior) {
        case 'skitter': rec._climb = Math.random(); rec._climbDir = Math.random() < 0.5 ? 1 : -1; break;
        case 'echo': rec._realHitR = rec.hitRadius; rec._vis = 0; rec.group.visible = false; break;
        case 'guard': rec._patrol = Math.random() * 6.283; break;
        case 'wyrm': rec._orbit = Math.random() * 6.283; break;
    }
}
function place(def, x, y, z, extra) {
    const rec = makeRecord(def, x, y, z, extra);
    initScratch(rec);
    return rec;
}

/* ---- special placements ---- */
function placeBatColony(cave) {                                 // item 65
    const def = byId('colonyBat'); if (!def) return false;
    const ch = pickChamber(cave); if (!ch) return false;
    const node = cave.paths[0][ch.i] || cave.paths[0][Math.floor(cave.paths[0].length / 2)];
    const roost = { alarmUntil: 0, soundAt: 0 };
    const n = 4 + Math.floor(Math.random() * 3);                // 4..6 bats
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, rr = Math.random() * Math.max(0.25, node.hw - 0.9);
        const x = ch.x + Math.cos(a) * rr, z = ch.z + Math.sin(a) * rr;
        const ceil = caveCeilingAt(x, z);
        const y = (isFinite(ceil) ? ceil : node.floorY + node.ceilH) - 0.35;
        place(def, x, y, z, { roost, roostHome: { x, y, z }, inCave: true });
    }
    return true;
}
function placeCathedralLegendary() {                            // item 66 (1 per world)
    const def = byId('gloomwyrm'); if (!def) return;
    let cave = CAVES.find(c => c.topo && c.topo.cathedral) || roomiest();
    if (!cave) return;
    const center = (cave.topo && cave.topo.cathedral) ? cave.topo.cathedral : pickChamber(cave);
    const cx = center.x, cz = center.z, y = getGroundY(cx, cz) + def.hover;
    // the deep cave legendary is a prize — item 82 collapse fires on its capture
    place(def, cx + 1, y, cz, { roostHome: { x: cx, y, z: cz }, orbitR: 3.4, inCave: true, _deepPrize: true });
}
function placeGlowfishShoal(cave) {                             // item 68
    const def = byId('caveGlowfish'); if (!def) return false;
    const pools = cave.pools.filter(p => p.kind !== 'ice'); if (!pools.length) return false;
    const pool = pools[Math.floor(Math.random() * pools.length)];
    const n = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, rr = Math.random() * Math.max(0.15, pool.r - 0.3);
        const x = pool.x + Math.cos(a) * rr, z = pool.z + Math.sin(a) * rr;
        const y = (pool.level != null ? pool.level : CONFIG.POND_WATER_LEVEL) - 0.02;
        place(def, x, y, z, { poolRef: pool });
    }
    return true;
}
function placeGuardian(cave) {                                  // item 71 (+ item 77 deep bias)
    const def = byId('crystalWarden'); if (!def) return;
    const ch = deepestChamber(cave); if (!ch) return;           // rare guardian sits DEEP
    place(def, ch.x, getGroundY(ch.x, ch.z), ch.z, { roostHome: { x: ch.x, z: ch.z }, guardR: 6.5, inCave: true, _deepPrize: true });
}
function placeSleeper(cave) {                                   // item 70
    const def = byId('slumberTroll'); if (!def) return;
    const ch = pickChamber(cave); if (!ch) return;
    place(def, ch.x, getGroundY(ch.x, ch.z), ch.z, { inCave: true });
}
function placeDweller(cave, def) {                              // generic passage dweller
    if (!def || def.aquatic) return;
    // item 77: high-value (rare) dwellers bias DEEP; commons/uncommons ride the
    // passage as before. Rares also flag as a deep prize (item 82 collapse).
    const deep = def.tier === 'rare';
    const pt = deep ? caveDeepPoint(cave) : passagePoint(cave); if (!pt) return;
    const y = def.hover ? Math.max(getGroundY(pt.x, pt.z), CONFIG.POND_WATER_LEVEL) + def.hover : getGroundY(pt.x, pt.z);
    place(def, pt.x, y, pt.z, deep ? { inCave: true, _deepPrize: true } : { inCave: true });
}

// Phase 2k item 81: GUARANTEE a rare in a hidden alcove — a dead-end side pocket
// (or, failing that, the roomiest cave's deepest reach). Marks cave._alcove so the
// dead-end capture bonus (item 78) and the collapse (item 82) key off it.
function placeAlcoveReward() {
    const def = byId('crystalWarden'); if (!def) return;
    let cave = null, spot = null;
    for (const c of CAVES) {
        const des = caveDeadEnds(c);
        if (des.length) { cave = c; spot = des[Math.floor(Math.random() * des.length)]; break; }
    }
    if (!cave) { cave = roomiest(); if (cave) spot = caveDeepPoint(cave); }
    if (!cave || !spot) return;
    cave._alcove = { x: spot.x, z: spot.z, r: spot.r || 1.4 };
    place(def, spot.x, getGroundY(spot.x, spot.z), spot.z,
        { roostHome: { x: spot.x, z: spot.z }, guardR: 3.5, inCave: true, _deepPrize: true, _alcove: true });
}

/* ------------------------------------------------------------
   Entry — one pass over the seeded caves.
   ------------------------------------------------------------ */
export function spawnCaveLife() {
    if (!CAVES.length) return;
    placeCathedralLegendary();
    placeAlcoveReward();      // item 81: a guaranteed rare in a hidden alcove

    let colonies = 0, shoals = 0;
    for (const cave of CAVES) {
        const theme = cave.theme;
        if (theme === 'bat') { if (placeBatColony(cave)) colonies++; }
        if (waterPool(cave)) { if (placeGlowfishShoal(cave)) shoals++; }
        if (theme === 'crystal' || theme === 'geode') placeGuardian(cave);
        if (theme === 'mineral-ore' || theme === 'bat') placeSleeper(cave);

        // generic dwellers: from the theme's registered spawnBias, only the new
        // cave types that aren't special-placed (2e contract: bias by theme).
        const bias = (getCaveThemeDescriptor(theme).spawnBias || []).filter(id => {
            const t = byId(id); return t && t.cave && !SPECIAL.has(id);
        });
        const n = Math.min(bias.length, 1 + (Math.random() < 0.6 ? 1 : 0));
        for (let k = 0; k < n; k++) placeDweller(cave, byId(bias[k]));
    }

    // Guarantee the varied set the verification looks for: at least one bat colony,
    // and (if a water cave exists) one glowfish shoal, even on themeless seeds.
    if (!colonies) placeBatColony(CAVES[0]);
    if (!shoals) { const wc = CAVES.find(waterPool); if (wc) placeGlowfishShoal(wc); }
}
