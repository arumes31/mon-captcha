/* ============================================================
   Terrain & Environment (High Fidelity Voxel)
   ============================================================ */

import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { mulberry32, worldNoise } from './random.js';
import { getTerrainHeight, isWaterAt, MOUNTAINS, VENT, CAVES, sampleCave, SPAWN, BORDER_FALL, riverAt, riverPointAt, riverSpan, riverTangent } from './heightfield.js';
import { SUN_DIRECTION } from './engine.js';
import { zoneBlendAt, zoneAt } from './zones/zones.js';
import { buildFlora } from './flora/flora.js';
import { buildClouds, buildAmbientLife, buildPointsOfInterest, buildZoneAmbient } from './atmosphere.js';
import { buildMountainFeatures } from './mountain/mountain.js';
import { buildLava, ensureLavaCourse, lavaAt, inLavaFootprint } from './lava.js';
import { buildCaves } from './caves/caves.js';
import { buildChunkedInstances, primeOcclusion } from './culling.js';
import { weatherState } from './weather/weather.js';
import { spawnWaterRipple } from './particles.js';

// Snow line per mountain (set from each massif's actual peak height in
// buildTerrain so every seed keeps a proportioned cap). Index-aligned to
// MOUNTAINS; the surface-cap colourer picks the massif the column sits on.
let mountSnow = [];

// Water-surface extras (items 53/54/57/58/59/62/67/69/70/77) — build->update
// handoff for this file's own self-driven ticker. game.js's animate() loop is
// out of this file's scope to edit, so these are updated via onBeforeRender
// on the Water mesh itself (already rendered every frame the world is
// visible) rather than a new call wired into the main loop. Reassigned whole
// on every buildTerrain(); the previous generation's objects (and the scene
// they lived in) become garbage once nothing else references them.
let _waterExtras = null;

/* ------------------------------------------------------------
   Per-column zone colors. zoneBlendAt gives the primary zone,
   the neighbour it borders and a cross-fade weight, so palettes
   melt across the soft dithered borders. Zone palette hexes are
   authored in the same near-linear space the rest of voxelColor
   writes with setRGB, so they are unpacked byte-wise (no sRGB
   decode) to stay consistent. `m` (biome noise) picks each
   zone's shadow->sunny surface variant. Reuses module temps —
   no per-column allocation.
   ------------------------------------------------------------ */
const _zc = {
    sr: 0, sg: 0, sb: 0, dr: 0, dg: 0, db: 0, pr: 0, pg: 0, pb: 0,
    // item 100 + zone-gated micro-detail (103/107/108): the dominant zone id(s)
    // and the (possibly re-shaped) border weight, exposed so voxelColor can gate
    // small zone-specific reads without re-deriving zoneBlendAt per voxel.
    aid: '', bid: '', zt: 0,
};
const _lr = (h) => ((h >> 16) & 255) / 255;
const _lg = (h) => ((h >> 8) & 255) / 255;
const _lb = (h) => (h & 255) / 255;
const _mix = (a, b, t) => a + (b - a) * t;
function computeZoneColors(cx, cz, m) {
    const zb = zoneBlendAt(cx, cz);
    const A = zb.a, B = zb.b;
    // item 100: steepen the border crossfade for CONTRASTING zone pairs (large
    // surf1 hue distance) and keep it closer to linear for gentle pairs, so
    // e.g. desert->jungle reads more abrupt than meadow->lakeside — purely a
    // function of the two zones' own palettes, no hardcoded pair table.
    let t = zb.t;
    if (t > 0) {
        const hueDist = Math.abs(_lr(A.surf1) - _lr(B.surf1))
            + Math.abs(_lg(A.surf1) - _lg(B.surf1))
            + Math.abs(_lb(A.surf1) - _lb(B.surf1));
        t = Math.pow(t / 0.5, 1 + hueDist * 1.4) * 0.5;
    }
    // surface: blend each zone's shadow(surf0)->sunny(surf1) by m, then A->B by t
    let sr = _mix(_lr(A.surf0), _lr(A.surf1), m);
    let sg = _mix(_lg(A.surf0), _lg(A.surf1), m);
    let sb = _mix(_lb(A.surf0), _lb(A.surf1), m);
    let dr = _lr(A.dirt), dg = _lg(A.dirt), db = _lb(A.dirt);
    let pr = _lr(A.rock), pg = _lg(A.rock), pb = _lb(A.rock);
    if (t > 0) {
        sr = _mix(sr, _mix(_lr(B.surf0), _lr(B.surf1), m), t);
        sg = _mix(sg, _mix(_lg(B.surf0), _lg(B.surf1), m), t);
        sb = _mix(sb, _mix(_lb(B.surf0), _lb(B.surf1), m), t);
        dr = _mix(dr, _lr(B.dirt), t); dg = _mix(dg, _lg(B.dirt), t); db = _mix(db, _lb(B.dirt), t);
        pr = _mix(pr, _lr(B.rock), t); pg = _mix(pg, _lg(B.rock), t); pb = _mix(pb, _lb(B.rock), t);
    }
    _zc.sr = sr; _zc.sg = sg; _zc.sb = sb;
    _zc.dr = dr; _zc.dg = dg; _zc.db = db;
    _zc.pr = pr; _zc.pg = pg; _zc.pb = pb;
    _zc.aid = A.id; _zc.bid = B.id; _zc.zt = t;
    return _zc;
}
// True if either side of the (possibly cross-faded) zone pair at this column
// matches `id` — used by zone-gated micro-detail below.
function zoneIs(zc, id) { return zc.aid === id || (zc.zt > 0.15 && zc.bid === id); }

