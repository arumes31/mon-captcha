/* ============================================================
   Cave TOPOLOGY shapes (Phase 2f) — pure geometry generators
   ------------------------------------------------------------
   The world is a single-valued HEIGHTFIELD: at any (x,z) there is
   exactly ONE floor and ONE ceiling. Every shape here is expressed
   in terms the field queries already understand — modulated per-node
   cross-sections (floorY / hw / ceilH) and extra polyline PATHS in
   `cave.paths` — so heightfield.js (sampleCave / caveHeight /
   caveConfine / caveCeilingAt / getGroundY) stays exact over all of
   them with NO model change. A shape that a heightfield cannot honour
   (a passage crossing OVER itself at the same x,z; a walkable surface
   over a walkable tunnel) is delivered as the nearest honest
   single-valued form and the limit is documented in the plan handoff.

   Feature tags land on nodes (`n.talus`, `n.underwater`, `n.belly`,
   `n.choke`, `n.shaft`) and a per-cave `cave.topo` meta object the
   renderer reads (fallen blocks, bridge arch spans, shaft collars,
   water ceilings). Every generator takes a per-cave FEATURE rng so
   the base placement / wet / theme streams are untouched.
   ============================================================ */

import { CONFIG } from './config.js';

const TAU = Math.PI * 2;
const MIN_HW = CONFIG.CAVE_MIN_NAV_HW; // Phase 2m: never narrow a walkable node below this
const smooth = (t) => t * t * (3 - 2 * t);

function ensureTopo(cave) {
    if (!cave.topo) cave.topo = { features: [], fallen: [], shafts: [], bridges: [], water: [], collars: [] };
    return cave.topo;
}
function tag(cave, name) { const t = ensureTopo(cave); if (!t.features.includes(name)) t.features.push(name); }

// Tangent/perp at a node index on a path.
function frameAt(path, i) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    return { tx, tz, nx: -tz, nz: tx };
}
function midIndex(path, rng, margin = 2) {
    const lo = margin, hi = path.length - 1 - margin;
    if (hi <= lo) return Math.floor(path.length / 2);
    return lo + Math.floor(rng() * (hi - lo + 1));
}

/* ---- item 4: oversized CATHEDRAL chamber (a seed centrepiece) ---- */
export function applyCathedral(cave, rng) {
    const main = cave.paths[0];
    if (!cave.chambers.length) return false;
    const ch = cave.chambers[Math.floor(rng() * cave.chambers.length)];
    const ci = ch.i;
    for (let i = 0; i < main.length; i++) {
        const bump = Math.exp(-((i - ci) ** 2) / 5.5);
        if (bump < 0.02) continue;
        main[i].hw = Math.min(4.3, main[i].hw + bump * 2.6);
        main[i].ceilH = Math.min(9.8, main[i].ceilH + bump * 4.6);
    }
    ensureTopo(cave).cathedral = { x: main[ci].x, z: main[ci].z, i: ci };
    tag(cave, 'cathedral');
    return true;
}

/* ---- item 10: belly-crawl low SQUEEZE (needs crouch clearance) ---- */
export function applyBellyCrawl(cave, rng) {
    const main = cave.paths[0];
    const i = midIndex(main, rng, 3);
    // one (sometimes two) very low nodes — standing head-bumps, crouch fits.
    // Phase 2m: a squeeze reduces HEIGHT only; the WIDTH stays >= MIN_HW (the
    // final min-width clamp guarantees it) so the player is never forced to clip.
    for (let k = 0; k <= (rng() < 0.5 ? 1 : 0); k++) {
        const n = main[Math.min(main.length - 2, i + k)];
        if (!n) continue;
        n.ceilH = 1.72;      // crouch clearance only (crouch eye ~1.0)
        n.belly = true;
    }
    tag(cave, 'belly');
    return true;
}

