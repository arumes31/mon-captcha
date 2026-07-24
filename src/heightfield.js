/* ============================================================
   Terrain Heightfield & Water Field
   ------------------------------------------------------------
   getTerrainHeight is the single source of truth for surface
   height. It lives in its own low-level module because nearly
   every layer (engine, terrain, flora, atmosphere, player,
   creatures, projectiles) samples it.

   The layout is seeded fresh every page load, but the STRUCTURAL
   features survive any seed:
     - the center pond depression (fixed radius bowl)
     - a flat spawn meadow pad south of the pond
     - a global dry-land floor (nothing outside the water network
       ever dips below the waterline, so one water plane serves
       both pond and river)
     - a landmark MOUNTAIN near the rim (seed-dependent bearing,
       never toward the spawn meadow): ridged rocky cone with a
       small spring basin on its pond-facing shelf
     - the WATERFALL spilling from that basin down the rock face
       into a plunge pool that feeds the RIVER — a smooth,
       wadeable channel (~0.6-0.9 deep) winding down to the pond
     - a MAGMA VENT pocket on the mountain's flank
   isWaterAt(x,z) generalizes "is this the pond?" for splash
   detection, land-creature avoidance and aquatic containment;
   getWaterLevelAt covers the elevated basin pool.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { worldNoise, mulberry32 } from './random.js';
import { makePartition } from './zones/zones-data.js';
import { placeCaves } from './caves/caves-data.js';
import { caveWaterIsWater, caveWaterCarveH, caveWaterLevelAt, caveWetEdgeOne } from './caves/caves-water.js';
import { placeMountains, mountainRise } from './mountain/mountains-data.js';

const lerp = THREE.MathUtils.lerp;
const smoothstep = THREE.MathUtils.smoothstep;

// Spawn pad. LOCATION is filled in by pickSpawn() at the bottom of this
// module (seeded, gentle-zone-preferring); r starts at 0 so the pad blend is
// inert while the picker probes candidate points with getTerrainHeight.
export const SPAWN = {
    x: CONFIG.SPAWN_X,
    z: CONFIG.SPAWN_Z,
    r: 0,
    h: CONFIG.SPAWN_HEIGHT,
};

// Seeded caves (2-4 per world). Each is a FLOOR-OVERRIDE region: getTerrainHeight
// carves a gentle bowl inside its footprint (caveHeight, below) and caves.js
// renders a rock shell (walls + ceiling) above it. Populated by the placeCaves()
// IIFE at the bottom of this module (it needs baseHeight), and read by
// getTerrainHeight, caves.js (shell/dressing), spawn.js (creature bias) and
// music.js (cave ambience override). Empty until that IIFE runs at load.
export const CAVES = [];

// Smallest signed angular difference a-b in (-PI, PI]
function angDiffH(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
}

/* ------------------------------------------------------------
   Seeded layout — mountain, basin, vent, and TWO river courses.
   The spawn meadow sits at +z (bearing PI/2); the mountain
   bearing always stays >= ~1.25 rad away from it. Course M is the
   narrow mountain-fed tributary (bearing theta, mountain plunge
   pool -> pond). Course B is the MAIN, widened river re-sourced at
   the map border (bearing bt): it pours in over the perimeter
   cliff into a plunge pool and winds to the pond. bt is picked
   clear of the mountain, the vent flank and the legacy spawn side.
   ------------------------------------------------------------ */