// Zone-aware voxel color picker:
//   - per-zone terrain palette (12 zones), cross-faded across soft borders,
//     via the precomputed per-column zc (computeZoneColors)
//   - sandy shore ring fading into grass around the pond
//   - riverbed/riverbank, outer cliff wall, landmark mountain rock+snow,
//     scorched magma ring — all structural overrides layered ON TOP of the zone
//   - per-voxel jitter so no two blocks read identical
function voxelColor(x, z, y, surfaceY, zc, slope, outColor) {
    const depth = surfaceY - y;
    const d = Math.sqrt(x * x + z * z);
    const half = CONFIG.ARENA_SIZE / 2;
    // per-voxel color jitter (hashed noise, deterministic)
    const v = worldNoise(x * 2.7 + y * 1.3, z * 2.7 - y * 0.7, 2, 2.0, 0.5) * 0.05;

    if (depth < 0.5) {
        // ---- surface cap: zone palette (already m-blended + border-crossfaded) ----
        let r = zc.sr + v;
        let g = zc.sg + v * 0.7;
        let b = zc.sb + v * 0.5;
        // sandy shore ring around the pond
        if (d < CONFIG.POND_RADIUS + 1.7) {
            const t = THREE.MathUtils.smoothstep(d, CONFIG.POND_RADIUS, CONFIG.POND_RADIUS + 1.7);
            r = THREE.MathUtils.lerp(0.85 + v, r, t);
            g = THREE.MathUtils.lerp(0.76 + v, g, t);
            b = THREE.MathUtils.lerp(0.55 + v, b, t);
        }
        // item 97: worn dirt path annulus around the spawn pad (broken into
        // irregular tendrils by angular noise, so it reads as trampled ground
        // rather than a drawn ring)
        if (SPAWN.r > 0) {
            const spx = x - SPAWN.x, spz = z - SPAWN.z;
            const spd = Math.sqrt(spx * spx + spz * spz);
            if (spd > SPAWN.r * 0.8 && spd < SPAWN.r * 2.6) {
                const am = Math.atan2(spz, spx);
                const tendril = worldNoise(Math.cos(am) * 5 + spd * 0.15, Math.sin(am) * 5, 2, 2.0, 0.5) * 0.5 + 0.5;
                const band = THREE.MathUtils.smoothstep(spd, SPAWN.r * 0.8, SPAWN.r * 1.3)
                    * (1 - THREE.MathUtils.smoothstep(spd, SPAWN.r * 1.8, SPAWN.r * 2.6));
                const pathK = Math.max(0, band * tendril - 0.18);
                if (pathK > 0) {
                    r = THREE.MathUtils.lerp(r, 0.40 + v, pathK * 0.6);
                    g = THREE.MathUtils.lerp(g, 0.36 + v, pathK * 0.6);
                    b = THREE.MathUtils.lerp(b, 0.30 + v, pathK * 0.6);
                }
            }
        }
        // riverbed & riverbanks: submerged caps turn to depth-tinted sand,
        // low dry banks fade from sand back into grass
        const nearRiver = d >= CONFIG.POND_RADIUS ? riverAt(x, z) : null;
        if (surfaceY < 0.42 && d >= CONFIG.POND_RADIUS) {
            const wet = Math.min(1, Math.max(0, (0.42 - surfaceY) / 0.6)); // 0 dry bank -> 1 deep bed
            const deep = Math.min(1, Math.max(0, -surfaceY / 0.9));
            const sr = THREE.MathUtils.lerp(0.85, 0.52, deep) + v;
            const sg = THREE.MathUtils.lerp(0.76, 0.5, deep) + v;
            const sb = THREE.MathUtils.lerp(0.55, 0.38, deep) + v * 0.8;
            r = THREE.MathUtils.lerp(r, sr, 0.35 + wet * 0.65);
            g = THREE.MathUtils.lerp(g, sg, 0.35 + wet * 0.65);
            b = THREE.MathUtils.lerp(b, sb, 0.35 + wet * 0.65);
        }
        // items 96/110: beyond the sandy bed/bank blend above, a soft wetness
        // darkening that fades continuously with proximity to the channel
        // (nearRiver.t: 0 at the channel, 1 at the outer bank edge) instead of
        // switching on only where the ground happens to dip low.
        if (nearRiver) {
            const nearBank = 1 - nearRiver.t;
            if (nearBank > 0) {
                r *= 1 - nearBank * 0.16;
                g *= 1 - nearBank * 0.12;
                b *= 1 - nearBank * 0.08;
            }
        }
        // item 107: desert sand-ripple micro-pattern — zone-gated via the
        // dominant id(s) already resolved in zc, no separate zone lookup
        if (zoneIs(zc, 'desert')) {
            const ripple = Math.sin(x * 1.9 + Math.sin(z * 0.55) * 1.3) * 0.5 + 0.5;
            r += (ripple - 0.5) * 0.035;
            g += (ripple - 0.5) * 0.03;
            b += (ripple - 0.5) * 0.018;
        }
        // item 108: moss/lichen on rocks near water in mushroom/swamp zones
        if ((zoneIs(zc, 'mushroom') || zoneIs(zc, 'swamp')) && (d < CONFIG.POND_RADIUS + 6 || nearRiver)) {
            const mossK = 0.22;
            r = THREE.MathUtils.lerp(r, 0.20, mossK);
            g = THREE.MathUtils.lerp(g, 0.40, mossK);
            b = THREE.MathUtils.lerp(b, 0.19, mossK);
        }
        // outer cliff band: grass gives way to weathered rocky top (kept subtle so
        // the mid-distance ring stays green rather than drab gray)
        if (d > half - 4) {
            const t = Math.min(1, (d - (half - 4)) / 3.5);
            r = THREE.MathUtils.lerp(r, 0.50 + v, t * 0.65);
            g = THREE.MathUtils.lerp(g, 0.48 + v, t * 0.65);
            b = THREE.MathUtils.lerp(b, 0.42 + v, t * 0.65);
        }
        // landmark mountains: banded rock above the grass line, snow at each cap
        for (let mi = 0; mi < MOUNTAINS.length; mi++) {
            const mt = MOUNTAINS[mi];
            const mdx = x - mt.x, mdz = z - mt.z;
            if (mdx * mdx + mdz * mdz >= (mt.r + 1.5) * (mt.r + 1.5)) continue;
            // item 125: exposed scree/rubble band right where grass gives way
            // to rock (a speckled transition strip, not a hard color snap)
            const screeK = THREE.MathUtils.smoothstep(surfaceY, 1.7, 2.6) * (1 - THREE.MathUtils.smoothstep(surfaceY, 2.6, 3.3));
            if (screeK > 0) {
                const clast = worldNoise(x * 1.3, z * 1.3, 2, 2.0, 0.5) * 0.5 + 0.5;
                const rr = THREE.MathUtils.lerp(0.38, 0.52, clast) + v;
                const rg = THREE.MathUtils.lerp(0.37, 0.49, clast) + v;
                const rb = THREE.MathUtils.lerp(0.36, 0.46, clast) + v * 0.8;
                r = THREE.MathUtils.lerp(r, rr, screeK * 0.7);
                g = THREE.MathUtils.lerp(g, rg, screeK * 0.7);
                b = THREE.MathUtils.lerp(b, rb, screeK * 0.7);
            }
            if (surfaceY <= 2.6) break;
            const band = Math.sin(y * 2.1 + worldNoise(x * 0.2, z * 0.2, 2, 2.0, 0.5) * 2.5) * 0.5 + 0.5;
            const rockK = THREE.MathUtils.smoothstep(surfaceY, 2.6, 4.6);
            r = THREE.MathUtils.lerp(r, THREE.MathUtils.lerp(0.42, 0.56, band) + v, rockK);
            g = THREE.MathUtils.lerp(g, THREE.MathUtils.lerp(0.40, 0.53, band) + v, rockK);
            b = THREE.MathUtils.lerp(b, THREE.MathUtils.lerp(0.41, 0.53, band) + v * 0.8, rockK);
            // item 120: a darker zigzag switchback/goat-track band crossing the
            // flank — a sine of (angle, radius) picks out a thin diagonal path
            if (rockK > 0.3) {
                const am = Math.atan2(mdz, mdx);
                const radNorm = Math.sqrt(mdx * mdx + mdz * mdz) / mt.r;
                const zig = Math.sin(am * 5 + radNorm * 14);
                const trailK = (1 - THREE.MathUtils.smoothstep(Math.abs(zig), 0, 0.15)) * rockK * 0.3;
                if (trailK > 0) { r *= 1 - trailK; g *= 1 - trailK; b *= 1 - trailK; }
            }
            // item 103: frost/rime on steep, sun-averted slopes below the snow
            // line — approximated from this column's neighbor-height aspect
            // (slope.sunFacing, precomputed once per column) rather than a
            // per-zone id (works uniformly across every cold massif)
            const sl0 = mountSnow[mi] !== undefined ? mountSnow[mi] : 99;
            const frostBand = THREE.MathUtils.smoothstep(surfaceY, sl0 - 5.5, sl0 - 1.0)
                * (1 - THREE.MathUtils.smoothstep(surfaceY, sl0 - 1.0, sl0 + 0.2));
            if (frostBand > 0 && slope.steep > 0.4 && slope.sunFacing < -0.12) {
                const frostK = frostBand * Math.min(1, slope.steep) * Math.min(1, -slope.sunFacing * 2.2) * 0.5;
                r = THREE.MathUtils.lerp(r, 0.82 + v, frostK);
                g = THREE.MathUtils.lerp(g, 0.87 + v, frostK);
                b = THREE.MathUtils.lerp(b, 0.93 + v * 0.5, frostK);
            }
            const snowK = THREE.MathUtils.smoothstep(surfaceY, sl0, sl0 + 1.8);
            if (snowK > 0) {
                r = THREE.MathUtils.lerp(r, 0.93 + v, snowK);
                g = THREE.MathUtils.lerp(g, 0.95 + v, snowK);
                b = THREE.MathUtils.lerp(b, 0.99 + v * 0.5, snowK);
            }
            break; // massifs don't overlap — at most one owns this column
        }
        // scorched basalt ring around the magma vent, veined with hot cracks
        const vdx = x - VENT.x, vdz = z - VENT.z;
        const dvt = Math.sqrt(vdx * vdx + vdz * vdz);
        if (dvt < VENT.r + 2.4) {
            const burn = 1 - THREE.MathUtils.smoothstep(dvt, VENT.r, VENT.r + 2.4);
            r = THREE.MathUtils.lerp(r, 0.16 + v * 0.5, burn * 0.9);
            g = THREE.MathUtils.lerp(g, 0.13 + v * 0.4, burn * 0.9);
            b = THREE.MathUtils.lerp(b, 0.12 + v * 0.4, burn * 0.9);
            if (burn > 0.55 && v > 0.024) { r = 0.78; g = 0.3; b = 0.07; } // glowing veins
        }
        // items 236/237/104: scorched-ground gradient radiating outward from
        // the flowing lava COURSE itself (distinct from the point-source vent
        // ring above), plus sparse static "glowing crack" seams in its margin.
        // (A true per-frame pulse on these specific instances would need to
        // reach into culling.js's chunk-local instance indices, which is out
        // of this file's scope — this bakes a bright static seam instead.)
        const lv = lavaAt(x, z);
        if (lv && !lv.inside) {
            const burn2 = 1 - THREE.MathUtils.smoothstep(lv.lat, lv.hw, lv.hw + 3.4);
            if (burn2 > 0) {
                r = THREE.MathUtils.lerp(r, 0.17 + v * 0.5, burn2 * 0.85);
                g = THREE.MathUtils.lerp(g, 0.14 + v * 0.4, burn2 * 0.85);
                b = THREE.MathUtils.lerp(b, 0.13 + v * 0.4, burn2 * 0.85);
                if (burn2 > 0.5 && v > 0.026) { r = 0.82; g = 0.34; b = 0.08; }
            }
        }
        outColor.setRGB(r, g, b);
    } else if (depth < 2.0) {
        // ---- rich brown dirt, slightly darker & moist near the pond ----
        // (mountain flanks read as rock instead of soil)
        let onMountain = false;
        for (let mi = 0; mi < MOUNTAINS.length; mi++) {
            const mt = MOUNTAINS[mi], mdx = x - mt.x, mdz = z - mt.z;
            if (mdx * mdx + mdz * mdz < (mt.r + 1.5) * (mt.r + 1.5) && surfaceY > 3.2) { onMountain = true; break; }
        }
        if (onMountain) {
            const band = Math.sin(y * 3.2 + worldNoise(x * 0.14, z * 0.14, 2, 2.0, 0.5) * 2.2) * 0.5 + 0.5;
            outColor.setRGB(
                THREE.MathUtils.lerp(0.36, 0.48, band) + v,
                THREE.MathUtils.lerp(0.35, 0.45, band) + v,
                THREE.MathUtils.lerp(0.36, 0.45, band) + v * 0.8
            );
            return outColor;
        }
        const moist = d < CONFIG.POND_RADIUS + 3 ? 0.06 : 0.0;
        outColor.setRGB(zc.dr + v - moist, zc.dg + v - moist * 0.7, zc.db + v * 0.6);
    } else {
        // ---- deep stone with horizontal strata banding, tinted per zone ----
        const band = Math.sin(y * 3.2 + worldNoise(x * 0.14, z * 0.14, 2, 2.0, 0.5) * 2.2) * 0.5 + 0.5;
        const k = 0.82 + band * 0.34; // strata light/dark around the zone rock tone
        outColor.setRGB(zc.pr * k + v, zc.pg * k + v, zc.pb * k + v * 0.8);
    }
    return outColor;
}