/* ---- item 3: partial cave-in — rubble CHOKE with a squeeze-through gap ---- */
export function applyChoke(cave, rng) {
    const main = cave.paths[0];
    const i = midIndex(main, rng, 2);
    const n = main[i];
    const fr = frameAt(main, i);
    // Phase 2m: the choke reads as a squeeze via the LOWER ceiling + the rubble
    // wall rendered across it — NOT a sub-passable width (kept >= MIN_HW).
    n.ceilH = Math.min(n.ceilH, 2.9);
    n.choke = true;
    // rubble pile: a wall of boulders across the passage leaving a gap on one
    // side (the squeeze). Rendered by caves-features; the walkable centre stays
    // clear (confinement already narrows to n.hw here).
    const gapSide = rng() < 0.5 ? 1 : -1;
    ensureTopo(cave).choke = ensureTopo(cave).choke || [];
    cave.topo.choke.push({ x: n.x, z: n.z, nx: fr.nx, nz: fr.nz, hw: n.hw, gapSide, floorKey: i });
    tag(cave, 'choke');
    return true;
}

/* ---- item 11: talus/rubble descending SLOPE ---- */
export function applyTalus(cave, rng) {
    const main = cave.paths[0];
    const i0 = midIndex(main, rng, 3);
    const run = 2 + Math.floor(rng() * 2);
    const i1 = Math.min(main.length - 2, i0 + run);
    const drop = 1.1 + rng() * 1.0;
    const topF = main[i0].floorY;
    for (let i = i0; i <= i1; i++) {
        const t = (i - i0) / Math.max(1, i1 - i0);
        main[i].floorY = topF - drop * smooth(t);
        main[i].talus = true;
    }
    tag(cave, 'talus');
    return true;
}

// Shared descent branch — a passage dropping from `node` to a lower gallery.
// Narrow + steep = a vertical SHAFT (item 1); wider + gentler = a PIT drop-off
// into a lower gallery (item 7). In a heightfield this is a steep FUNNEL, not a
// literal vertical wall (documented) — the mover slides / falls down it and
// lands on the lower floor, which getGroundY returns exactly.
function makeDescent(node, heading, featRng, forbid, opts) {
    const segLen = 1.1;
    let x = node.x, z = node.z, hd = heading, hvel = 0;
    const pts = [{ x, z }];
    for (let k = 1; k <= opts.steps; k++) {
        hvel += (featRng() - 0.5) * 0.3; hvel *= 0.7; hd += hvel;
        x += Math.cos(hd) * segLen; z += Math.sin(hd) * segLen;
        if (forbid(x, z)) break;
        pts.push({ x, z });
    }
    if (pts.length < 2) return null;
    const topF = node.floorY, botF = node.floorY - opts.depth;
    return pts.map((p, k) => {
        const t = k / (pts.length - 1);
        const dt = Math.min(1, t / 0.5);                 // steep drop, then level
        const floorY = topF + (botF - topF) * smooth(dt);
        const end = t > 0.62;
        const hw = Math.max(MIN_HW, end ? opts.endWidth : opts.width);
        const ceilH = opts.ceilH + (end ? 1.1 : 0);
        return { x: p.x, z: p.z, hw, ceilH, floorY, talus: t < 0.55, cap: k === pts.length - 1 };
    });
}

/* ---- item 1: vertical SHAFT / chimney linking upper + lower passage ---- */
export function applyShaft(cave, featRng, forbid) {
    const main = cave.paths[0];
    if (!cave.chambers.length) return false;
    const ch = cave.chambers[Math.floor(featRng() * cave.chambers.length)];
    const node = main[ch.i];
    const fr = frameAt(main, ch.i);
    const side = featRng() < 0.5 ? 1 : -1;
    const heading = Math.atan2(fr.nz * side, fr.nx * side) + (featRng() - 0.5) * 0.6;
    const branch = makeDescent(node, heading, featRng, forbid, { steps: 4 + Math.floor(featRng() * 2), depth: 3.2 + featRng() * 1.1, width: 0.95, endWidth: 1.25, ceilH: 3.4 });
    if (!branch || branch.length < 3) return false;
    branch.forEach(n => { n.shaft = true; });
    cave.paths.push(branch);
    // a tall chimney void + rock collar above the drop mouth (visual "chimney")
    node.ceilH = Math.max(node.ceilH, 6.2);
    ensureTopo(cave).shafts.push({ x: node.x, z: node.z, topY: node.floorY + node.ceilH, floorY: node.floorY });
    tag(cave, 'shaft');
    return true;
}