const L = (() => {
    const r = mulberry32(CONFIG.WORLD_SEED ^ 0x51e77a);
    const half = CONFIG.ARENA_SIZE / 2;
    const theta = Math.PI / 2 + 1.25 + r() * (Math.PI * 2 - 2.5);
    const ct = Math.cos(theta), st = Math.sin(theta);
    const RM = CONFIG.ARENA_SIZE / 2 - 8;      // mountain center distance (=24)
    const R_MT = 10.5;                          // mountain base radius
    const uFall = RM - R_MT * 0.66;             // tributary ends at the plunge pool
    const uBasin = RM - 3.5;                    // spring basin on the pond-facing shelf
    const ventSide = r() < 0.5 ? 1 : -1;
    const ventAng = theta + Math.PI + ventSide * (1.5 + r() * 0.6); // flank, off the falls
    const ventD = 5.0;

    // Border river bearing: away from the mountain (theta), the vent flank and
    // the legacy +z spawn side, so the border falls never collide with them.
    let bt = 0;
    for (let i = 0; i < 64; i++) {
        const cand = r() * Math.PI * 2;
        if (Math.abs(angDiffH(cand, theta)) < 1.2) continue;
        if (Math.abs(angDiffH(cand, ventAng)) < 0.9) continue;
        if (Math.abs(angDiffH(cand, Math.PI / 2)) < 0.7) continue;
        bt = cand; break;
    }
    if (!bt) bt = theta + Math.PI; // guaranteed-far fallback
    const cbt = Math.cos(bt), sbt = Math.sin(bt);
    const uBpool = half - 4.4;                 // plunge pool centre distance
    const uBlip = half - 0.3;                  // cliff-lip crossing at the perimeter wall

    // item 397: seed-driven river-course VARIETY — a rare wide "lazy bend"
    // belly widened into the MAIN course (B) at one seeded point along it,
    // reading as an oxbow-like slow, wide pool on some seeds. Implemented as
    // an additive width bulge in riverAt()'s existing wWater formula below
    // (same technique the plunge-pool bulge already uses) rather than a
    // wholly separate carved water body — carving a detached cut-off lake
    // would need far more invasive surgery to this file's height/water field
    // than this backlog item justifies, and this still delivers genuine
    // per-seed visible variety (most seeds: none; some seeds: a lazy wide
    // bend) at effectively zero risk to the fords/aquatic-patrol/isWaterAt
    // machinery, which all already key off wWater generically.
    const uBStart = CONFIG.POND_RADIUS - 1.5;
    const hasOxbow = r() < CONFIG.RIVER_OXBOW_CHANCE;
    const oxbowSpan = Math.max(4, uBpool - uBStart - 30);
    const oxbowU = hasOxbow ? uBStart + 16 + r() * oxbowSpan : 0;
    const oxbowWidth = hasOxbow ? CONFIG.RIVER_OXBOW_WIDTH_MUL * (0.8 + r() * 0.5) : 0;
    const oxbowSpread = 4 + r() * 2.5;

    return {
        theta, ct, st,
        // course M (mountain tributary) wiggle
        A1: 2.2 + r() * 1.6, F1: (0.09 + r() * 0.05) * Math.PI * 2, P1: r() * Math.PI * 2,
        A2: 0.8 + r() * 0.7, F2: (0.23 + r() * 0.1) * Math.PI * 2, P2: r() * Math.PI * 2,
        PW: r() * Math.PI * 2,                 // width-variation phase
        PD: r() * Math.PI * 2,                 // depth-variation phase
        U_START: 3.0,                          // tributary begins inside the pond bowl
        U_FALL: uFall,
        // course B (border main river) bearing + wiggle + landmarks
        BT: bt, CBT: cbt, SBT: sbt,
        BA1: 2.8 + r() * 2.0, BF1: (0.06 + r() * 0.035) * Math.PI * 2, BP1: r() * Math.PI * 2,
        BA2: 1.1 + r() * 0.9, BF2: (0.17 + r() * 0.08) * Math.PI * 2, BP2: r() * Math.PI * 2,
        BPW: r() * Math.PI * 2, BPD: r() * Math.PI * 2,
        U_B_START: CONFIG.POND_RADIUS - 1.5,   // main channel begins in the pond bowl
        U_B_POOL: uBpool,                      // plunge pool distance
        U_B_LIP: uBlip,                        // cliff-lip / waterfall crest
        FORD1: CONFIG.POND_RADIUS + 7 + r() * 6,
        FORD2: uBpool - 9 - r() * 6,
        RM, R_MT,
        PEAK: 11 + r() * 3,                    // mountain height above its base terrain
        MX: ct * RM, MZ: st * RM,
        BX: ct * uBasin, BZ: st * uBasin,      // basin center (on the tributary bearing)
        R_B: 2.0,                              // basin bowl radius
        VX: ct * RM + Math.cos(ventAng) * ventD,
        VZ: st * RM + Math.sin(ventAng) * ventD,
        R_V: 1.5,                              // magma vent radius
        VENT_ANG: ventAng,
        // item 397: seeded lazy-bend/oxbow belly on course B (see riverAt below)
        OXBOW: hasOxbow, U_OXBOW: oxbowU, OXBOW_WIDTH: oxbowWidth, OXBOW_SPREAD: oxbowSpread,
    };
})();

// Public layout descriptors (terrain tinting, features, spawning, tests)
export const MOUNTAIN = { x: L.MX, z: L.MZ, r: L.R_MT };
export const VENT = { x: L.VX, z: L.VZ, r: L.R_V };
export const BASIN = { x: L.BX, z: L.BZ, r: L.R_B };

// Seeded zone partition — built HERE (before zones.js) so pickSpawn can prefer
// a gentle zone. zones.js reads this same instance, so there is exactly one.
// Alpine is pinned to the mountain bearing; volcanic to the vent's flank.
export const PARTITION = makePartition(L.theta, Math.atan2(L.VZ, L.VX));

// Seeded mountain massifs (Phase 2m): the primary alpine peak (exact L params —
// hosts the waterfall/basin/vent) plus 1-2 bigger rim massifs. baseHeight sums
// their cones; terrain.js tints rock+snow; caves route into their flanks.
export const MOUNTAINS = placeMountains({ L, PARTITION, seed: CONFIG.WORLD_SEED, half: CONFIG.ARENA_SIZE / 2 });
export const WATERFALL = {
    // lip on the basin rim facing the pond; pool where the river starts
    lipX: L.ct * (L.RM - 3.5 - L.R_B), lipZ: L.st * (L.RM - 3.5 - L.R_B),
    poolX: L.ct * L.U_FALL, poolZ: L.st * L.U_FALL,
};