// A box with its top (+y) face stripped — for a column voxel buried under
// another voxel of the SAME column, whose top face sits flush against the
// one above (identical x/z, exactly one V_STEP up) and is therefore always
// hidden, no neighbor-dependent exceptions needed (unlike the bottom face,
// which can occasionally be seen from inside a cave or a cliff edge, so it
// stays intact). BoxGeometry's face groups (no segment subdivisions) run
// +x,-x,+y,-y,+z,-z at 6 indices each — the +y/top face is exactly indices
// 12-17 (verified against the pinned three@0.160.0 source).
function buildInteriorVoxelGeo(size) {
    const box = new THREE.BoxGeometry(size, size, size);
    const srcIndex = box.getIndex();
    const kept = [];
    for (let i = 0; i < srcIndex.count; i++) {
        if (i >= 12 && i < 18) continue; // +y (top) face
        kept.push(srcIndex.getX(i));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', box.getAttribute('position'));
    geo.setAttribute('normal', box.getAttribute('normal'));
    geo.setAttribute('uv', box.getAttribute('uv'));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(kept), 1));
    return geo;
}

// Ground-detail props (items 65/73/99/112/242) — the caller appends this
// list's output into the SAME `details` array buildFlora() returns, so these
// ride the existing detailChunks build/dispose lifecycle for free (no new
// state field, no new teardown to wire up in game.js). Kept modest: well
// under a thousand instances against the ~16.5k flora budget and the ~42k
// world-wide ceiling.
function buildGroundDetailProps(half) {
    const out = [];
    const rng = mulberry32(CONFIG.WORLD_SEED ^ 0xc0b7e5);

    const clearOfFeatures = (x, z, d) => {
        if (d < CONFIG.POND_RADIUS + 2) return false;
        for (const mt of MOUNTAINS) if ((x - mt.x) ** 2 + (z - mt.z) ** 2 < (mt.r + 2) ** 2) return false;
        if (isWaterAt(x, z, 0.6)) return false;
        return true;
    };

    // item 99: sparse pebble/cracked-mud speckle to break up flat ground
    for (let i = 0; i < 380; i++) {
        const x = (rng() * 2 - 1) * (half - 2), z = (rng() * 2 - 1) * (half - 2);
        const d = Math.hypot(x, z);
        if (!clearOfFeatures(x, z, d) || inLavaFootprint(x, z)) continue;
        const y = getTerrainHeight(x, z);
        const s = 0.09 + rng() * 0.1;
        const tone = 0.3 + rng() * 0.25;
        out.push({
            x, y: y + s * 0.25, z, sx: s, sy: s * 0.35, sz: s * (0.8 + rng() * 0.5),
            rx: 0, ry: rng() * Math.PI, rz: 0,
            color: new THREE.Color(tone * 0.9, tone * 0.85, tone * 0.75).getHex(), kind: 'pebble',
        });
    }

    // item 112a: driftwood clutter near the lakeside zone's water edge
    for (let i = 0; i < 14; i++) {
        const ang = rng() * Math.PI * 2;
        const rad = CONFIG.POND_RADIUS + 2 + rng() * 5;
        const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
        const zb = zoneBlendAt(x, z);
        if (zb.a.id !== 'lakeside' && !(zb.t > 0.3 && zb.b.id === 'lakeside')) continue;
        const y = getTerrainHeight(x, z);
        const len = 0.9 + rng() * 0.8;
        out.push({
            x, y: y + 0.08, z, sx: 0.09, sy: 0.09, sz: len,
            rx: 0, ry: rng() * Math.PI, rz: 0,
            color: 0x6b5230, kind: 'driftwood',
        });
    }

    // item 112b: bleached bones scattered around the volcanic scorch ring
    for (let i = 0; i < 12; i++) {
        const ang = rng() * Math.PI * 2;
        const rad = VENT.r + 2.6 + rng() * 3.5;
        const x = VENT.x + Math.cos(ang) * rad, z = VENT.z + Math.sin(ang) * rad;
        const d = Math.hypot(x, z);
        if (d > half - 3 || d < CONFIG.POND_RADIUS + 1) continue;
        const y = getTerrainHeight(x, z);
        const s = 0.18 + rng() * 0.12;
        out.push({
            x, y: y + s * 0.3, z, sx: s, sy: s * 0.4, sz: s * 2.2,
            rx: 0, ry: rng() * Math.PI, rz: 0,
            color: 0xd8cfb8, kind: 'bone',
        });
    }

    // item 242: obsidian-glass rock variant right at the cooled margin of the
    // lava course (offset OUTSIDE it — inside is the molten crust mesh itself)
    {
        const nodes = ensureLavaCourse();
        for (let i = 0; i < 20 && nodes.length > 1; i++) {
            const seg = Math.floor(rng() * (nodes.length - 1));
            const a = nodes[seg], b = nodes[seg + 1], s = rng();
            const bx = a.x + (b.x - a.x) * s, bz = a.z + (b.z - a.z) * s;
            const hw = a.hw + (b.hw - a.hw) * s;
            const side = rng() < 0.5 ? -1 : 1;
            const ang = Math.atan2(b.z - a.z, b.x - a.x) + (Math.PI / 2) * side;
            const off = hw + 0.4 + rng() * 1.4;
            const x = bx + Math.cos(ang) * off, z = bz + Math.sin(ang) * off;
            if (Math.hypot(x, z) > half - 2) continue;
            const y = getTerrainHeight(x, z);
            const sc = 0.22 + rng() * 0.22;
            const shine = 0.08 + rng() * 0.08;
            out.push({
                x, y: y + sc * 0.4, z, sx: sc, sy: sc * (0.6 + rng() * 0.5), sz: sc,
                rx: 0, ry: rng() * Math.PI, rz: 0,
                color: new THREE.Color(shine, shine * 0.95, shine * 1.15).getHex(), kind: 'obsidian',
            });
        }
    }

    // items 65/73: stepping-stone crossing + visible gravel speckle at each
    // seeded FORD point (BORDER_FALL.fords), instead of a purely gameplay-only
    // depth reduction — perpendicular offset uses the river's base bearing.
    const tang = riverTangent();
    const perp = { x: -tang.z, z: tang.x };
    for (const ford of BORDER_FALL.fords) {
        for (let i = 0; i < 5; i++) {
            const off = (i - 2) * 1.15 + (rng() - 0.5) * 0.3;
            const x = ford.x + perp.x * off, z = ford.z + perp.z * off;
            const topY = Math.max(getTerrainHeight(x, z), CONFIG.POND_WATER_LEVEL - 0.05);
            const s = 0.55 + rng() * 0.25;
            out.push({
                x, y: topY + s * 0.22, z, sx: s, sy: s * 0.45, sz: s * (0.85 + rng() * 0.3),
                rx: 0, ry: rng() * Math.PI, rz: 0,
                color: new THREE.Color(0.42 + rng() * 0.08, 0.40 + rng() * 0.08, 0.38 + rng() * 0.08).getHex(),
                kind: 'fordstone',
            });
        }
        for (let i = 0; i < 14; i++) {
            const off = (rng() * 2 - 1) * 2.2, along = (rng() * 2 - 1) * 1.6;
            const x = ford.x + perp.x * off + tang.x * along;
            const z = ford.z + perp.z * off + tang.z * along;
            const gy = Math.min(getTerrainHeight(x, z), CONFIG.POND_WATER_LEVEL - 0.12);
            const s = 0.08 + rng() * 0.07;
            out.push({
                x, y: gy + s * 0.3, z, sx: s, sy: s * 0.4, sz: s,
                rx: 0, ry: rng() * Math.PI, rz: 0,
                color: new THREE.Color(0.35, 0.33, 0.30).offsetHSL(0, 0, (rng() - 0.5) * 0.08).getHex(),
                kind: 'gravel',
            });
        }
    }

    return out;
}

