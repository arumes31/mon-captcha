/* ============================================================
   Cave generation (pure) — winding tunnel layouts
   ------------------------------------------------------------
   A cave is a TUNNEL, not a room: a seeded meandering centreline
   (a polyline of nodes) whose cross-section varies continuously —
   narrow squeezes opening into wider CHAMBERS, ceiling rising and
   falling — with an optional dead-end side POCKET branching off a
   chamber. The two open tube ends are the natural arch ENTRANCES.

   Each node carries { x, z, floorY, hw, ceilH }:
     floorY : the carved tunnel-floor height there (kept above the
              outdoor water line so caves stay DRY by default)
     hw     : passage half-width (squeeze ~0.85, chamber ~1.8)
     ceilH  : ceiling height ABOVE the floor (squeeze ~2.7, chamber ~5)

   ONE cave per world is designated WET: a chamber gets a pool
   descriptor (a basin dipping below the water line + its own small
   still-water surface). Everything downstream reads these:
   heightfield.js carves the floor / pool basin and answers the
   water + confinement queries; caves.js renders the rock shell,
   dressing, lights and pool; spawn.js homes cave dwellers inside.

   This module is deliberately dependency-light (config + random),
   with the seeded layout / partition / height+water fields passed
   in as deps, so heightfield.js can own the single CAVES instance
   with no import cycle.
   ============================================================ */

import { CONFIG } from '../config.js';
import { mulberry32 } from '../random.js';
import { DRY_CAVE_THEMES } from './caves-registry.js';
import { designFloodedWater } from './caves-water.js';
import {
    applyCathedral, applyBellyCrawl, applyChoke, applyTalus, applyShaft, applyPit,
    applyBridge, applyJunction, applyLoop, applyBreakdown, applyThrough, makeRiverCrossing,
} from './caves-shapes.js';

// Seeded Fisher-Yates so the theme distribution is deterministic per world.
function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
}

const FLOOR_CLAMP = 0.25; // dry tunnel floors stay above the outdoor water line (y=0)
const MIN_HW = CONFIG.CAVE_MIN_NAV_HW; // Phase 2m: passable half-width floor everywhere
const RIVER_ROCK_MARGIN = 1.3; // wall blend (0.85) + safety: a cave's rock must clear a river by this

// Phase 2m item 3: would this node's rock footprint (its cross-section reach)
// intrude on a river / pond / basin so the shell would poke into the water or
// the carve would eat the bank? Sampled during placement, when CAVES is still
// empty so isWaterAt reports the raw outdoor water network (no cave overrides).
// The deliberate under-river crossing is exempt (its nodes carry `underwater`).
function footprintHitsWater(node, isWaterAt) {
    if (node.underwater) return false;
    if (isWaterAt(node.x, node.z, 0)) return true;
    const reach = node.hw + RIVER_ROCK_MARGIN;
    for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        if (isWaterAt(node.x + Math.cos(ang) * reach, node.z + Math.sin(ang) * reach, 0)) return true;
    }
    return false;
}
function caveHitsRiver(cave, isWaterAt) {
    if (cave.topo && cave.topo.features.includes('underwater')) return false; // intended crossing
    for (const path of cave.paths) for (const n of path) if (footprintHitsWater(n, isWaterAt)) return true;
    return false;
}
// Phase 2m: two caves' rock footprints must not interpenetrate. Topology branches
// (bridge galleries, shafts, junction arms) extend a cave AFTER base placement
// without a nearOther check, so — especially now caves cluster on shared mountain
// flanks — a branch can reach a neighbour. Detected here and the later one dropped.
function cavesOverlap(a, b) {
    for (const pa of a.paths) for (const na of pa)
        for (const pb of b.paths) for (const nb of pb) {
            const rr = na.hw + nb.hw + 0.9; // footprints (hw + wall blend) touch
            if ((na.x - nb.x) ** 2 + (na.z - nb.z) ** 2 < rr * rr) return true;
        }
    return false;
}