// item 397: this seed's river-course oxbow/lazy-bend descriptor (present:
// false on most seeds — see the L IIFE above and riverAt()'s wWater bulge).
// ?probe-visible so a test can confirm it differs across seeds.
export const OXBOW = { present: L.OXBOW, u: L.U_OXBOW, width: L.OXBOW_WIDTH };

/* ------------------------------------------------------------
   River field — two courses. Each centerline leaves the pond and
   wiggles with two sine harmonics that ramp up mid-course and
   straighten again at both ends (into the pond, into the plunge
   pool). Course M is the narrow mountain tributary; course B is
   the wide, border-sourced main river.
   ------------------------------------------------------------ */
// narrow mountain tributary constants (course M — kept close to the old feel)
const M_WIDTH = 1.7, M_BANK = 2.0, M_DEPTH = 0.7;

function riverCenterM(u) {
    const g = Math.min(1, (u - L.U_START) / 12)
        * (1 - smoothstep(u, L.U_FALL - 6, L.U_FALL - 1)); // straight into the plunge pool
    return (Math.sin(u * L.F1 + L.P1) * L.A1 + Math.sin(u * L.F2 + L.P2) * L.A2) * g;
}
function riverCenterB(u) {
    const g = smoothstep(u, L.U_B_START, L.U_B_START + 11)
        * (1 - smoothstep(u, L.U_B_POOL - 6, L.U_B_POOL - 0.5)); // straight into the plunge pool
    return (Math.sin(u * L.BF1 + L.BP1) * L.BA1 + Math.sin(u * L.BF2 + L.BP2) * L.BA2) * g;
}
// Ford bump: 1 at the ford centre, easing to 0 within ~2.6u either side —
// raises the bed toward the waterline so the wide river stays crossable there.
function fordK(u, uc) {
    const t = Math.max(0, 1 - Math.abs(u - uc) / 2.8);
    return t * t * (3 - 2 * t);
}

// River field sample. Returns null outside both bank corridors, else the
// most-inside course: { u, lat, wWater, t, bed, course }. t=0 at the full-depth
// channel, 1 at the bank edge.
export function riverAt(x, z) {
    let best = null;
    // course M — mountain tributary
    {
        const u = x * L.ct + z * L.st;
        if (u >= L.U_START && u <= L.U_FALL + 1.8) {
            const v = -x * L.st + z * L.ct;
            const lat = Math.abs(v - riverCenterM(u));
            const wWater = M_WIDTH + Math.sin(u * 0.21 + L.PW) * 0.3
                + 1.3 * smoothstep(u, L.U_FALL - 3, L.U_FALL);
            const wBank = wWater + M_BANK;
            if (lat < wBank) {
                const bed = -(M_DEPTH + Math.sin(u * 0.13 + L.PD) * 0.14);
                best = { u, lat, wWater, t: smoothstep(lat, wWater, wBank), bed, course: 'M' };
            }
        }
    }
    // course B — wide border-sourced main river
    {
        const u = x * L.CBT + z * L.SBT;
        if (u >= L.U_B_START && u <= L.U_B_POOL + 2.6) {
            const v = -x * L.SBT + z * L.CBT;
            const lat = Math.abs(v - riverCenterB(u));
            let wWater = CONFIG.RIVER_WIDTH + Math.sin(u * 0.15 + L.BPW) * 0.45;
            wWater += 2.8 * smoothstep(u, L.U_B_POOL - 4.5, L.U_B_POOL);   // plunge pool bulge
            // item 397: seeded oxbow-like lazy-bend belly (see the L IIFE above)
            // — a localized gaussian width bulge on seeds that roll one; purely
            // additive to the SAME wWater every other rule here already feeds
            // into wBank/lat/t/bed/isWaterAt, so fords/patrols/spawning need no
            // changes at all to respect it.
            if (L.OXBOW) {
                const dU = u - L.U_OXBOW;
                wWater += L.OXBOW_WIDTH * Math.exp(-(dU * dU) / (2 * L.OXBOW_SPREAD * L.OXBOW_SPREAD));
            }
            const wBank = wWater + CONFIG.RIVER_BANK;
            if (lat < wBank) {
                const ford = Math.max(fordK(u, L.FORD1), fordK(u, L.FORD2));
                const bed = -((CONFIG.RIVER_DEPTH + Math.sin(u * 0.11 + L.BPD) * 0.16) * (1 - ford * 0.82));
                const cand = { u, lat, wWater, t: smoothstep(lat, wWater, wBank), bed, course: 'B' };
                if (!best || (cand.lat - cand.wWater) < (best.lat - best.wWater)) best = cand;
            }
        }
    }
    return best;
}