/* ------------------------------------------------------------
   Water-surface extras (items 53/54/57/58/59/62/67/69/70/77).
   Built once from buildTerrain(); animated by updateWaterExtras(), which
   this file self-schedules via the Water mesh's onBeforeRender (see the
   _waterExtras comment above for why — no game.js hook to add here).
   ------------------------------------------------------------ */
function buildWaterExtras(half) {
    const w = {};

    // item 69: pond depth-gradient overlay (lighter shallow rim, darker
    // centre) — a radial canvas-gradient disc just above the Water plane,
    // so it reads as depth without touching the Water shader itself.
    {
        const geo = new THREE.CircleGeometry(CONFIG.POND_RADIUS + 0.05, 40);
        const mat = new THREE.MeshBasicMaterial({
            map: makePondGradientTexture(), transparent: true, opacity: 0.55, depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = CONFIG.POND_WATER_LEVEL + 0.012;
        mesh.renderOrder = 1;
        state.scene.add(mesh);
        w.gradientTex = mat.map;
    }

    // item 54: faint scrolling caustics over the pond bed
    {
        const geo = new THREE.CircleGeometry(CONFIG.POND_RADIUS - 0.4, 40);
        const tex = makeCausticsTexture();
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(3, 3);
        const mat = new THREE.MeshBasicMaterial({
            map: tex, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = CONFIG.POND_WATER_LEVEL - 0.35; // near the sandy bed, under the surface
        state.scene.add(mesh);
        w.caustics = mesh;
        w.causticsTex = tex;
    }

    // items 53/62: river-bank foam patches + downstream flow-direction debris,
    // sampled along the main river course via riverPointAt/riverAt
    {
        const seedR = mulberry32(CONFIG.WORLD_SEED ^ 0x0f0a3e);
        const span = riverSpan();
        const foamPts = [];
        const N_FOAM = 46;
        for (let i = 0; i < N_FOAM; i++) {
            const u = span.uMin + (span.uMax - span.uMin) * (i / (N_FOAM - 1));
            const rv0 = riverPointAt(u, 0, 'B');
            const rf = riverAt(rv0.x, rv0.z);
            if (!rf) continue;
            const side = seedR() < 0.5 ? -1 : 1;
            const lat = rf.wWater * (0.85 + seedR() * 0.3) * side;
            const p = riverPointAt(u, lat, 'B');
            foamPts.push(p);
        }
        const N = foamPts.length;
        const pos = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            pos[i * 3] = foamPts[i].x; pos[i * 3 + 1] = CONFIG.POND_WATER_LEVEL + 0.03; pos[i * 3 + 2] = foamPts[i].z;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({
            color: 0xffffff, size: 0.5, transparent: true, opacity: 0.3,
            map: makeSoftDotTexture(), depthWrite: false, sizeAttenuation: true,
        });
        const pts = new THREE.Points(geo, mat);
        pts.frustumCulled = false;
        state.scene.add(pts);
        w.riverFoam = pts;
        w.riverFoamTex = mat.map;
        w.riverSpan = span;

        // item 62: drifting debris sprites showing downstream flow direction
        const N_DEB = 16;
        const debris = [];
        for (let i = 0; i < N_DEB; i++) {
            debris.push({ lat: (seedR() * 2 - 1) * 1.4, speed: 0.03 + seedR() * 0.025, phase: seedR() });
        }
        const dpos = new Float32Array(N_DEB * 3);
        for (let i = 0; i < N_DEB; i++) dpos[i * 3 + 1] = -1000;
        const dgeo = new THREE.BufferGeometry();
        dgeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
        const dmat = new THREE.PointsMaterial({
            color: 0x8a6a3a, size: 0.22, transparent: true, opacity: 0.8, depthWrite: false, sizeAttenuation: true,
        });
        const dpts = new THREE.Points(dgeo, dmat);
        dpts.frustumCulled = false;
        state.scene.add(dpts);
        w.riverDebris = dpts;
        w.riverDebrisData = debris;
    }

    // item 67: sun-glint sparkle points over the pond, density scaling with
    // sun intensity (state.sun), flat under overcast
    {
        const seedR = mulberry32(CONFIG.WORLD_SEED ^ 0x5117e5);
        const N = 60;
        const glints = [];
        for (let i = 0; i < N; i++) {
            const ang = seedR() * Math.PI * 2, rad = seedR() * (CONFIG.POND_RADIUS - 0.6);
            glints.push({ x: Math.cos(ang) * rad, z: Math.sin(ang) * rad, phase: seedR(), speed: 0.5 + seedR() * 1.2 });
        }
        const pos = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) pos[i * 3 + 1] = -1000;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({
            color: 0xfff6d8, size: 0.14, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
        });
        const pts = new THREE.Points(geo, mat);
        pts.frustumCulled = false;
        state.scene.add(pts);
        w.sunGlints = pts;
        w.sunGlintData = glints;
    }

    // item 70: ice-over frost overlay, faded in during snowfall
    {
        const geo = new THREE.CircleGeometry(CONFIG.POND_RADIUS + 0.05, 40);
        const mat = new THREE.MeshBasicMaterial({ color: 0xdcedf7, transparent: true, opacity: 0, depthWrite: false });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = CONFIG.POND_WATER_LEVEL + 0.02;
        state.scene.add(mesh);
        w.iceOverlay = mesh;
    }

    // item 77: a slow-rotating swirl sprite at the river's narrowest pinch
    // point along the main course
    {
        const span = w.riverSpan;
        let bestU = null, bestW = Infinity;
        for (let u = span.uMin; u <= span.uMax; u += 1.2) {
            const p = riverPointAt(u, 0, 'B');
            const rf = riverAt(p.x, p.z);
            if (rf && rf.wWater < bestW) { bestW = rf.wWater; bestU = u; }
        }
        if (bestU !== null) {
            const p = riverPointAt(bestU, 0, 'B');
            const tex = makeSwirlTexture();
            const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.28, depthWrite: false });
            const spr = new THREE.Sprite(mat);
            spr.position.set(p.x, CONFIG.POND_WATER_LEVEL + 0.03, p.z);
            const sc = Math.max(1.2, bestW * 1.6);
            spr.scale.set(sc, sc, 1);
            state.scene.add(spr);
            w.vortex = spr;
            w.vortexTex = tex;
        }
    }

    w.lastT = performance.now();
    w.wadeAcc = 0;
    _waterExtras = w;
    if (state.water) {
        state.water.onBeforeRender = (renderer, scene, camera) => updateWaterExtras(camera);
    }
}

function updateWaterExtras(camera) {
    const w = _waterExtras;
    if (!w) return;
    const now = performance.now();
    let dt = (now - w.lastT) / 1000;
    w.lastT = now;
    if (!isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 0.25) dt = 0.25; // guards a long stall (tab hidden, first frame)
    const elapsed = now / 1000;
    const low = state.qualityLevel === 'low';

    if (w.caustics) {
        w.caustics.material.map.offset.x = elapsed * 0.015;
        w.caustics.material.map.offset.y = elapsed * 0.011;
        w.caustics.visible = !low;
    }

    if (w.riverFoam) {
        w.riverFoam.material.opacity = 0.26 + Math.sin(elapsed * 1.6) * 0.08;
    }

    // item 62: debris drifting downstream (u increases -> shows flow direction)
    if (w.riverDebris && w.riverDebrisData && w.riverSpan) {
        const arr = w.riverDebris.geometry.attributes.position.array;
        const span = w.riverSpan;
        const len = span.uMax - span.uMin;
        const debris = w.riverDebrisData;
        for (let i = 0; i < debris.length; i++) {
            const d = debris[i];
            const t = (elapsed * d.speed + d.phase) % 1;
            const u = span.uMin + t * len;
            const p = riverPointAt(u, d.lat, 'B');
            arr[i * 3] = p.x; arr[i * 3 + 1] = CONFIG.POND_WATER_LEVEL + 0.03; arr[i * 3 + 2] = p.z;
        }
        w.riverDebris.geometry.attributes.position.needsUpdate = true;
    }

    // item 67: sun glint — density + twinkle scale with sun intensity, flat
    // (invisible) under overcast/fog
    if (w.sunGlints && w.sunGlintData) {
        const sunI = state.sun ? state.sun.intensity : 0;
        const density = THREE.MathUtils.clamp((sunI - 0.5) / 1.2, 0, 1);
        w.sunGlints.visible = !low && density > 0.02;
        if (w.sunGlints.visible) {
            const arr = w.sunGlints.geometry.attributes.position.array;
            const glints = w.sunGlintData;
            const activeN = Math.floor(glints.length * density);
            for (let i = 0; i < glints.length; i++) {
                const gl = glints[i];
                if (i >= activeN || Math.sin(elapsed * gl.speed * 6 + gl.phase * 30) < 0.55) {
                    arr[i * 3 + 1] = -1000; continue;
                }
                arr[i * 3] = gl.x; arr[i * 3 + 1] = CONFIG.POND_WATER_LEVEL + 0.02; arr[i * 3 + 2] = gl.z;
            }
            w.sunGlints.geometry.attributes.position.needsUpdate = true;
            w.sunGlints.material.opacity = 0.55 + density * 0.35;
        }
    }

    // item 57: zone-tinted water — recolors the Water uniform toward whatever
    // zone the CAMERA currently reads (a per-viewpoint approximation of "per
    // zone it flows through", since the Water plane is one shared surface)
    if (state.water && camera) {
        const zone = zoneAt(camera.position.x, camera.position.z);
        const zr = ((zone.surf0 >> 16) & 255) / 255, zg = ((zone.surf0 >> 8) & 255) / 255, zb = (zone.surf0 & 255) / 255;
        const tr = THREE.MathUtils.lerp(0x1f / 255, zr, 0.16);
        const tg = THREE.MathUtils.lerp(0x7d / 255, zg, 0.16);
        const tb = THREE.MathUtils.lerp(0x8c / 255, zb, 0.16);
        const u = state.water.material.uniforms.waterColor.value;
        const k = Math.min(1, dt * 0.8);
        u.r += (tr - u.r) * k; u.g += (tg - u.g) * k; u.b += (tb - u.b) * k;
    }

    // item 70: ice-over during snowfall
    if (w.iceOverlay) {
        const ws = weatherState();
        const cold = (ws.cur === 'snowfall' ? 1 - ws.t : 0) + (ws.next === 'snowfall' ? ws.t : 0);
        const m = w.iceOverlay.material;
        m.opacity += (cold * 0.55 - m.opacity) * Math.min(1, dt * 0.5);
    }

    // item 59: underwater fog tint when the camera dips below the waterline.
    // Runs during renderFrame() (the very last step of the frame), i.e. AFTER
    // weather.js's own per-frame fog write, so it reads as a same-frame
    // override rather than fighting weather for the color every other frame.
    if (state.scene && state.scene.fog && camera) {
        if (camera.position.y < CONFIG.POND_WATER_LEVEL - 0.1 && isWaterAt(camera.position.x, camera.position.z, -0.1)) {
            state.scene.fog.color.lerp(_underwaterFog, 0.5);
            state.scene.fog.density = Math.max(state.scene.fog.density, 0.15);
        }
    }

    // item 58: a wading ripple trail behind the player through shallow water
    if (state.controls && camera && !state.isPaused) {
        const p = camera.position;
        w.wadeAcc = (w.wadeAcc || 0) + dt;
        if (w.wadeAcc > 0.22 && isWaterAt(p.x, p.z, 0) && !isWaterAt(p.x, p.z, -0.3)) {
            w.wadeAcc = 0;
            spawnWaterRipple(p.x, p.z);
        }
    }

    // item 77: vortex swirl — slow in-plane rotation
    if (w.vortex) {
        w.vortex.material.rotation = elapsed * 0.4;
        w.vortex.visible = !low;
    }
}
const _underwaterFog = new THREE.Color(0x0d3a42);

function makePondGradientTexture() {
    const size = 128;
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(10,40,46,0.85)');    // dark centre (deep)
    grad.addColorStop(0.65, 'rgba(30,90,98,0.35)');
    grad.addColorStop(1, 'rgba(140,190,180,0)');    // fades toward the lighter shallow rim
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(c);
}

function makeCausticsTexture() {
    const size = 96;
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    const img = g.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const n = worldNoise(x * 0.09, y * 0.09, 3, 2.0, 0.55);
            const cell = Math.pow(Math.max(0, n), 3) * 1.6;
            const i = (y * size + x) * 4;
            img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
            img.data[i + 3] = Math.min(255, cell * 255);
        }
    }
    g.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
}