// One meandering centreline + its per-node cross-section. Returns null if the
// walk wanders into forbidden ground (water, mountain, vent, out of bounds).
function makeTunnel(sx, sz, bearing, rng, deps, forbid) {
    const { baseHeight } = deps;
    const steps = 13 + Math.floor(rng() * 8); // 13..20 segments
    const segLen = 1.25;
    const pts = [{ x: sx, z: sz }];
    let x = sx, z = sz, heading = bearing, hvel = 0;
    for (let i = 1; i <= steps; i++) {
        hvel += (rng() - 0.5) * 0.5; hvel *= 0.74; // meander with inertia -> smooth curves
        heading += hvel;
        x += Math.cos(heading) * segLen; z += Math.sin(heading) * segLen;
        if (forbid(x, z)) return null;
        pts.push({ x, z });
    }
    // 1-2 chambers: interior bulge indices
    const chIdx = [];
    const nCh = 1 + (rng() < 0.65 ? 1 : 0);
    for (let k = 0; k < nCh; k++) chIdx.push(2 + Math.floor(rng() * (pts.length - 4)));
    const phase = rng() * Math.PI * 2;
    const g0 = baseHeight(pts[0].x, pts[0].z);
    const gN = baseHeight(pts[pts.length - 1].x, pts[pts.length - 1].z);
    const maxDepth = 1.1 + rng() * 0.6;
    const nodes = pts.map((p, i) => {
        const t = i / (pts.length - 1);
        // wider, more varied cross-section (Phase 2d: caves noticeably roomier).
        // the deeper sine swing keeps a genuine narrow squeeze between openings.
        let hw = 1.4 + Math.sin(i * 0.7 + phase) * 0.55;    // squeezes / openings
        let ceilH = 4.5 + Math.sin(i * 0.5 + phase * 1.7) * 0.6;
        for (const ci of chIdx) {                            // chambers swell width + height
            const bump = Math.exp(-((i - ci) ** 2) / 3.0);
            hw += bump * 1.25; ceilH += bump * 2.2;
        }
        // Phase 2m: floor every walkable node at MIN_HW so the player can always
        // pass without clipping; chambers still swell up to ~2.9. (Squeeze
        // character now comes from lower ceilings, not sub-passable width.)
        hw = Math.max(MIN_HW, Math.min(2.9, hw));
        // squeezes read low against the 7+ chambers, but a full jump (camera
        // apex ~2.95) still clears the vault everywhere the body can stand
        ceilH = Math.max(3.6, Math.min(7.1, ceilH));
        // eroded entrance flare: the mouths open WIDE and tall so each end
        // reads as a natural arch, not a slit between rocks
        const endD = Math.min(i, pts.length - 1 - i);
        if (endD < 3) {
            const flare = (3 - endD) / 3;
            hw = Math.min(3.3, hw + 1.1 * flare);
            ceilH = Math.min(7.4, ceilH + 0.9 * flare);
        }
        // floor: near ground at the two entrances, dipping in the middle, gently
        // undulating — clamped above the water line so the passage stays dry
        const entranceBlend = g0 + (gN - g0) * t;
        const dip = maxDepth * Math.pow(Math.sin(Math.PI * t), 0.7);
        let floorY = entranceBlend - 0.1 - dip + Math.sin(i * 0.85 + phase) * 0.2;
        floorY = Math.max(floorY, FLOOR_CLAMP);
        return { x: p.x, z: p.z, hw, ceilH, floorY };
    });
    // Phase 2m: gently smooth the floor so a cave boring UP a mountain flank
    // climbs evenly — no sharp per-node steps (which quantize into ~1.4u ground
    // steps that make the camera lag on a ledge). Ends stay anchored to their
    // entrances so the mouths still meet the outside ground.
    for (let pass = 0; pass < 2; pass++) {
        const src = nodes.map(n => n.floorY);
        for (let i = 1; i < nodes.length - 1; i++) {
            nodes[i].floorY = Math.max(FLOOR_CLAMP, 0.25 * src[i - 1] + 0.5 * src[i] + 0.25 * src[i + 1]);
        }
    }
    // Phase 2m item 3: reject the whole tunnel if any node's rock footprint would
    // reach a river / pond (the shell would poke into the water or drain a bank).
    // placeCaves retries a fresh placement, preserving the cave count.
    for (const n of nodes) if (footprintHitsWater(n, deps.isWaterAt)) return null;
    const chambers = chIdx.map(ci => ({ x: pts[ci].x, z: pts[ci].z, i: ci }));
    return { nodes, chambers };
}