// World-space point on a river course: distance u along it, latOffset meters
// to the side of the centerline. Defaults to the main course B (banks / reeds /
// aquatic patrols sample this); pass 'M' for the mountain tributary.
export function riverPointAt(u, latOffset = 0, course = 'B') {
    if (course === 'M') {
        const v = riverCenterM(u) + latOffset;
        return { x: u * L.ct - v * L.st, z: u * L.st + v * L.ct };
    }
    const v = riverCenterB(u) + latOffset;
    return { x: u * L.CBT - v * L.SBT, z: u * L.SBT + v * L.CBT };
}

// Downstream span & base direction of the MAIN river (course B) for patrols.
export function riverSpan() {
    return { uMin: CONFIG.POND_RADIUS - 1.0, uMax: L.U_B_POOL - 1.5 };
}
export function riverTangent() {
    return { x: L.CBT, z: L.SBT };
}

// Border waterfall landmark: the crest lip at the perimeter cliff and the
// plunge pool it pours into (heights filled lazily by mountain.js from the
// rendered ground). aquatic/dressing code reads riverPointAt directly.
export const BORDER_FALL = (() => {
    const pool = riverPointAt(L.U_B_POOL, 0, 'B');
    const lip = riverPointAt(L.U_B_LIP, 0, 'B');
    const ford1 = riverPointAt(L.FORD1, 0, 'B');
    const ford2 = riverPointAt(L.FORD2, 0, 'B');
    return {
        poolX: pool.x, poolZ: pool.z, lipX: lip.x, lipZ: lip.z, width: CONFIG.RIVER_WIDTH,
        fords: [{ x: ford1.x, z: ford1.z, u: L.FORD1 }, { x: ford2.x, z: ford2.z, u: L.FORD2 }],
    };
})();

/* ------------------------------------------------------------
   Lazily-computed feature levels (they depend on the seeded base
   terrain, which needs the functions below to exist first).
   ------------------------------------------------------------ */
let lazyReady = false;
let BASIN_LEVEL = 0;    // water surface height of the spring basin
let VENT_FLOOR = 0;     // magma pocket floor height
function ensureLazy() {
    if (lazyReady) return;
    lazyReady = true; // set first: baseHeight below is basin/vent-free math
    BASIN_LEVEL = baseHeight(L.BX, L.BZ) - 0.6;
    VENT_FLOOR = baseHeight(L.VX, L.VZ) - 0.5;
}
export function getBasinLevel() { ensureLazy(); return BASIN_LEVEL - 0.15; } // spill notch height
export function getVentFloor() { ensureLazy(); return VENT_FLOOR; }

/* ------------------------------------------------------------
   Base height — hills with a dry-land floor, spawn pad, pond
   shore blend, outer cliff band, and the mountain cone.
   (No basin/vent/river carves: those need the lazy levels.)
   ------------------------------------------------------------ */
function baseHeight(x, z) {
    const d = Math.sqrt(x * x + z * z);

    // Rolling hills via fractal noise, plus a cliff band farther out
    const n = worldNoise(x * 0.06, z * 0.06, 5, 2.0, 0.5); // ~[-1,1] (extra octave for detail)
    const ridge = worldNoise(x * 0.025 + 100, z * 0.025 - 50, 2, 2.0, 0.5);
    const detail = worldNoise(x * 0.18, z * 0.18, 2, 2.0, 0.5) * 0.25; // micro-terrain
    let h = 1.2 + n * 1.8 + Math.max(0, ridge) * 2.4 + detail; // base + hills + ridges + detail

    // Dry-land floor: outside the pond/river network the ground never dips
    // below the waterline (the shared water plane would puddle randomly)
    h = Math.max(h, 0.42);

    // Flat spawn meadow pad (fixed feature; blended before the shore ring
    // so the pad ramps smoothly down to the pond's edge)
    const sdx = x - SPAWN.x, sdz = z - SPAWN.z;
    const sd = Math.sqrt(sdx * sdx + sdz * sdz);
    if (sd < SPAWN.r) h = lerp(SPAWN.h, h, smoothstep(sd, SPAWN.r * 0.5, SPAWN.r));

    // Shore blend: smooth transition from pond edge into grass
    if (d < CONFIG.POND_RADIUS + 2.5) {
        const t = (d - CONFIG.POND_RADIUS) / 2.5;
        h = lerp(0.0, h, t);
    }

    // Outer perimeter rises into a cliff wall band
    const half = CONFIG.ARENA_SIZE / 2;
    if (d > half - 6) {
        const t = Math.min(1, (d - (half - 6)) / 6);
        h += t * 3.5;
    }

    // Landmark mountains: ridged cones (summed over the seeded massif registry —
    // the primary reproduces the old single-peak formula exactly)
    h += mountainRise(x, z, MOUNTAINS);

    return h;
}

/* ------------------------------------------------------------
   Cave field sampling. A cave is a winding TUNNEL: one or more
   polyline paths (nodes carry floorY / half-width / ceiling
   height). sampleCave finds the nearest passage centreline point
   and returns the interpolated cross-section there. Everything the
   tunnels need — the floor carve, the "am I inside" test, the
   music override, lateral wall confinement — reads this one sample.
   A per-cave bounding box gives a cheap early reject for the vast
   majority of columns that sit nowhere near a cave.
   ------------------------------------------------------------ */