function makeSoftDotTexture() {
    const s = 24;
    const c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(c);
}

function makeSwirlTexture() {
    const s = 64;
    const c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d');
    const cx = s / 2, cy = s / 2;
    for (let a = 0; a < 360; a += 4) {
        const rad = (a / 360) * Math.PI * 2;
        const spiralR = (a / 360) * (s * 0.46);
        const x = cx + Math.cos(rad * 3) * spiralR, y = cy + Math.sin(rad * 3) * spiralR;
        const alpha = 0.5 * (1 - a / 360);
        g.fillStyle = `rgba(220,240,255,${alpha})`;
        g.beginPath(); g.arc(x, y, 2.2, 0, Math.PI * 2); g.fill();
    }
    return new THREE.CanvasTexture(c);
}

export function buildTerrain() {
    const V_STEP = CONFIG.VOXEL_SIZE;
    const geo = new THREE.BoxGeometry(V_STEP, V_STEP, V_STEP);
    state.sharedBoxGeo = geo;
    const interiorGeo = buildInteriorVoxelGeo(V_STEP);
    state.sharedInteriorGeo = interiorGeo;
    const half = CONFIG.ARENA_SIZE / 2;
    const dummy = new THREE.Object3D();
    const tmpColor = new THREE.Color();

    // proportion each massif's snow cap to its actual peak height
    mountSnow = MOUNTAINS.map(mt => getTerrainHeight(mt.x, mt.z) - 4.0);

    // Pre-compute the lava course NOW (idempotent — buildLava() below re-derives
    // the identical seeded polyline) so voxelColor's scorch-gradient/glow-crack
    // read (items 236/237) has course data during the column loop, which runs
    // well before this file's own buildLava() call further down.
    ensureLavaCourse();

    // items 55/78: quality proxy at BUILD time. state.qualityLevel itself is
    // only set later by quality.js's initQuality() (after buildTerrain() in
    // game.js's init sequence), but state.softwareRenderer is set earlier by
    // engine.js's createRenderer() — the same signal quality.js uses to pick
    // the STARTING tier — so it is a reasonable proxy for "start on a weak
    // device" here. Segment count varies the Water plane's tessellation cost;
    // `size` varies the normal-map's tiling (the ripple SCALE, not just
    // distortionScale, which quality.js already tunes live per tier).
    const weakStart = !!state.softwareRenderer;
    const waterSegs = weakStart ? 14 : 32;
    const waterRippleSize = weakStart ? 1.6 : 1.0;

    // 1. Water — three/addons Water covering the WHOLE arena at the shared
    //    waterline. The dry-land floor in heightfield.js guarantees terrain
    //    only dips below it inside the pond bowl and the river channel, so
    //    one reflective plane serves the entire water network.
    const waterGeo = new THREE.PlaneGeometry(CONFIG.ARENA_SIZE + 2, CONFIG.ARENA_SIZE + 2, waterSegs, waterSegs);
    const water = new Water(waterGeo, {
        textureWidth: 1024,
        textureHeight: 1024,
        waterNormals: makeWaterNormals(),
        sunDirection: SUN_DIRECTION.clone(),
        sunColor: 0xffd6a0,
        waterColor: 0x1f7d8c,
        distortionScale: 1.0,
        size: waterRippleSize,
        fog: state.scene.fog !== undefined,
        alpha: 0.84,
    });
    water.rotation.x = -Math.PI / 2;
    water.position.y = CONFIG.POND_WATER_LEVEL;
    state.scene.add(water);
    state.water = water;

    // 1a. Foam ring hugging the shoreline (procedural radial streak texture)
    const foamGeo = new THREE.RingGeometry(CONFIG.POND_RADIUS - 0.55, CONFIG.POND_RADIUS + 0.1, 96, 1);
    const foamMat = new THREE.MeshBasicMaterial({
        map: makeFoamTexture(),
        color: 0xffffff,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
    });
    const foamRing = new THREE.Mesh(foamGeo, foamMat);
    foamRing.rotation.x = -Math.PI / 2;
    foamRing.position.y = CONFIG.POND_WATER_LEVEL + 0.025;
    foamRing.renderOrder = 1; // draw after the (transparent) water plane
    state.scene.add(foamRing);
    state.foamRing = foamRing;

    // 1b. Sandy pond bowl following the terrain depression + submerged aquatic plants
    //     (grid-aligned with the terrain columns so shore seams stay closed)
    const pondInstances = [];
    for (let x = -half; x < half; x += V_STEP) {
        for (let z = -half; z < half; z += V_STEP) {
            const cx = x + V_STEP / 2, cz = z + V_STEP / 2;
            const d = Math.sqrt(cx * cx + cz * cz);
            if (d >= CONFIG.POND_RADIUS) continue;
            const bowlY = getTerrainHeight(cx, cz); // negative inside the bowl
            // sandy bottom block with depth-tinted color (deeper = darker, cooler)
            const sandV = worldNoise(cx * 0.3, cz * 0.3, 2, 2.0, 0.5) * 0.06;
            const deep = Math.min(1, -bowlY / 1.8);
            const sandColor = new THREE.Color(0xd9c89a)
                .lerp(new THREE.Color(0x8a835e), deep * 0.55)
                .offsetHSL(0, 0, sandV).getHex();
            pondInstances.push({ x: cx, y: bowlY - V_STEP / 2, z: cz, sx: 1, sy: 1, sz: 1, color: sandColor, kind: 'sand' });
        }
    }
    // submerged aquatic plants (blocky green tufts rooted on the bowl floor,
    // height clamped so they always stay below the water surface)
    const plantRand = mulberry32(CONFIG.WORLD_SEED ^ 0x51ed);
    for (let i = 0; i < 40; i++) {
        const ang = plantRand() * Math.PI * 2;
        const rad = plantRand() * (CONFIG.POND_RADIUS - 1.5);
        const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
        const bowlY = getTerrainHeight(x, z);
        const maxPh = (CONFIG.POND_WATER_LEVEL - 0.08 - bowlY) / V_STEP; // stay submerged
        const ph = Math.min(0.75 + plantRand() * 1.75, Math.max(0.3, maxPh));
        pondInstances.push({ x, y: bowlY + ph * V_STEP / 2, z, sx: 0.18, sy: ph, sz: 0.18, color: 0x2f7d4f, kind: 'plant' });
    }
    // NOTE: per-instance colors come from setColorAt (instanceColor); the shared box
    // geometry has no 'color' vertex attribute, so vertexColors must stay OFF or the
    // missing attribute reads as (0,0,0) and everything multiplies to black.
    const pondMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.0 });
    const pondMesh = new THREE.InstancedMesh(geo, pondMat, pondInstances.length);
    pondMesh.castShadow = false;
    pondMesh.receiveShadow = true;
    for (let i = 0; i < pondInstances.length; i++) {
        const d = pondInstances[i];
        dummy.position.set(d.x, d.y, d.z);
        dummy.scale.set(d.sx, d.sy, d.sz);
        dummy.updateMatrix();
        pondMesh.setMatrixAt(i, dummy.matrix);
        tmpColor.setHex(d.color);
        pondMesh.setColorAt(i, tmpColor);
    }
    pondMesh.instanceMatrix.needsUpdate = true;
    if (pondMesh.instanceColor) pondMesh.instanceColor.needsUpdate = true;
    state.scene.add(pondMesh);
    state.pondMesh = pondMesh;

    // 2. Organic terrain columns (InstancedMesh, vertex colors, biome strata)
    //    Hidden-voxel culling: each column only stacks deep enough to cover its
    //    exposed flank (lowest neighbor + margin) — buried voxels are never built.
    //    Cheap baked AO: crevice darkening from towering neighbors + depth shade.
    //    Within a retained column, only the TOPMOST voxel needs its top face —
    //    every voxel below it has that face buried against the one above, so
    //    those go in terrainInteriorInstances (side-band geometry, no top face).
    const terrainInstances = [];
    const terrainInteriorInstances = [];
    for (let x = -half; x < half; x += V_STEP) {
        for (let z = -half; z < half; z += V_STEP) {
            const cx = x + V_STEP / 2, cz = z + V_STEP / 2;
            const d = Math.sqrt(cx * cx + cz * cz);
            if (d < CONFIG.POND_RADIUS) continue; // pond is open water
            const surfaceY = getTerrainHeight(cx, cz);
            const hN = getTerrainHeight(cx, cz - V_STEP);
            const hS = getTerrainHeight(cx, cz + V_STEP);
            const hW = getTerrainHeight(cx - V_STEP, cz);
            const hE = getTerrainHeight(cx + V_STEP, cz);
            const floorY = Math.max(-2.0, Math.min(surfaceY, hN, hS, hW, hE) - 0.45);
            // concavity: neighbors rising above this column occlude ambient light
            const occl = Math.max(0, hN - surfaceY) + Math.max(0, hS - surfaceY)
                       + Math.max(0, hW - surfaceY) + Math.max(0, hE - surfaceY);
            const creviceAO = 1 - Math.min(0.30, occl * 0.22);
            // item 103: slope steepness + sun-facing aspect for this column,
            // computed once here (reusing the neighbor heights already sampled
            // above) rather than re-querying getTerrainHeight per voxel inside
            // voxelColor. aspect points toward the downhill/exposed side; a
            // negative dot with SUN_DIRECTION means that side faces away from
            // the sun (the shadow side frost accumulates on).
            const steep = Math.max(Math.abs(hE - hW), Math.abs(hN - hS)) / (V_STEP * 2);
            let aspX = hW - hE, aspZ = hN - hS;
            const aspLen = Math.hypot(aspX, aspZ) || 1;
            aspX /= aspLen; aspZ /= aspLen;
            const sunFacing = aspX * SUN_DIRECTION.x + aspZ * SUN_DIRECTION.z;
            const slope = { steep, sunFacing };
            // zone palette for this whole column (one blend lookup, reused per voxel)
            const m = worldNoise(cx * 0.055 + 37, cz * 0.055 - 11, 3, 2.0, 0.5) * 0.5 + 0.5;
            const zc = computeZoneColors(cx, cz, m);
            // cave floor: columns inside a tunnel passage drop to dark rock (the
            // shell shades them further, but the palette must read moody on its own)
            let caveK = 0;
            if (CAVES.length) {
                const cf = sampleCave(cx, cz);
                if (cf) caveK = 1 - THREE.MathUtils.smoothstep(cf.lat, cf.hw - 0.5, cf.hw + 0.85);
            }
            for (let y = floorY + V_STEP / 2; y <= surfaceY; y += V_STEP) {
                voxelColor(cx, cz, y, surfaceY, zc, slope, tmpColor);
                // depth-based AO: flanks darken the further below the cap they sit
                const depth = surfaceY - y;
                let shade = creviceAO * (1 - Math.min(0.35, Math.max(0, depth - 0.2) * 0.13));
                if (caveK > 0) {
                    // cave floor: pull the zone palette toward cool dark stone,
                    // then sink it — reads as rock underfoot, not shaded lawn
                    tmpColor.r = THREE.MathUtils.lerp(tmpColor.r, 0.10, caveK * 0.85);
                    tmpColor.g = THREE.MathUtils.lerp(tmpColor.g, 0.095, caveK * 0.85);
                    tmpColor.b = THREE.MathUtils.lerp(tmpColor.b, 0.12, caveK * 0.85);
                    shade *= 1 - caveK * 0.45;
                }
                tmpColor.multiplyScalar(shade);
                // bake the shaded color into the instance descriptor so the
                // chunker (culling.js) can distribute it across sector meshes
                const inst = { x: cx, y, z: cz, r: tmpColor.r, g: tmpColor.g, b: tmpColor.b };
                // last iteration of this column's loop (next y would exceed
                // surfaceY) => the one voxel whose top face is actually exposed
                const isTop = y + V_STEP > surfaceY + 1e-6;
                (isTop ? terrainInstances : terrainInteriorInstances).push(inst);
            }
        }
    }
    const terrainMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.0 }); // instance colors via setColorAt
    const applyTerrainInstance = (inst, dm, col) => {
        dm.position.set(inst.x, inst.y, inst.z);
        dm.scale.set(1, 1, 1);
        dm.rotation.set(0, 0, 0);
        col.setRGB(inst.r, inst.g, inst.b);
        return true;
    };
    // Phase 4b (item 343): split the world-spanning terrain into 8x8 sector
    // chunks so three.js frustum culling drops the off-screen sectors. Total
    // instance count is identical (each chunk sized exactly to its members).
    state.terrainChunks = buildChunkedInstances({
        geo, material: terrainMat, instances: terrainInstances, half,
        castShadow: true, receiveShadow: true, name: 'terrain',
        apply: applyTerrainInstance,
    });
    // Buried (non-topmost) column voxels — same material/positions/colors,
    // just the top-face-stripped geometry (see buildInteriorVoxelGeo above).
    state.terrainInteriorChunks = buildChunkedInstances({
        geo: interiorGeo, material: terrainMat, instances: terrainInteriorInstances, half,
        castShadow: true, receiveShadow: true, name: 'terrain-interior',
        apply: applyTerrainInstance,
    });

    // 3. Perimeter stone walls (InstancedMesh, vertex colors)
    const wallInstances = [];
    const addWallVoxel = (x, z) => {
        const h = getTerrainHeight(x, z);
        for (let y = h + V_STEP / 2; y <= h + 2.0; y += V_STEP) {
            wallInstances.push({ x, y, z });
        }
    };
    for (let x = -half; x < half; x += V_STEP) {
        addWallVoxel(x + V_STEP / 2, -half + V_STEP / 2);
        addWallVoxel(x + V_STEP / 2, half - V_STEP / 2);
    }
    for (let z = -half + V_STEP; z < half - V_STEP; z += V_STEP) {
        addWallVoxel(-half + V_STEP / 2, z + V_STEP / 2);
        addWallVoxel(half - V_STEP / 2, z + V_STEP / 2);
    }
    const wallMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0 }); // instance colors via setColorAt
    // Phase 4b: the perimeter wall rings the whole arena, so as one mesh its
    // bounding sphere never frustum-culls — chunk it too, so the ~3 wall runs
    // behind/beside the viewer drop out (the biggest single non-terrain diluter
    // of the drawn-instance cut).
    state.wallChunks = buildChunkedInstances({
        geo, material: wallMat, instances: wallInstances, half,
        castShadow: true, receiveShadow: true, name: 'wall',
        apply: (inst, dm, col) => {
            dm.position.set(inst.x, inst.y, inst.z);
            dm.scale.set(1, 1, 1);
            dm.rotation.set(0, 0, 0);
            // banded stone strata matching the cliff coloring, warmed by sun-facing tint
            const v = worldNoise(inst.x * 2.1 + inst.y * 1.7, inst.z * 2.1, 2, 2.0, 0.5) * 0.05;
            const band = Math.sin(inst.y * 3.2 + worldNoise(inst.x * 0.14, inst.z * 0.14, 2, 2.0, 0.5) * 2.2) * 0.5 + 0.5;
            col.setRGB(
                THREE.MathUtils.lerp(0.40, 0.52, band) + v,
                THREE.MathUtils.lerp(0.38, 0.48, band) + v,
                THREE.MathUtils.lerp(0.38, 0.46, band) + v * 0.8
            );
            return true;
        },
    });

    // 4. Flora & environment details (Phase 4b item 343: sector-chunked so the
    //    world-spanning detail set frustum-culls per sector; DynamicDrawUsage
    //    because the wind sway rewrites animated instances per frame).
    const details = buildFlora(half, V_STEP);
    details.push(...buildGroundDetailProps(half)); // items 65/73/99/112/242
    const detailMat = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.0 }); // instance colors via setColorAt
    state.detailChunks = buildChunkedInstances({
        geo, material: detailMat, instances: details, half, dynamic: true,
        castShadow: true, receiveShadow: true, name: 'flora',
        apply: (d, dm, col) => {
            dm.position.set(d.x, d.y, d.z);
            dm.scale.set(d.sx, d.sy, d.sz);
            dm.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
            col.setHex(d.color);
            return true;
        },
    });
    state.detailInstances = details; // keep for wind animation (global indices)

    // 4b. Precompute wind-animated instance index lists once, so the per-frame
    //     loop never scans static instances (rocks, trunks, pebbles, ...)
    state.windLight = [];   // grass / reeds / cattails / lily pads — always animated
    state.windLeaves = [];  // canopy leaves — skipped on the low quality tier
    for (let i = 0; i < details.length; i++) {
        const k = details[i].kind;
        if (k === 'grass' || k === 'reed' || k === 'cattail' || k === 'lily' || k === 'lilyflower') {
            state.windLight.push(i);
        } else if (k === 'leaf') {
            state.windLeaves.push(i);
        }
    }

    // 5. Voxel clouds (two drifting semi-transparent layers near the horizon)
    buildClouds();

    // 5b. Mountain dressing: waterfall + spring basin pool + magma vent
    buildMountainFeatures();

    // 5c. Lava river winding out of the volcanic vent (+ head pool, embers,
    //     heat shimmer, steam where it meets water)
    buildLava();

    // 6. Points of interest: humanoid statue + distant house roof
    buildPointsOfInterest();

    // 7. Ambient life: fireflies/pollen, falling leaves, distant circling birds
    buildAmbientLife();

    // 7b. Per-zone ambient particles (embers, snow, spores, mist, dust, …)
    buildZoneAmbient();

    // 8. Shared geometry for expanding water-splash ripple rings
    state.rippleGeo = new THREE.RingGeometry(0.6, 0.78, 32);
    state.ripples = [];

    // 8b. Water-surface extras (items 53/54/57/58/59/62/67/69/70/77) — see the
    //     _waterExtras comment above for why this self-schedules its own
    //     per-frame update rather than being wired into game.js's loop.
    buildWaterExtras(half);

    // Obstacle collision radii mapping
    state.obstacles = [];
    for (const t of state.treeList || []) {
        state.obstacles.push({ x: t.x, z: t.z, r: t.r || 0.9 });
    }
    for (const d of details) {
        if (d.kind === 'rock' && d.sx > 0.6) {
            state.obstacles.push({ x: d.x, z: d.z, r: d.sx * 0.8 });
        }
    }

    // 9. Caves — rock shell, dressing, lights & drips. LAST so the wall voxels
    //    it registers as collision obstacles survive the reset above.
    buildCaves();

    // Phase 4b: cache massif silhouette heights for the per-frame occlusion pass.
    primeOcclusion();
}