// Short dead-end side POCKET branching off a chamber (a capped end).
function makeBranch(tun, chamber, rng, forbid) {
    const i = chamber.i;
    const a = tun.nodes[i], prev = tun.nodes[Math.max(0, i - 1)];
    const tang = Math.atan2(a.z - prev.z, a.x - prev.x);
    const side = rng() < 0.5 ? 1 : -1;
    let heading = tang + side * (Math.PI / 2 + (rng() - 0.5) * 0.5);
    const steps = 3 + Math.floor(rng() * 3);
    const segLen = 1.2;
    let x = a.x, z = a.z, hvel = 0;
    const pts = [{ x, z }];
    for (let k = 1; k <= steps; k++) {
        hvel += (rng() - 0.5) * 0.4; hvel *= 0.7; heading += hvel;
        x += Math.cos(heading) * segLen; z += Math.sin(heading) * segLen;
        if (forbid(x, z)) break;
        pts.push({ x, z });
    }
    if (pts.length < 3) return null;
    const phase = rng() * Math.PI * 2;
    return pts.map((p, k) => {
        const t = k / (pts.length - 1);
        let hw = 1.35 + Math.sin(k * 0.8 + phase) * 0.2 + (t > 0.65 ? 0.7 : 0); // small end pocket
        hw = Math.max(MIN_HW, Math.min(2.2, hw));
        const ceilH = 3.7 + (t > 0.65 ? 1.0 : 0);
        const floorY = Math.max(FLOOR_CLAMP, a.floorY - 0.2 * Math.sin(Math.PI * t));
        return { x: p.x, z: p.z, hw, ceilH, floorY, cap: k === pts.length - 1 };
    });
}

// Bounding box + entrances (open tube ends) + zone tag for a finished cave.
function finalize(tun, paths, PARTITION) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxHW = 0;
    for (const path of paths) for (const n of path) {
        if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
        if (n.z < minZ) minZ = n.z; if (n.z > maxZ) maxZ = n.z;
        if (n.hw > maxHW) maxHW = n.hw;
    }
    const m = maxHW + 1.6;
    const main = tun.nodes, n = main.length;
    const dir = (a, b) => { const dx = a.x - b.x, dz = a.z - b.z, l = Math.hypot(dx, dz) || 1; return { dx: dx / l, dz: dz / l }; };
    const e0 = dir(main[0], main[1]), e1 = dir(main[n - 1], main[n - 2]);
    return {
        paths,
        chambers: tun.chambers.map(c => ({ x: c.x, z: c.z, i: c.i })),
        entrances: [
            { x: main[0].x, z: main[0].z, dx: e0.dx, dz: e0.dz, hw: main[0].hw },
            { x: main[n - 1].x, z: main[n - 1].z, dx: e1.dx, dz: e1.dz, hw: main[n - 1].hw },
        ],
        minX: minX - m, maxX: maxX + m, minZ: minZ - m, maxZ: maxZ + m,
        zoneId: PARTITION.zoneIdAt((minX + maxX) / 2, (minZ + maxZ) / 2),
        wet: false, pool: null, theme: null,
    };
}

// Recompute a cave's early-reject bounding box + half-width margin AFTER the
// topology pass — branches (shafts/pits/loops/junctions) and the cathedral swell
// extend the footprint, and sampleCave rejects anything outside these bounds, so
// stale bounds would leave a branch unsampled (no floor / no wall). MUST run.
function recomputeBounds(cave) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxHW = 0;
    for (const path of cave.paths) for (const n of path) {
        if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
        if (n.z < minZ) minZ = n.z; if (n.z > maxZ) maxZ = n.z;
        if (n.hw > maxHW) maxHW = n.hw;
    }
    const m = maxHW + 1.6;
    cave.minX = minX - m; cave.maxX = maxX + m; cave.minZ = minZ - m; cave.maxZ = maxZ + m;
}