/* ---- item 7: PIT drop-off into a lower gallery ---- */
export function applyPit(cave, featRng, forbid) {
    const main = cave.paths[0];
    if (!cave.chambers.length) return false;
    const ch = cave.chambers[Math.floor(featRng() * cave.chambers.length)];
    const node = main[ch.i];
    const fr = frameAt(main, ch.i);
    const side = featRng() < 0.5 ? 1 : -1;
    const heading = Math.atan2(fr.nz * side, fr.nx * side) + (featRng() - 0.5) * 0.5;
    const branch = makeDescent(node, heading, featRng, forbid, { steps: 5 + Math.floor(featRng() * 2), depth: 2.6 + featRng() * 0.9, width: 1.5, endWidth: 1.9, ceilH: 3.8 });
    if (!branch || branch.length < 4) return false;
    cave.paths.push(branch);
    tag(cave, 'pit');
    return true;
}

/* ---- item 2: multi-level over a natural ROCK BRIDGE (scoped honest form) ----
   A single-valued heightfield cannot let one passage cross OVER another at the
   same (x,z). Delivered as the nearest honest form: a lower gallery (a pit) with
   a RAISED LEDGE deck running along one rim (multi-level: walk the high deck or
   drop to the low gallery, different x,z), spanned by a decorative natural rock
   ARCH overhead so it reads as a bridge crossing the void. */
export function applyBridge(cave, featRng, forbid) {
    const main = cave.paths[0];
    if (!cave.chambers.length) return false;
    const ch = cave.chambers[Math.floor(featRng() * cave.chambers.length)];
    const node = main[ch.i];
    const fr = frameAt(main, ch.i);
    // lower gallery under the bridge
    const gside = featRng() < 0.5 ? 1 : -1;
    const gal = makeDescent(node, Math.atan2(fr.nz * gside, fr.nx * gside), featRng, forbid, { steps: 4, depth: 2.4 + featRng() * 0.7, width: 1.5, endWidth: 1.7, ceilH: 4.6 });
    if (!gal || gal.length < 3) return false;
    cave.paths.push(gal);
    // raised ledge DECK along the opposite rim (higher floor, different x,z)
    const dside = -gside;
    const deckOff = node.hw + 0.6;
    const dx = node.x + fr.nx * dside * deckOff, dz = node.z + fr.nz * dside * deckOff;
    const deckY = node.floorY + 1.3;
    const deck = [];
    for (let k = -2; k <= 2; k++) {
        const px = dx + fr.tx * k * 1.15, pz = dz + fr.tz * k * 1.15;
        if (forbid(px, pz)) return finishBridge(cave, node, fr, gside, deckY);
        deck.push({ x: px, z: pz, hw: MIN_HW, ceilH: 4.0, floorY: deckY, cap: Math.abs(k) === 2 });
    }
    cave.paths.push(deck);
    return finishBridge(cave, node, fr, gside, deckY);
}
function finishBridge(cave, node, fr, gside, deckY) {
    // decorative arch spanning from the deck rim over the gallery to the far rim
    ensureTopo(cave).bridges.push({
        x: node.x, z: node.z, tx: fr.tx, tz: fr.tz, nx: fr.nx, nz: fr.nz,
        span: node.hw * 2 + 1.4, topY: node.floorY + node.ceilH - 0.3, deckY,
    });
    tag(cave, 'bridge');
    return true;
}