// Generate a tileable water normals texture procedurally (no external asset).
// Builds a multi-octave ripple height field first, then derives true normals
// from its gradients — far smoother than treating raw noise as normal axes.
function makeWaterNormals() {
    const size = 256;
    // 1) tileable-ish height field: broad swell + fine directional ripples
    const heights = new Float32Array(size * size);
    const TAU = Math.PI * 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            // sample noise on a torus so the texture wraps seamlessly
            const ang1 = (x / size) * TAU, ang2 = (y / size) * TAU;
            const nx = Math.cos(ang1) * 3.2, ny = Math.sin(ang1) * 3.2;
            const nz = Math.cos(ang2) * 3.2, nw = Math.sin(ang2) * 3.2;
            let h = worldNoise(nx + nz, ny + nw, 4, 2.0, 0.55) * 0.7;
            h += worldNoise(nx * 2.6 - nw * 2.6 + 13, ny * 2.6 + nz * 2.6 - 7, 3, 2.0, 0.5) * 0.3;
            // fine wind-driven ripple streaks
            h += Math.sin(ang1 * 6 + ang2 * 2 + worldNoise(nx, nw, 2, 2.0, 0.5) * 4) * 0.08;
            heights[y * size + x] = h;
        }
    }
    // 2) derive normals from height gradients (central differences, wrapped)
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const strength = 1.7; // gentler ripple normals — calm glints, not muddy swirl
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const xm = (x - 1 + size) % size, xp = (x + 1) % size;
            const ym = (y - 1 + size) % size, yp = (y + 1) % size;
            const dx = (heights[y * size + xp] - heights[y * size + xm]) * strength;
            const dy = (heights[yp * size + x] - heights[ym * size + x]) * strength;
            const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
            const i = (y * size + x) * 4;
            img.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
            img.data[i + 1] = (-dy * inv * 0.5 + 0.5) * 255;
            img.data[i + 2] = (inv * 0.5 + 0.5) * 255;
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    state.waterNormalTex = tex; // tracked for disposal
    return tex;
}