const CAVE_WALL_BLEND = 0.85; // lateral band outside the half-width where the floor blends back
export function sampleCave(x, z) {
    let best = null;
    for (let ci = 0; ci < CAVES.length; ci++) {
        const c = CAVES[ci];
        if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue;
        for (let pi = 0; pi < c.paths.length; pi++) {
            const nodes = c.paths[pi];
            for (let i = 0; i < nodes.length - 1; i++) {
                const a = nodes[i], b = nodes[i + 1];
                const abx = b.x - a.x, abz = b.z - a.z;
                const len2 = abx * abx + abz * abz || 1e-6;
                let s = ((x - a.x) * abx + (z - a.z) * abz) / len2;
                if (s < 0) s = 0; else if (s > 1) s = 1;
                const px = a.x + abx * s, pz = a.z + abz * s;
                const lat = Math.hypot(x - px, z - pz);
                const hw = a.hw + (b.hw - a.hw) * s;
                if (lat > hw + CAVE_WALL_BLEND) continue;
                if (!best || lat - hw < best.lat - best.hw) {
                    best = {
                        lat, hw, projX: px, projZ: pz, cave: c,
                        floorY: a.floorY + (b.floorY - a.floorY) * s,
                        ceilH: a.ceilH + (b.ceilH - a.ceilH) * s,
                        underwater: s < 0.5 ? !!a.underwater : !!b.underwater,
                    };
                }
            }
        }
    }
    return best;
}

// Floor carve: sink toward the passage floor, with a rounded cross-section
// (floor rises slightly toward the walls) and a smooth blend back to the
// surrounding ground at the wall line. The designated WET cave additionally
// carves a pool basin below the water line inside one chamber.
function caveHeight(x, z, h) {
    const cf = sampleCave(x, z);
    if (!cf) return h;
    const inside = 1 - smoothstep(cf.lat, cf.hw - 0.3, cf.hw + CAVE_WALL_BLEND);
    if (inside > 0) {
        const u = cf.hw > 0 ? Math.min(1, cf.lat / cf.hw) : 1;
        const floorT = cf.floorY + u * u * 0.4; // rounded floor rising to the walls
        h = lerp(h, Math.min(h, floorT), inside);
    }
    // wet-cave pool basins (Phase 2i: several pools at varied heights; ICE stays solid).
    if (cf.cave.pools) h = caveWaterCarveH(cf.cave, x, z, h);
    return h;
}

// The cave whose passage contains (x,z), or null — for the cave-ambience music
// override and cave-dweller spawn placement (well inside, past the walls).
export function caveAt(x, z) {
    const cf = sampleCave(x, z);
    return cf && cf.lat < cf.hw * 0.92 ? cf.cave : null;
}

// Absolute vault-ceiling height above (x,z), or Infinity outside any passage.
// Mirrors the shell cross-section in caves.js: vertical walls to the springline
// (42% of the ceiling height), then an elliptical vault peaking on the axis.
// The player controller head-bumps against this, so jumping in a low squeeze
// never pokes the camera through the rock.
export function caveCeilingAt(x, z) {
    const cf = sampleCave(x, z);
    if (!cf || cf.lat >= cf.hw) return Infinity;
    const sh = cf.ceilH * 0.42;
    const u = cf.lat / cf.hw;
    let ceil = cf.floorY + sh + (cf.ceilH - sh) * Math.sqrt(Math.max(0, 1 - u * u));
    // under-river crossing: the water surface is the ceiling — clamp the head-bump
    // just below it so a jump can never breach the river from beneath (item 8).
    if (cf.underwater) ceil = Math.min(ceil, CONFIG.POND_WATER_LEVEL - 0.2);
    return ceil;
}