/* ---- item 5: true 3+-way branching JUNCTION ---- */
export function applyJunction(cave, featRng, forbid) {
    const main = cave.paths[0];
    if (!cave.chambers.length) return false;
    const ch = cave.chambers[Math.floor(featRng() * cave.chambers.length)];
    const node = main[ch.i];
    const fr = frameAt(main, ch.i);
    // open the junction node so the radiating passages overlap generously (no
    // dead pocket between them for confinement to snag on).
    node.hw = Math.max(node.hw, 1.7);
    let added = 0;
    const nB = 2 + (featRng() < 0.5 ? 1 : 0);          // 2-3 extra arms => 3-4-way
    for (let b = 0; b < nB; b++) {
        const heading = Math.atan2(fr.nz, fr.nx) + (b === 0 ? 0 : Math.PI) + (featRng() - 0.5) * 0.9;
        const arm = growArm(node, heading, featRng, forbid, 3 + Math.floor(featRng() * 3));
        if (arm && arm.length >= 3) { cave.paths.push(arm); added++; }
    }
    if (!added) return false;
    tag(cave, 'junction');
    return true;
}
// A short open passage from a shared node ending in a capped pocket.
function growArm(node, heading, featRng, forbid, steps) {
    const segLen = 1.15;
    let x = node.x, z = node.z, hd = heading, hvel = 0;
    const pts = [{ x, z }];
    for (let k = 1; k <= steps; k++) {
        hvel += (featRng() - 0.5) * 0.4; hvel *= 0.7; hd += hvel;
        x += Math.cos(hd) * segLen; z += Math.sin(hd) * segLen;
        if (forbid(x, z)) break;
        pts.push({ x, z });
    }
    if (pts.length < 3) return null;
    const phase = featRng() * TAU;
    return pts.map((p, k) => {
        const t = k / (pts.length - 1);
        const hw = Math.max(MIN_HW, 1.35 + Math.sin(k + phase) * 0.25 + (t > 0.7 ? 0.5 : 0));
        const ceilH = 3.9 + (t > 0.7 ? 1.1 : 0);
        const floorY = node.floorY + Math.sin(k * 0.7) * 0.18;
        return { x: p.x, z: p.z, hw, ceilH, floorY, cap: k === pts.length - 1 };
    });
}

/* ---- item 6: LOOP passage that splits and rejoins ---- */
export function applyLoop(cave, featRng, forbid) {
    const main = cave.paths[0];
    if (main.length < 7) return false;
    const iA = 1 + Math.floor(featRng() * (main.length - 6));
    const iB = iA + 3 + Math.floor(featRng() * 2);
    if (iB >= main.length - 1) return false;
    const A = main[iA], B = main[iB];
    // bulge the loop out to one side, staying roughly planar (no over-under)
    const fr = frameAt(main, Math.floor((iA + iB) / 2));
    const side = featRng() < 0.5 ? 1 : -1;
    const bulge = 3.0 + featRng() * 2.0;
    const mids = 3;
    const loop = [{ x: A.x, z: A.z, hw: A.hw, ceilH: A.ceilH, floorY: A.floorY }];
    for (let m = 1; m <= mids; m++) {
        const t = m / (mids + 1);
        const bx = A.x + (B.x - A.x) * t, bz = A.z + (B.z - A.z) * t;
        const off = Math.sin(Math.PI * t) * bulge * side;
        const px = bx + fr.nx * off, pz = bz + fr.nz * off;
        if (forbid(px, pz)) return false;
        loop.push({ x: px, z: pz, hw: Math.max(MIN_HW, 1.35 + featRng() * 0.25), ceilH: 3.9, floorY: A.floorY + (B.floorY - A.floorY) * t });
    }
    loop.push({ x: B.x, z: B.z, hw: B.hw, ceilH: B.ceilH, floorY: B.floorY });
    cave.paths.push(loop);
    tag(cave, 'loop');
    return true;
}

/* ---- item 12: BREAKDOWN chamber — fallen ceiling blocks as cover ---- */
export function applyBreakdown(cave, featRng) {
    const main = cave.paths[0];
    if (!cave.chambers.length) return false;
    const ch = cave.chambers[Math.floor(featRng() * cave.chambers.length)];
    const node = main[ch.i];
    const t = ensureTopo(cave);
    const n = 3 + Math.floor(featRng() * 3);
    for (let i = 0; i < n; i++) {
        const a = featRng() * TAU, r = featRng() * Math.max(0.4, node.hw - 0.6);
        t.fallen.push({
            x: node.x + Math.cos(a) * r, z: node.z + Math.sin(a) * r,
            s: 0.7 + featRng() * 0.9, rot: featRng() * TAU, tilt: (featRng() - 0.5) * 0.4,
        });
    }
    tag(cave, 'breakdown');
    return true;
}

/* ---- item 8: tunnel running UNDER the river (water as a ceiling from below)
   + item 9 through-route (two opposite bank mouths). ----
   A heightfield has one surface per (x,z), so a walkable riverbed OVER a
   walkable tunnel cannot both exist there. Delivered honestly as a dry tunnel
   that dives BENEATH the river between two dry-bank mouths: the interior is kept
   dry (heightfield's cave-override in isWaterAt), its low rock vault sits just
   under the water line, and a translucent water SHEET is drawn as the ceiling so
   from inside you are plainly beneath the river. LIMIT (documented in the plan):
   directly above the narrow buried span the field resolves to the tunnel floor,
   so a swimmer crossing exactly over it drops IN and lands on the tunnel floor
   (a real floor — never a fall-through) rather than standing on the riverbed. */