// Soft foam texture for the shore ring. RingGeometry uses planar UVs, so the
// foam is painted radially in the unit square: noisy white lace, brightest at
// the outer (shore-touching) edge, fading toward open water.
function makeFoamTexture() {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const innerFrac = (CONFIG.POND_RADIUS - 0.55) / (CONFIG.POND_RADIUS + 0.1); // ring inner/outer ratio
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x / size - 0.5, dy = y / size - 0.5;
            const rr = Math.sqrt(dx * dx + dy * dy) * 2; // 1.0 at the ring's outer edge
            const ang = Math.atan2(dy, dx);
            // seamless angular streaks: sample noise around a circle
            const streak = worldNoise(Math.cos(ang) * 7 + rr * 8, Math.sin(ang) * 7 + 90, 3, 2.0, 0.5) * 0.5 + 0.5;
            // 0 at inner edge -> 1 at outer edge of the ring band
            const t = Math.max(0, Math.min(1, (rr - innerFrac) / (1 - innerFrac)));
            const a = Math.max(0, Math.min(1, Math.pow(t, 1.7) * (0.30 + streak * 0.80)));
            const i = (y * size + x) * 4;
            img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
            img.data[i + 3] = a * 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    state.foamTex = tex; // tracked for disposal
    return tex;
}