// Lateral wall confinement for walkers/fliers. Inside a passage a mover stays
// within (half-width - radius) of the centreline — it cannot cross a side wall —
// but leaves freely through the two open tube ends (the MOUTHS). From outside,
// the wall band is solid EXCEPT at the mouths, so nothing clips in through rock.
// Returns null when (x,z) is nowhere near a cave; else corrected {x,z,inside}.
export function caveConfine(x, z, radius, wasInside) {
    const cf = sampleCave(x, z);
    if (!cf) return null;
    const limit = Math.max(0.05, cf.hw - radius);
    // Mouth test — the ONLY place a mover may cross the wall boundary. A mouth
    // is a DOORWAY, not a sphere: the point must sit near an entrance node,
    // roughly ON that node's outward axis (its lateral offset from the axis
    // within the arch), and not far behind the opening. This closes the Phase 2b
    // hole where a big radius-1.6 circle at BOTH short tube ends disabled the
    // side walls near the ends, letting movers walk straight out sideways.
    let nearMouth = false;
    for (const e of cf.cave.entrances) {
        const rx = x - e.x, rz = z - e.z;
        const along = rx * e.dx + rz * e.dz;               // +out through the arch, -into the tube
        const lateral = Math.abs(rx * -e.dz + rz * e.dx);  // sideways offset from the axis
        const arch = (e.hw || cf.hw) + 0.25;
        if (along > -1.1 && along < arch + 2.4 && lateral < arch) { nearMouth = true; break; }
    }
    const push = (target) => {
        const k = cf.lat > 1e-4 ? target / cf.lat : 1;
        return { x: cf.projX + (x - cf.projX) * k, z: cf.projZ + (z - cf.projZ) * k };
    };
    if (wasInside) {
        if (cf.lat > limit && !nearMouth) {
            const p = push(limit);
            return { x: p.x, z: p.z, inside: true };  // slid along the wall
        }
        return { x, z, inside: cf.lat < cf.hw };       // free inside / exiting a mouth
    }
    // From outside the wall band is solid across the WHOLE sampled ring (up to
    // hw + CAVE_WALL_BLEND, which covers the rendered rock) except at a mouth,
    // so a fast step can't tunnel a mover into the passage through the rock.
    if (!nearMouth && cf.lat < cf.hw + CAVE_WALL_BLEND) {
        const p = push(cf.hw + CAVE_WALL_BLEND + 0.05);   // solid wall from outside
        return { x: p.x, z: p.z, inside: false };
    }
    return { x, z, inside: cf.lat < limit };           // entering through a mouth
}

/* ------------------------------------------------------------
   Full height — base, then basin bowl + rim, magma pocket, and
   the river channel carved last (it cuts through everything).
   ------------------------------------------------------------ */
export function getTerrainHeight(x, z) {
    const d = Math.sqrt(x * x + z * z);
    const rv = riverAt(x, z);

    // Central pond depression (river mouth carves through the rim)
    if (d < CONFIG.POND_RADIUS) {
        const t = d / CONFIG.POND_RADIUS;
        let h = -1.8 + t * 1.8; // -1.8 at center, 0 at shore
        if (rv) h = Math.min(h, lerp(rv.bed, h, rv.t));
        return h;
    }

    let h = baseHeight(x, z);

    // Spring basin: bowl + containment rim, with a spill notch toward the
    // pond that the waterfall pours through
    const bdx = x - L.BX, bdz = z - L.BZ;
    const db = Math.sqrt(bdx * bdx + bdz * bdz);
    if (db < L.R_B + 1.4) {
        ensureLazy();
        if (db < L.R_B) {
            h = Math.min(h, BASIN_LEVEL - 0.55 + (db / L.R_B) * (db / L.R_B) * 0.4);
        } else {
            // angular distance from the pond-facing (downhill) bearing
            let aDiff = Math.atan2(bdz, bdx) - (L.theta + Math.PI);
            aDiff = Math.atan2(Math.sin(aDiff), Math.cos(aDiff));
            if (Math.abs(aDiff) < 0.45) {
                h = Math.min(h, BASIN_LEVEL - 0.12); // spill notch
            } else {
                const rimK = 1 - smoothstep(db, L.R_B, L.R_B + 1.4);
                h = Math.max(h, lerp(h, BASIN_LEVEL + 0.5, rimK));
            }
        }
    }

    // Magma vent pocket on the flank
    const vdx = x - L.VX, vdz = z - L.VZ;
    const dv = Math.sqrt(vdx * vdx + vdz * vdz);
    if (dv < L.R_V + 1.0) {
        ensureLazy();
        h = lerp(VENT_FLOOR, h, smoothstep(dv, L.R_V * 0.55, L.R_V + 1.0));
    }

    // River carved last, fading out where each course's waterfall face takes
    // over (the mountain cascade for M, the border cliff for B)
    if (rv) {
        const longK = rv.course === 'M'
            ? 1 - smoothstep(rv.u, L.U_FALL - 0.5, L.U_FALL + 1.6)
            : 1 - smoothstep(rv.u, L.U_B_POOL + 0.4, L.U_B_POOL + 2.4);
        if (longK > 0) h = lerp(h, lerp(rv.bed, h, rv.t), longK);
    }

    // Caves carved LAST. Away from the water/mountain/vent the structural carves
    // above never touch a cave footprint, so order is a no-op there — but the
    // Phase 2f under-river crossing deliberately dives beneath the river channel,
    // and carving last lets its dry pocket win over the river bed above it.
    if (CAVES.length) h = caveHeight(x, z, h);

    return h;
}