export function makeRiverCrossing(deps, featRng) {
    const { riverPointAt, riverTangent, riverAt, baseHeight, half, forbidDry } = deps;
    const tan = riverTangent();
    const nx = -tan.z, nz = tan.x;                         // river normal = crossing axis
    const span = deps.span;                                // { uMin, uMax }
    for (let attempt = 0; attempt < 24; attempt++) {
        const u = span.uMin + 6 + featRng() * Math.max(2, span.uMax - span.uMin - 12);
        const c = riverPointAt(u, 0, 'B');
        const here = riverAt(c.x, c.z);
        if (!here) continue;
        const reach = here.wWater + CONFIG.RIVER_BANK + 3.2;   // bank-to-bank half length
        // both mouths must land on dry, unobstructed ground
        const mA = { x: c.x + nx * reach, z: c.z + nz * reach };
        const mB = { x: c.x - nx * reach, z: c.z - nz * reach };
        if (Math.abs(mA.x) > half - 5 || Math.abs(mA.z) > half - 5) continue;
        if (Math.abs(mB.x) > half - 5 || Math.abs(mB.z) > half - 5) continue;
        if (forbidDry(mA.x, mA.z) || forbidDry(mB.x, mB.z)) continue;
        const gA = baseHeight(mA.x, mA.z), gB = baseHeight(mB.x, mB.z);
        if (gA > 4.5 || gB > 4.5) continue;
        const step = 1.2;
        const nSteps = Math.round((2 * reach) / step);
        const nodes = [];
        let underMin = 1, underMax = -1;
        for (let i = 0; i <= nSteps; i++) {
            const d = reach - i * (2 * reach / nSteps);       // +reach (A) .. -reach (B)
            const x = c.x + nx * d, z = c.z + nz * d;
            const rv = riverAt(x, z);
            const under = rv && rv.lat < rv.wWater + 0.6;
            const endT = Math.min(i, nSteps - i) / nSteps;    // 0 at a mouth, 0.5 at centre
            const gEnd = d > 0 ? gA : gB;
            let floorY, ceilH, hw;
            if (under) {
                floorY = -2.45;                                // dry pocket below the riverbed
                ceilH = 2.3;                                   // vault top just under the water line
                hw = 1.5 + Math.sin(i * 0.6) * 0.2;
                if (i < underMin) underMin = i; if (i > underMax) underMax = i;
            } else {
                const flare = Math.max(0, 1 - endT / 0.16);    // wide arch mouths
                floorY = (gEnd - 0.2) - smooth(Math.min(1, endT / 0.4)) * 2.0; // ramp down toward the water
                ceilH = 4.4 + flare * 1.4;
                hw = 1.6 + flare * 1.5;
            }
            nodes.push({ x, z, hw, ceilH, floorY, underwater: !!under });
        }
        if (underMax < underMin) continue;                     // must actually cross water
        return {
            nodes, chambers: [],
            water: { nx, nz, cx: c.x, cz: c.z, from: reach - underMin * (2 * reach / nSteps), to: reach - underMax * (2 * reach / nSteps), y: -0.05 },
        };
    }
    return null;
}

/* ---- item 9: THROUGH-ROUTE — straighten so both mouths reach open air ---- */
export function applyThrough(cave) {
    // Nudge the two ends toward opposite bearings by relaxing the mid meander:
    // pull interior nodes toward the straight line between the mouths so the
    // passage reads as a clean walk-through with light S-curve.
    const main = cave.paths[0];
    const a = main[0], b = main[main.length - 1];
    for (let i = 1; i < main.length - 1; i++) {
        const t = i / (main.length - 1);
        const lx = a.x + (b.x - a.x) * t, lz = a.z + (b.z - a.z) * t;
        main[i].x = lx + (main[i].x - lx) * 0.45;
        main[i].z = lz + (main[i].z - lz) * 0.45;
    }
    tag(cave, 'through');
    return true;
}