// Distribute the Phase 2f topology features across the world's caves. Uses its
// own seeded rng so the base layout / wet / theme streams stay stable.
function assignTopology(placed, r, forbid) {
    if (!placed.length) return;
    const isCross = c => c.topo && c.topo.features.includes('underwater');
    const dry = placed.filter(c => !c.wet && !isCross(c) && c.paths[0].length >= 6);
    if (!dry.length) return;

    // one CATHEDRAL centrepiece — the roomiest / longest dry cave
    let cath = dry[0];
    for (const c of dry) {
        if ((c.chambers.length * 100 + c.paths[0].length) > (cath.chambers.length * 100 + cath.paths[0].length)) cath = c;
    }
    applyCathedral(cath, r);
    if (r() < 0.6) applyBreakdown(cath, r);

    // deal the rest: each dry cave is either a clean through-route or gets 1-2
    // heavy geometry features, plus a light extra on most.
    const heavy = ['shaft', 'pit', 'bridge', 'junction', 'loop'];
    const light = ['choke', 'belly', 'talus', 'breakdown'];
    let hbag = shuffle(heavy.slice(), r), hi = 0;
    const nextHeavy = () => { if (hi >= hbag.length) { hbag = shuffle(heavy.slice(), r); hi = 0; } return hbag[hi++]; };
    for (const c of dry) {
        const feats = new Set();
        if (c !== cath && r() < 0.35) feats.add('through');
        else {
            feats.add(nextHeavy());
            if (r() < 0.4) feats.add(nextHeavy());
        }
        if (r() < 0.7) feats.add(light[Math.floor(r() * light.length)]);
        applyFeatureSet(c, feats, r, forbid);
    }
}

// Apply a feature set in a SAFE fixed order: the position-moving through-route
// first, then index-based modifiers, then branch-adders (which read the final
// node positions). Idempotent-safe (each applier guards / tags).
function applyFeatureSet(c, feats, r, forbid) {
    if (feats.has('through')) applyThrough(c);
    if (feats.has('talus')) applyTalus(c, r);
    if (feats.has('belly')) applyBellyCrawl(c, r);
    if (feats.has('choke')) applyChoke(c, r);
    if (feats.has('breakdown')) applyBreakdown(c, r);
    if (feats.has('junction')) applyJunction(c, r, forbid);
    if (feats.has('loop')) applyLoop(c, r, forbid);
    if (feats.has('shaft')) applyShaft(c, r, forbid);
    if (feats.has('pit')) applyPit(c, r, forbid);
    if (feats.has('bridge')) applyBridge(c, r, forbid);
}