/* ------------------------------------------------------------
   Rendered voxel-surface height — the top FACE of the tallest
   terrain voxel in the column that (x,z) falls in.

   getTerrainHeight is the ANALYTIC surface and the generator for
   everything, but terrain.js renders each grid COLUMN as a stack
   of VOXEL_SIZE (0.85) cubes: it samples the height at the column
   CENTRE, then stacks cube centres from floorY+V/2 up to the last
   one <= surfaceY. A creature standing on the raw analytic value
   therefore sinks up to ~half a voxel (more on slopes, where the
   analytic point sits below the uphill column's flat top) into the
   block it visually rests on. Everything that STANDS / WALKS /
   LANDS / RESTS on the ground (player feet, creatures, projectile
   & settled-ball ground contact, the targeting ring) uses this so
   feet meet the block top. The surface is piecewise-flat per column
   — creatures step between columns exactly like the rendered voxels
   do. Inside caves the same math returns the rendered cave floor,
   because those columns are built from the carved getTerrainHeight.
   ------------------------------------------------------------ */
export function getGroundY(x, z) {
    const V = CONFIG.VOXEL_SIZE;
    const half = CONFIG.ARENA_SIZE / 2;
    const n = Math.floor((2 * half) / V);              // column count per axis
    let ix = Math.floor((x + half) / V);
    let iz = Math.floor((z + half) / V);
    if (ix < 0) ix = 0; else if (ix >= n) ix = n - 1;
    if (iz < 0) iz = 0; else if (iz >= n) iz = n - 1;
    const cx = -half + ix * V + V / 2;                 // column centre (as built)
    const cz = -half + iz * V + V / 2;
    // pond columns render sandy bowl blocks whose top face == the analytic bowl
    if (cx * cx + cz * cz < CONFIG.POND_RADIUS * CONFIG.POND_RADIUS) {
        return getTerrainHeight(cx, cz);
    }
    const surfaceY = getTerrainHeight(cx, cz);
    const hN = getTerrainHeight(cx, cz - V);
    const hS = getTerrainHeight(cx, cz + V);
    const hW = getTerrainHeight(cx - V, cz);
    const hE = getTerrainHeight(cx + V, cz);
    const floorY = Math.max(-2.0, Math.min(surfaceY, hN, hS, hW, hE) - 0.45);
    const base = floorY + V / 2;                       // lowest voxel centre
    const k = Math.max(0, Math.floor((surfaceY - base) / V + 1e-6));
    return base + k * V + V / 2;                        // top face of the top voxel
}

/* ------------------------------------------------------------
   Water field — one predicate for the whole water network
   (pond + river + plunge pool + elevated spring basin).
   pad > 0  : "within pad meters of water" (land-creature avoidance)
   pad < 0  : "at least |pad| meters INSIDE water" (aquatic containment)
   ------------------------------------------------------------ */
export function isWaterAt(x, z, pad = 0) {
    // The ONE wet cave's pools + stream count as water (ICE pools stay solid/dry);
    // every other cave interior is DRY, overriding outdoor pond/river slivers below.
    for (let i = 0; i < CAVES.length; i++) {
        const c = CAVES[i];
        if (!c.pools) continue;
        if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue;
        if (caveWaterIsWater(c, x, z, pad)) return true;
    }
    if (CAVES.length) {
        const cf = sampleCave(x, z);
        if (cf && cf.lat < cf.hw + 0.3) return false; // dry cave interior
    }
    const d = Math.sqrt(x * x + z * z);
    if (d < CONFIG.POND_RADIUS + pad) return true;
    const rv = riverAt(x, z);
    if (rv && rv.lat < rv.wWater + pad) {
        // stop the water at each course's plunge face (below the falls it is a
        // cliff, not open channel)
        if (rv.course === 'M' ? rv.u < L.U_FALL + 0.3 : rv.u < L.U_B_POOL + 1.6) return true;
    }
    const bdx = x - L.BX, bdz = z - L.BZ;
    return (bdx * bdx + bdz * bdz) < (L.R_B - 0.15 + pad) * (L.R_B - 0.15 + pad);
}

// Water surface height at (x,z): a cave pool/stream (correct even up a mountain
// flank, for ball-splash + wade), the elevated spring basin, else the waterline.
export function getWaterLevelAt(x, z) {
    for (let i = 0; i < CAVES.length; i++) {
        const c = CAVES[i];
        if (!c.pools || x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue;
        const lvl = caveWaterLevelAt(c, x, z, getTerrainHeight(x, z));
        if (lvl != null) return lvl;
    }
    const bdx = x - L.BX, bdz = z - L.BZ;
    if ((bdx * bdx + bdz * bdz) < (L.R_B + 0.4) * (L.R_B + 0.4)) return getBasinLevel();
    return CONFIG.POND_WATER_LEVEL;
}

// Slippery footing (Phase 2i item 44): the wet rim of a cave pool/stream bank.
export function caveSlippery(x, z) {
    for (let i = 0; i < CAVES.length; i++) {
        const c = CAVES[i];
        if (c.pools && x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ && caveWetEdgeOne(c, x, z)) return true;
    }
    return false;
}

// Depth of water below the surface at (x,z); 0 where dry
export function getWaterDepth(x, z) {
    if (!isWaterAt(x, z)) return 0;
    return Math.max(0, getWaterLevelAt(x, z) - getTerrainHeight(x, z));
}

// Nearest guaranteed-dry spot to (x,z) — used by breakouts and fixed
// points of interest so no seed strands them in the water network.
export function findDryLand(x, z, pad = 1.2) {
    const lim = CONFIG.ARENA_SIZE / 2 - 2.5;
    const cx = THREE.MathUtils.clamp(x, -lim, lim);
    const cz = THREE.MathUtils.clamp(z, -lim, lim);
    if (!isWaterAt(cx, cz, pad)) return { x: cx, z: cz };
    for (let rad = 1.5; rad <= 20; rad += 1.5) {
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2 + rad;
            const nx = THREE.MathUtils.clamp(cx + Math.cos(a) * rad, -lim, lim);
            const nz = THREE.MathUtils.clamp(cz + Math.sin(a) * rad, -lim, lim);
            if (!isWaterAt(nx, nz, pad)) return { x: nx, z: nz };
        }
    }
    return { x: SPAWN.x, z: SPAWN.z }; // spawn pad is always dry
}

/* ------------------------------------------------------------
   Seeded spawn pad location. Picks a fresh point every load,
   preferring a GENTLE zone (meadow / lakeside / forest / …),
   on dry lowland, clear of the pond/river, the mountain and the
   magma vent, on a gentle slope. Runs at module-eval time (after
   the height/water functions above exist) with SPAWN.r == 0, so
   the not-yet-placed pad never perturbs the probes. Everything
   downstream — the flat pad in baseHeight, flora spawn-avoidance,
   the camera — reads the SPAWN object, so it all follows.
   ------------------------------------------------------------ */
function pickSpawn() {
    const r = mulberry32((CONFIG.WORLD_SEED ^ 0x5eed17) >>> 0);
    const half = CONFIG.ARENA_SIZE / 2;
    const inner = CONFIG.POND_RADIUS + 6;
    const outer = half - 12;
    const slopeAt = (x, z) => {
        const h = getTerrainHeight(x, z), s = 1.3;
        return Math.max(
            Math.abs(getTerrainHeight(x + s, z) - h),
            Math.abs(getTerrainHeight(x - s, z) - h),
            Math.abs(getTerrainHeight(x, z + s) - h),
            Math.abs(getTerrainHeight(x, z - s) - h),
        );
    };
    const nearFeature = (x, z) => {
        for (const mt of MOUNTAINS) if ((x - mt.x) ** 2 + (z - mt.z) ** 2 < (mt.r + 5) ** 2) return true;
        if ((x - L.VX) ** 2 + (z - L.VZ) ** 2 < (L.R_V + 6) ** 2) return true;
        const cf = sampleCave(x, z);
        if (cf && cf.lat < cf.hw + 3) return true; // never spawn in or right at a cave mouth
        return false;
    };
    let fallback = null;
    for (let i = 0; i < 600; i++) {
        const ang = r() * Math.PI * 2;
        const rad = inner + r() * (outer - inner);
        const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
        if (isWaterAt(x, z, 2.2)) continue;
        if (nearFeature(x, z)) continue;
        const h = getTerrainHeight(x, z);
        if (h < 0.35 || h > 3.0) continue;      // dry, flat lowland (not cliff/mountain)
        if (slopeAt(x, z) > 0.9) continue;       // gentle ground only
        // pad height sits flush with the local ground so it reads as a natural
        // clearing rather than a raised/sunken platform
        const cand = { x, z, h: THREE.MathUtils.clamp(h, 0.5, 2.5) };
        if (PARTITION.gentleSectors.has(PARTITION.sectorIndexAt(x, z))) {
            return cand;                          // gentle zone — take it
        }
        if (!fallback) fallback = cand;           // else remember the first decent spot
    }
    return fallback || { x: CONFIG.SPAWN_X, z: CONFIG.SPAWN_Z, h: CONFIG.SPAWN_HEIGHT };
}

// Caves first: getTerrainHeight now carves their floors, so the spawn picker
// below (which samples getTerrainHeight) already sees and avoids them. Cave
// GENERATION lives in caves-data.js (keeps this file lean); it needs the seeded
// layout + partition + the height/water fields, passed in as deps.
(() => {
    const caves = placeCaves({
        L, PARTITION, MOUNTAINS, baseHeight, isWaterAt,
        riverPointAt, riverTangent, riverAt, riverSpan, // Phase 2f: under-river crossing
        seed: CONFIG.WORLD_SEED, half: CONFIG.ARENA_SIZE / 2,
        pondR: CONFIG.POND_RADIUS, waterLevel: CONFIG.POND_WATER_LEVEL,
    });
    for (let i = 0; i < caves.length; i++) CAVES.push(caves[i]);
})();

(() => {
    const sp = pickSpawn();
    SPAWN.x = sp.x;
    SPAWN.z = sp.z;
    SPAWN.h = sp.h;
    SPAWN.r = CONFIG.SPAWN_RADIUS; // activate the flat pad now that it is placed
})();