export function placeCaves(deps) {
    const { L, PARTITION, MOUNTAINS, baseHeight, isWaterAt, seed, half, pondR } = deps;
    const { riverPointAt, riverTangent, riverAt, riverSpan } = deps;
    const rng = mulberry32((seed ^ 0xca7e5) >>> 0);
    const rMin = pondR + 12;
    const rMax = half - 15;
    const count = 2 + Math.floor(rng() * 3); // 2..4 caves
    const mounts = MOUNTAINS || [];

    // Free (non-mountain) host bearings: rocky highlands, then random rim sectors.
    const rockyS = PARTITION.assign.indexOf('rocky');
    const freeHints = [];
    if (rockyS >= 0) freeHints.push(PARTITION.rot + (rockyS + 0.5) * PARTITION.sectorWidth);
    while (freeHints.length < count) freeHints.push(rng() * Math.PI * 2);

    const placed = [];
    // Phase 2m: wider base separation (8u, was 6u) so caves — now often hosted on
    // the SAME mountain flank — don't sit close enough for their topology branches
    // (which aren't nearOther-checked) to interpenetrate. A final overlap pass
    // below is the hard guarantee.
    const nearOther = (x, z) => {
        for (const c of placed) for (const path of c.paths) for (const nd of path)
            if ((nd.x - x) ** 2 + (nd.z - z) ** 2 < 64) return true;
        return false;
    };
    // Phase 2m item 2: caves may now bore into mountain FLANKS (only the solid
    // core/peak is off-limits), so entrances read as adits in the mountainside.
    const BORE_MAX = 6.0; // stay in the LOWER flank band; gentle climb, never the peak
    const forbid = (x, z) => {
        if (Math.abs(x) > half - 5 || Math.abs(z) > half - 5) return true;
        if (isWaterAt(x, z, 3.0)) return true;
        for (const mt of mounts) if ((x - mt.x) ** 2 + (z - mt.z) ** 2 < (mt.r * 0.35) ** 2) return true;
        if ((x - L.VX) ** 2 + (z - L.VZ) ** 2 < (L.R_V + 7) ** 2) return true;
        if ((x - L.BX) ** 2 + (z - L.BZ) ** 2 < (L.R_B + 6) ** 2) return true;
        if (baseHeight(x, z) > BORE_MAX) return true;
        return false;
    };

    // The MAJORITY bore into a mountain (entrance on a flank, tunnel boring
    // inward-and-along the flank band); the rest are free zone caves. Prefer the
    // bigger EXTRA massifs as hosts — the primary's good (pond-facing) flank is
    // taken by the basin/vent/waterfall and it hugs the rim, so it is a poor host.
    const hostList = mounts.filter(m => !m.primary);
    const hosts = hostList.length ? hostList : mounts;
    const nMountain = mounts.length ? (count >= 3 ? count - 1 : count) : 0;
    for (let ci = 0; ci < count; ci++) {
        const mountainCave = ci < nMountain;
        for (let attempt = 0; attempt < 80; attempt++) {
            let sx, sz, heading;
            // last 20 attempts fall back to a free placement so a stubborn flank
            // never costs the cave (preserves the seeded count).
            if (mountainCave && attempt < 60) {
                const mt = hosts[ci % hosts.length];
                const fa = rng() * Math.PI * 2;                 // flank bearing around the massif
                const startR = mt.r * (0.7 + rng() * 0.32);     // entrance partway up the flank
                sx = mt.x + Math.cos(fa) * startR;
                sz = mt.z + Math.sin(fa) * startR;
                const toC = Math.atan2(mt.z - sz, mt.x - sx);
                const side = rng() < 0.5 ? 1 : -1;
                heading = toC + side * (0.7 + rng() * 0.5);     // inward, veered along the flank
            } else {
                const ang = freeHints[ci] + (rng() - 0.5) * 1.0;
                const rad = rMin + rng() * (rMax - rMin);
                sx = Math.cos(ang) * rad; sz = Math.sin(ang) * rad;
                heading = Math.atan2(-sz, -sx) + (rng() - 0.5) * 1.4; // toward the hub, then wander
            }
            if (forbid(sx, sz) || nearOther(sx, sz)) continue;
            const tun = makeTunnel(sx, sz, heading, rng, deps, (x, z) => forbid(x, z) || nearOther(x, z));
            if (!tun) continue;
            const paths = [tun.nodes];
            if (tun.chambers.length && rng() < 0.55) {
                const br = makeBranch(tun, tun.chambers[Math.floor(rng() * tun.chambers.length)], rng, forbid);
                if (br) paths.push(br);
            }
            placed.push(finalize(tun, paths, PARTITION));
            break;
        }
    }

    // Phase 2f item 8+9: a tunnel diving UNDER the river between two dry-bank
    // mouths (a natural through-route). Added when there is room (keeps total
    // caves <= 4) and a clear river spot exists; distributes across seeds.
    if (placed.length < 4 && riverPointAt && riverTangent && riverAt && riverSpan) {
        const forbidDry = (x, z) => {
            if (Math.abs(x) > half - 5 || Math.abs(z) > half - 5) return true;
            for (const mt of mounts) if ((x - mt.x) ** 2 + (z - mt.z) ** 2 < (mt.r + 3) ** 2) return true;
            if ((x - L.VX) ** 2 + (z - L.VZ) ** 2 < (L.R_V + 7) ** 2) return true;
            if ((x - L.BX) ** 2 + (z - L.BZ) ** 2 < (L.R_B + 6) ** 2) return true;
            if (baseHeight(x, z) > 5.2) return true;
            return nearOther(x, z);
        };
        const cross = makeRiverCrossing({ riverPointAt, riverTangent, riverAt, baseHeight, half, forbidDry, span: riverSpan() }, rng);
        if (cross) {
            const c = finalize(cross, [cross.nodes], PARTITION);
            c.topo = { features: ['underwater', 'through'], fallen: [], shafts: [], bridges: [], water: [cross.water], collars: [] };
            placed.push(c);
        }
    }

    // Designate ONE wet cave: a chamber holds an underground pool (basin below
    // the water line + its own surface). isWaterAt then reports the pool as water.
    const wetOk = placed.filter(c => c.chambers.length && !(c.topo && c.topo.features.includes('underwater')));
    if (wetOk.length && rng() < 0.9) {
        const c = wetOk[Math.floor(rng() * wetOk.length)];
        const ch = c.chambers[Math.floor(rng() * c.chambers.length)];
        c.wet = true;
        c.pool = { x: ch.x, z: ch.z, r: 1.5 + rng() * 0.55, level: 0, floorY: -0.42 };
    }

    // Phase 2f TOPOLOGY features. Assigned on a SEPARATE seeded stream so the
    // base placement / wet / theme streams above are untouched. Distributed so
    // worlds vary and no single cave carries everything: one world centrepiece
    // CATHEDRAL, then a per-cave menu of shafts/pits/junctions/loops/bridges/
    // chokes/belly-crawls/talus/breakdown. The WET cave and the river-crossing
    // are left as their own features (pool / under-river) and only take light,
    // pool-safe extras. All shapes stay single-valued (see caves-shapes.js).
    assignTopology(placed, mulberry32((seed ^ 0xf20f) >>> 0), forbid);
    // Clamp feature floors (pits/shafts/under-river) to the deepest level the
    // terrain builder can still stack a VISIBLE voxel for (columns floor at
    // y=-2.0 -> lowest renderable top ~-1.5). Keeps getGroundY exact and never
    // leaves a pit bottom as invisible ground.
    for (const c of placed) for (const p of c.paths) for (const n of p) if (n.floorY < -1.5) n.floorY = -1.5;

    // Phase 2m item 4: GUARANTEE the minimum navigable width on every walkable
    // node AFTER topology. Cathedral only widens; belly/choke no longer narrow;
    // this clamps anything a shape left below MIN_HW. This is the invariant the
    // traversal sweep proves — the player can walk the full length of every cave,
    // both directions, without ever being forced into solid rock.
    for (const c of placed) for (const p of c.paths) for (const n of p) if (n.hw < MIN_HW) n.hw = MIN_HW;
    placed.forEach(recomputeBounds); // branches/cathedral/min-width extended the footprint

    // Phase 2m: final guards. (item 3) DROP any non-crossing cave whose rock would
    // intrude on a river — a cathedral swell / min-width clamp can widen a node
    // toward one after the base retry cleared it. AND drop any cave that overlaps
    // an already-kept one (topology branches can reach a clustered neighbour), so
    // no two rock shells ever interpenetrate. Both rarely fire; processed in
    // placement order so base caves win over their later branches/crossing.
    const kept = [];
    for (const c of placed) {
        if (caveHitsRiver(c, isWaterAt)) continue;
        if (kept.some(k => cavesOverlap(c, k))) continue;
        kept.push(c);
    }

    // Per-cave THEME seed (Phase 2e, item 98). The seed-chosen WET cave is the
    // `flooded` theme (its pool IS the flooded feature — never regressed). Every
    // other cave draws from a seeded shuffled bag of the DRY themes so a
    // multi-cave world reads varied (no repeat until the 5-theme bag empties).
    // Runs AFTER placement + wet designation, so it consumes rng last and can
    // never perturb the layout — cave geometry is byte-identical to Phase 2d.
    let bag = [], bi = 0;
    for (const c of kept) {
        if (c.wet) { c.theme = 'flooded'; continue; }
        if (bi >= bag.length) { bag = shuffle(DRY_CAVE_THEMES.slice(), rng); bi = 0; }
        c.theme = bag[bi++];
    }

    // Phase 2i: enrich the ONE flooded cave with its water features (multiple
    // pools at varied heights, an underground stream, a ceiling-crack waterfall,
    // and the ice/hot-spring host-zone variants). Runs on a SEPARATE seeded
    // stream so base geometry / theme distribution above stay byte-identical.
    const wr = mulberry32((seed ^ 0x2fa7e) >>> 0);
    for (const c of kept) if (c.wet) designFloodedWater(c, wr);
    return kept;
}
