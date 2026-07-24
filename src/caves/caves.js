/* ============================================================
   Caves — organic tunnel shell, dressing, lighting, pool & drips
   ------------------------------------------------------------
   The world is a heightfield, so caves are FLOOR-OVERRIDE tunnels
   (caves-data.js lays out the winding centrelines; heightfield.js
   carves the floor and answers the field queries). This module
   renders everything above the carved floor:
     - the rock SHELL, marched along each tunnel centreline as a
       series of arched CROSS-SECTIONS (near-vertical lower walls
       rising into an irregular vaulted ceiling). Every voxel is
       jittered in position + scale + colour (strata banding, damp
       darkening low, daylight lift near the mouths) so no surface
       reads flat. Dead-end pockets are capped; the two open tube
       ends are the natural arch entrances, ringed with rubble.
     - dressing: stalagmites/stalactites of varied length growing
       from the irregular surfaces, emissive crystal clusters in the
       chambers (bloom catches them), glow mushrooms, drip motes.
     - a dim warm point light (+ a glow-tinted accent) per cave, no
       shadows, so the chamber reads lit-but-moody on the shadow
       budget it already has (the shell casts the sun shadow).
     - the WET cave's underground POOL: a luminous teal surface with
       waterline crystals and ripple-making drips.

   Phase 2e FOUNDATION layered on top of the above:
     - THEME (item 98): each cave carries a seeded `theme`; its accent
       hue + (later) decoration come from a registered THEME PACK via
       caves-registry.js — the seam Phases 2f–2l plug into.
     - CULL / LOD (items 97, 99): the interior CONTENTS (glow crystals,
       pool, drips, interior lights, per-frame anim) are gated on the
       player being near/inside a cave, in three distance BANDS
       (near / mid / far). The rock SHELL + entrance rubble stay always
       visible — they are the landmarks. Far caves cost ~nothing.
     - QUALITY-TIER density (item 100): caveTierProfile scales prop /
       light / drip counts by quality (low sparse, high rich).
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { mulberry32, worldNoise } from '../random.js';
import { getGroundY, CAVES } from '../heightfield.js';
import { spawnWaterRipple, spawnParticleBurst } from '../particles.js';
import { getCaveThemeDescriptor, caveTierProfile, zoneGlowHue } from './caves-registry.js';
import { themeBuildLog, resetThemeBuildLog } from './caves-themes.js'; // installs the 6 theme packs (side effect)
import { buildTopoRock, buildTopoWater } from './caves-features.js'; // Phase 2f topology dressing
import { buildCaveAtmos, disposeCaveAtmos } from './caves-atmos.js'; // Phase 2h eye/haze/dust/drafts
import { buildCaveLight, disposeCaveLight } from './caves-light.js'; // Phase 2h lantern/god-rays/fill
import { buildCaveWater, updateCaveWater, disposeCaveWater } from './caves-water.js'; // Phase 2i pools/stream/waterfall/mist
import { buildCaveWaterFx, updateCaveWaterFx, disposeCaveWaterFx } from './caves-water-fx.js'; // items 81/82/87/89/90/91
import { dripLandingSplash } from './caves-audio.js'; // item 79: audio-visual sync on real drip landings

const V = CONFIG.VOXEL_SIZE;
const lerp = THREE.MathUtils.lerp;

// Distance BANDS (item 97/99), added to each cave's own radius. Hysteresis
// (enter < exit) stops a cave flapping on/off when the player lingers at a
// threshold. near = full detail; mid = lit but drips dropped; far = culled.
const NEAR_IN = 14, NEAR_OUT = 18, MID_IN = 26, MID_OUT = 30;
function bandFor(d, R, prev) {
    const ni = R + NEAR_IN, no = R + NEAR_OUT, mo = R + MID_OUT, mi = R + MID_IN;
    if (prev === 'near') return d <= no ? 'near' : (d <= mo ? 'mid' : 'far');
    if (prev === 'mid') return d < ni ? 'near' : (d <= mo ? 'mid' : 'far');
    return d < ni ? 'near' : (d < mi ? 'mid' : 'far'); // far / unset
}

/* ------------------------------------------------------------
   Build — called from buildTerrain.
   ------------------------------------------------------------ */
export function buildCaves() {
    if (!CAVES.length) return;
    resetThemeBuildLog();
    const profile = caveTierProfile(state.qualityLevel);
    const dummy = new THREE.Object3D();
    const tmp = new THREE.Color();

    const rock = [];                      // shared dark rock (shell + spikes + rubble) — always-on landmark layer
    const glowByCave = CAVES.map(() => []);
    const drips = [];
    state.caveGlowMeshes = [];
    state.caveRender = [];                // per-cave cull/LOD records

    for (let ci = 0; ci < CAVES.length; ci++) {
        const c = CAVES[ci];
        const rng = mulberry32(((CONFIG.WORLD_SEED ^ 0xcafe) + ci * 0x9e37) >>> 0);
        const desc = getCaveThemeDescriptor(c.theme);
        // accent hue via the theme (stub keeps the Phase 2b look: flooded=teal,
        // the rest = host-zone hue); falls back if a theme has no glowHue.
        c._glow = (desc.glowHue && desc.glowHue(c)) || (c.wet ? 0x3fe0d0 : zoneGlowHue(c.zoneId));
        const rec = makeRecord(ci, c, desc);
        state.caveRender.push(rec);
        for (const path of c.paths) buildTube(c, path, rock, rng);
        buildRubble(c, rock, rng);
        buildDressing(c, rock, glowByCave[ci], drips, profile, rng, ci);
        buildTopoRock(c, rock, rng);          // Phase 2f: choke/talus/fallen/collar/arch
        buildTopoWater(c, rec);               // Phase 2f: under-river water sheet (culled via rec.aux)
        if (c.wet) {
            buildCaveWater(c, glowByCave[ci], drips, profile, rng, ci, rec, getGroundY); // Phase 2i
            buildCaveWaterFx(c, rec, rng, getGroundY);                                    // items 81/82/87/90/91
        }
        addLights(c, profile, rec);
        runThemeHooks(desc, rec, profile, rng, rock, glowByCave[ci], drips);
    }

    buildRockMesh(dummy, tmp, rock);
    for (let ci = 0; ci < CAVES.length; ci++) buildGlowMesh(dummy, tmp, CAVES[ci], glowByCave[ci], state.caveRender[ci]);
    if (profile.drips && drips.length) buildDrips(drips);
    // Phase 2h: atmosphere first (eye/haze/dust/drafts/glints), then lighting
    // (lantern/god-rays/fill/luring). Both hang detail on the culled rec.aux /
    // rec.lights layer, so the initial cull pass below sizes them correctly.
    buildCaveAtmos();
    buildCaveLight();
    updateCaves(0, 0); // set initial bands so caves away from spawn start culled
}

// Per-cave cull/LOD record: a proximity centre + radius, the current band, and
// handles to everything the culler toggles (glow mesh, interior lights, pool).
function makeRecord(ci, c, desc) {
    let cx = 0, cz = 0, cnt = 0;
    for (const path of c.paths) for (const n of path) { cx += n.x; cz += n.z; cnt++; }
    cx /= cnt || 1; cz /= cnt || 1;
    let radius = 0;
    for (const path of c.paths) for (const n of path) {
        const dd = Math.hypot(n.x - cx, n.z - cz) + n.hw;
        if (dd > radius) radius = dd;
    }
    return { ci, cave: c, desc, cx, cz, radius, band: 'far', prevBand: null, glowMesh: null, lights: [], pool: null, aux: [] };
}

// Theme decoration seam (item 98). In 2e the packs are no-op stubs; a later
// phase's decorate/lights/particles push straight into the culled per-cave
// layer via this context, so its detail is LOD'd + culled for free.
function runThemeHooks(desc, rec, profile, rng, rock, glow, drips) {
    themeBuildLog.byCave.push({ ci: rec.ci, theme: desc.theme });
    const ctx = {
        cave: rec.cave, ci: rec.ci, theme: desc.theme, rng, profile, low: profile.tier === 'low',
        rock, glow, drips,
        helpers: { getGroundY, addSpike, addCrystalCluster, addGlowMushroom, perpOf, THREE },
    };
    if (desc.decorate) { try { desc.decorate(ctx); } catch (e) {} }
    if (desc.particles) { try { desc.particles(ctx); } catch (e) {} }
    if (desc.lights) {
        ctx.addLight = (color, intensity, dist, x, y, z, flick) => {
            const pl = new THREE.PointLight(color, intensity, dist, 2);
            pl.position.set(x, y, z); pl.castShadow = false;
            state.scene.add(pl);
            rec.lights.push({ light: pl, base: intensity, flick: flick || (1 + Math.random()) });
            return pl;
        };
        try { desc.lights(ctx); } catch (e) {}
    }
}

/* ------------------------------------------------------------
   Rock shell — march the centreline, build arched cross-sections.
   ------------------------------------------------------------ */
function pushShell(rock, x, y, z, floorY, dayK, rng, oversize, jitterMul = 1) {
    const jx = (rng() - 0.5) * 0.22 * jitterMul, jy = (rng() - 0.5) * 0.24 * jitterMul, jz = (rng() - 0.5) * 0.22 * jitterMul;
    const s = oversize * (0.85 + rng() * 0.45);
    // strata banding + damp darkening low + warm daylight lift near the mouth
    const strata = 0.5 + 0.5 * Math.sin(y * 2.3 + worldNoise(x * 0.3, z * 0.3, 2, 2, 0.5) * 3);
    const base = 0.095 + strata * 0.06 + (rng() - 0.5) * 0.03;
    const damp = 1 - Math.min(0.42, Math.max(0, 0.6 - (y - floorY)) * 0.55);
    let r = base * damp, g = base * 0.93 * damp, b = base * 1.14 * damp;
    // faint warm weathering near the mouths — authored VERY dark, because the
    // golden-hour rig + ACES lifts exterior mid-tones hard (Phase 2 lesson)
    if (dayK > 0) { r = lerp(r, 0.185, dayK * 0.55); g = lerp(g, 0.155, dayK * 0.5); b = lerp(b, 0.125, dayK * 0.45); }
    rock.push({
        x: x + jx, y: y + jy, z: z + jz, sx: s, sy: s, sz: s,
        color: new THREE.Color(r, g, b).getHex(),
        rx: (rng() - 0.5) * 0.3 * jitterMul, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.3 * jitterMul,
    });
    if (rng() < 0.1) { // occasional protruding nub — breaks the surface up
        rock.push({
            x: x + jx * 1.6, y: y + jy * 1.4, z: z + jz * 1.6, sx: 0.5, sy: 0.5, sz: 0.5,
            color: new THREE.Color(r * 0.8, g * 0.8, b * 0.9).getHex(),
            rx: rng(), ry: rng() * Math.PI, rz: rng(),
        });
    }
}

// One arched cross-section perpendicular to the tunnel at (cx,cz).
function crossSection(cx, cz, nx, nz, floorY, hw, ceilH, dayK, rock, rng, capped, underwater) {
    // item 8: under-river nodes have NO rock vault — the river water sheet is the
    // ceiling. Build only the side walls up to just below the water line so the
    // passage reads as an open trench beneath the river.
    // item 136: this is the river-confluence crossing, so the rock reads
    // water-erosion-SMOOTHED here (reduced position/rotation jitter) versus the
    // jagged default elsewhere.
    if (underwater) {
        const capY = CONFIG.POND_WATER_LEVEL - 0.12;
        for (const side of [-1, 1]) {
            const wx = cx + nx * side * hw, wz = cz + nz * side * hw;
            for (let y = floorY + V * 0.5; y <= capY; y += V) pushShell(rock, wx, y, wz, floorY, 0, rng, 1.14, 0.4);
        }
        return;
    }
    const sh = ceilH * 0.42; // springline — vertical walls below, vault above
    // vertical lower walls at ±hw
    for (const side of [-1, 1]) {
        const wx = cx + nx * side * hw, wz = cz + nz * side * hw;
        for (let y = floorY + V * 0.5; y <= floorY + sh; y += V) pushShell(rock, wx, y, wz, floorY, dayK, rng, 1.14);
    }
    // irregular vaulted ceiling from one springtop, over the peak, to the other
    const steps = Math.max(6, Math.round((Math.PI * hw) / (V * 0.7)));
    for (let s = 0; s <= steps; s++) {
        const th = (s / steps) * Math.PI;
        const lat = Math.cos(th) * hw;
        const y = floorY + sh + (ceilH - sh) * Math.sin(th);
        pushShell(rock, cx + nx * lat, y, cz + nz * lat, floorY, dayK, rng, 1.16);
    }
    if (capped) { // fill a dead-end pocket wall
        for (let lat = -hw; lat <= hw; lat += V) {
            const top = floorY + sh + (ceilH - sh) * Math.sqrt(Math.max(0, 1 - (lat / hw) ** 2));
            for (let y = floorY + V * 0.5; y <= top; y += V) pushShell(rock, cx + nx * lat, y, cz + nz * lat, floorY, dayK, rng, 1.14);
        }
    }
}

function entranceDay(cave, x, z) {
    let best = 0;
    for (const e of cave.entrances) best = Math.max(best, 1 - Math.min(1, Math.hypot(x - e.x, z - e.z) / 5));
    return best;
}

function buildTube(cave, path, rock, rng) {
    for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        let tx = b.x - a.x, tz = b.z - a.z;
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        const nx = -tz, nz = tx;
        const sub = Math.max(1, Math.round(tl / 0.7));
        for (let k = 0; k < sub; k++) {
            const t = k / sub;
            const cx = a.x + (b.x - a.x) * t, cz = a.z + (b.z - a.z) * t;
            const floorY = a.floorY + (b.floorY - a.floorY) * t;
            const hw = a.hw + (b.hw - a.hw) * t;
            const ceilH = a.ceilH + (b.ceilH - a.ceilH) * t;
            const underwater = t < 0.5 ? a.underwater : b.underwater;
            crossSection(cx, cz, nx, nz, floorY, hw, ceilH, entranceDay(cave, cx, cz), rock, rng, false, underwater);
        }
    }
    const last = path[path.length - 1];
    if (last.cap) {
        const prev = path[path.length - 2];
        let tx = last.x - prev.x, tz = last.z - prev.z;
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        crossSection(last.x, last.z, -tz, tx, last.floorY, last.hw, last.ceilH, 0, rock, rng, true);
    }
}

// Collapsed rubble boulders framing a mouth — kept OFF the walk-in axis so
// they flank the arch instead of blocking the doorway.
function buildRubble(cave, rock, rng) {
    for (const e of cave.entrances) {
        const axis = Math.atan2(e.dz, e.dx);
        const n = 3 + Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
            const side = rng() < 0.5 ? 1 : -1;
            const a = axis + side * (0.75 + rng() * 1.3); // 43°-117° off-axis
            const r = 1.4 + rng() * 1.7;
            const x = e.x + Math.cos(a) * r, z = e.z + Math.sin(a) * r;
            const s = 0.5 + rng() * 0.9;
            rock.push({
                x, y: getGroundY(x, z) + s * V * 0.4, z,
                sx: s, sy: s * (0.55 + rng() * 0.4), sz: s * (0.7 + rng() * 0.4),
                color: new THREE.Color(0.12 + rng() * 0.05, 0.11, 0.13).getHex(),
                rx: rng() * 0.4, ry: rng() * Math.PI, rz: rng() * 0.4,
            });
        }
    }
}

/* ------------------------------------------------------------
   Dressing.
   ------------------------------------------------------------ */
function perpOf(path, i) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz) || 1;
    return { nx: -tz / l, nz: tx / l };
}

// item 129: per-theme/zone size + tint variance on stalactites/stalagmites.
// Computed once per cave (spikeStyleFor) and threaded through every addSpike
// call in buildDressing so a crystal cave's spires read taller/cooler, a
// volcanic cave's read stubbier/sooty, etc. — beyond the flat grey default.
function spikeStyleFor(cave) {
    let sizeMul = 1, tint = null;
    switch (cave.theme) {
        case 'crystal': case 'geode': sizeMul = 1.18; tint = [0.15, 0.16, 0.2]; break;
        case 'fungal': sizeMul = 0.85; tint = [0.11, 0.14, 0.1]; break;
        case 'bat': sizeMul = 0.92; tint = [0.1, 0.09, 0.085]; break;
        default: break;
    }
    switch (cave.zoneId) {
        case 'ice': case 'snow': case 'alpine': if (!tint) tint = [0.19, 0.2, 0.23]; sizeMul *= 1.08; break;
        case 'volcanic': if (!tint) tint = [0.08, 0.07, 0.07]; sizeMul *= 0.9; break;
        case 'desert': if (!tint) tint = [0.17, 0.14, 0.1]; break;
    }
    return { sizeMul, tint };
}

function addSpike(rock, x, baseY, z, h, up, rng, style) {
    const sizeMul = (style && style.sizeMul) || 1;
    h *= sizeMul;
    const steps = Math.max(2, Math.round(h / (V * 0.7)));
    const tint = style && style.tint;
    for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const w = lerp(0.5, 0.1, t) * (0.9 + sizeMul * 0.1);
        const y = up ? baseY + (s + 0.5) * V * 0.7 : baseY - (s + 0.5) * V * 0.7;
        let r = 0.13 + (rng() - 0.5) * 0.05, g = 0.12, b = 0.15;
        if (tint) { r = lerp(r, tint[0], 0.55); g = lerp(g, tint[1], 0.55); b = lerp(b, tint[2], 0.55); }
        rock.push({
            x, y, z, sx: w, sy: 0.82, sz: w,
            color: new THREE.Color(r, g, b).getHex(),
            rx: (rng() - 0.5) * 0.12, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.12,
        });
    }
}

function addCrystalCluster(glow, x, floorY, z, rng) {
    const shards = 3 + Math.floor(rng() * 3);
    for (let s = 0; s < shards; s++) {
        const ox = (rng() - 0.5) * 0.8, oz = (rng() - 0.5) * 0.8;
        const h = 0.5 + rng() * 1.1;
        glow.push({
            x: x + ox, y: floorY + h * 0.5, z: z + oz,
            sx: 0.15 + rng() * 0.12, sy: h / V, sz: 0.15 + rng() * 0.12,
            rx: (rng() - 0.5) * 0.5, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.5,
            bright: 0.85 + rng() * 0.15,
        });
    }
}

function addGlowMushroom(rock, glow, x, floorY, z, rng) {
    rock.push({ x, y: floorY + 0.18, z, sx: 0.1, sy: 0.34 / V, sz: 0.1, color: 0xdcd2c0, rx: 0, ry: 0, rz: 0 });
    glow.push({ x, y: floorY + 0.38, z, sx: 0.3, sy: 0.14 / V, sz: 0.3, rx: 0, ry: rng() * Math.PI, rz: 0, bright: 0.7 + rng() * 0.2 });
}

function buildDressing(cave, rock, glow, drips, profile, rng, ci) {
    const ds = profile.densityScale; // item 100: prop density scales with the quality tier
    const spikeStyle = spikeStyleFor(cave); // item 129
    const inPool = (x, z) => {
        if (cave.pools) { for (const p of cave.pools) if (Math.hypot(x - p.x, z - p.z) < p.r + 0.5) return true; return false; }
        return cave.pool && Math.hypot(x - cave.pool.x, z - cave.pool.z) < cave.pool.r + 0.5;
    };
    for (const path of cave.paths) {
        for (let i = 1; i < path.length - 1; i++) {
            const n = path[i];
            const perp = perpOf(path, i);
            if (rng() < 0.5 * ds) { // stalagmite
                const lat = (rng() - 0.5) * n.hw * 1.2;
                const x = n.x + perp.nx * lat, z = n.z + perp.nz * lat;
                if (!inPool(x, z)) addSpike(rock, x, getGroundY(x, z), z, 0.5 + rng() * 1.1, true, rng, spikeStyle);
            }
            if (rng() < 0.55 * ds) { // stalactite from the vault
                const lat = (rng() - 0.5) * n.hw;
                const sh = n.ceilH * 0.42;
                const vy = n.floorY + sh + (n.ceilH - sh) * Math.sqrt(Math.max(0, 1 - (lat / n.hw) ** 2));
                addSpike(rock, n.x + perp.nx * lat, vy, n.z + perp.nz * lat, 0.4 + rng() * 1.2, false, rng, spikeStyle);
            }
            if (profile.mushrooms && rng() < 0.28 * ds) { // glow mushroom hugging a wall
                const lat = (rng() < 0.5 ? -1 : 1) * n.hw * (0.65 + rng() * 0.25);
                const x = n.x + perp.nx * lat, z = n.z + perp.nz * lat;
                if (!inPool(x, z)) addGlowMushroom(rock, glow, x, getGroundY(x, z), z, rng);
            }
            if (profile.drips && rng() < 0.28 * ds) { // ceiling drip
                const sh = n.ceilH * 0.42;
                const topY = n.floorY + sh + (n.ceilH - sh) * 0.85 - 0.2;
                const dripFloorY = getGroundY(n.x, n.z) + 0.05;
                drips.push({ ci, x: n.x, z: n.z, topY, floorY: dripFloorY, phase: rng(), speed: 0.35 + rng() * 0.4, pool: false });
                // item 137: a subtle dark stain streak on the ceiling below the drip
                rock.push({ x: n.x, y: topY - 0.14, z: n.z, sx: 0.22, sy: 0.5, sz: 0.14, color: 0x0c0b0a, rx: 0, ry: rng() * Math.PI, rz: 0 });
                // item 175: a dim wet-look gleam on the dry floor beneath the drip —
                // reuses the cave's existing glow-hue layer at low brightness so it's
                // free of any new mesh/material (a hint of sheen, not a pool).
                glow.push({ x: n.x, y: dripFloorY + 0.01, z: n.z, sx: 0.32, sy: 0.05, sz: 0.28, rx: 0, ry: rng() * Math.PI, rz: 0, bright: 0.16 });
            }
        }
    }
    // crystal clusters cluster in the chambers (not on the pool centre)
    for (const ch of cave.chambers) {
        if (inPool(ch.x, ch.z)) continue;
        const nCl = profile.tier === 'low' ? 1 : 2 + Math.floor(rng() * 2);
        for (let c = 0; c < nCl; c++) {
            const a = rng() * Math.PI * 2, r = rng() * 1.2;
            const x = ch.x + Math.cos(a) * r, z = ch.z + Math.sin(a) * r;
            addCrystalCluster(glow, x, getGroundY(x, z), z, rng);
        }
    }
}

/* ------------------------------------------------------------
   Lights (no shadows — the shell already casts the sun shadow).
   ------------------------------------------------------------ */
function addLights(c, profile, rec) {
    // one warm + one glow-tinted accent near the middle of the tunnel. Interior
    // lights are the priciest per-frame cost, so they are tagged to the cave
    // record and switched off entirely when the cave is culled (item 97). Their
    // intensity scales with the quality tier (item 100).
    const m = profile.lightMul;
    const mid = c.paths[0][Math.floor(c.paths[0].length / 2)];
    const y = mid.floorY + 2.1; // up toward the vault so eye-level walls don't blow out
    const warm = new THREE.PointLight(0xffb27a, 7.5 * m, 16, 2);
    warm.position.set(mid.x, y, mid.z); warm.castShadow = false;
    state.scene.add(warm);
    rec.lights.push({ light: warm, base: warm.intensity, flick: 0.6 + Math.random() });
    const accent = new THREE.PointLight(c._glow, 6 * m, 13, 2);
    accent.position.set(mid.x, mid.floorY + 0.7, mid.z); accent.castShadow = false;
    state.scene.add(accent);
    rec.lights.push({ light: accent, base: accent.intensity, flick: 1.3 + Math.random() });
    if (c.wet && c.pool && profile.poolLight) { // extra glow on the primary pool
        const pl = new THREE.PointLight(c.pool.kind === 'hotspring' ? 0xffb27a : 0x3fe0d0, 5, 9, 2);
        pl.position.set(c.pool.x, c.pool.level + 0.9, c.pool.z); pl.castShadow = false;
        state.scene.add(pl);
        rec.lights.push({ light: pl, base: pl.intensity, flick: 1.7 + Math.random() });
    }
}

/* ------------------------------------------------------------
   Mesh assembly.
   ------------------------------------------------------------ */
function buildRockMesh(dummy, tmp, rock) {
    if (!rock.length) return;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.97, metalness: 0.0 });
    const mesh = new THREE.InstancedMesh(state.sharedBoxGeo, mat, rock.length);
    mesh.castShadow = true; mesh.receiveShadow = true;
    for (let i = 0; i < rock.length; i++) {
        const d = rock[i];
        dummy.position.set(d.x, d.y, d.z);
        dummy.scale.set(d.sx, d.sy, d.sz);
        dummy.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        tmp.setHex(d.color); mesh.setColorAt(i, tmp);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    state.scene.add(mesh);
    state.caveRockMesh = mesh;
}

function buildGlowMesh(dummy, tmp, c, glow, rec) {
    if (!glow.length) return;
    const mat = new THREE.MeshStandardMaterial({
        color: c._glow, emissive: c._glow, emissiveIntensity: 1.7, roughness: 0.32, metalness: 0.0,
    });
    const mesh = new THREE.InstancedMesh(state.sharedBoxGeo, mat, glow.length);
    mesh.castShadow = false; mesh.receiveShadow = false;
    for (let i = 0; i < glow.length; i++) {
        const d = glow[i];
        dummy.position.set(d.x, d.y, d.z);
        dummy.scale.set(d.sx, d.sy, d.sz);
        dummy.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        tmp.setHex(c._glow).multiplyScalar(d.bright); mesh.setColorAt(i, tmp);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    state.scene.add(mesh);
    state.caveGlowMeshes.push(mesh);
    if (rec) rec.glowMesh = mesh; // toggled by the culler
}

function makeDripSprite() {
    const size = 24;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(210,240,255,1)');
    grad.addColorStop(0.5, 'rgba(180,220,255,0.5)');
    grad.addColorStop(1, 'rgba(180,220,255,0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    state.caveDripTex = tex;
    return tex;
}

function buildDrips(drips) {
    const n = drips.length;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = drips[i].x; pos[i * 3 + 1] = drips[i].topY; pos[i * 3 + 2] = drips[i].z; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xbfe6ff, size: 0.14, map: makeDripSprite(), transparent: true, opacity: 0.8, depthWrite: false, sizeAttenuation: true });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    state.scene.add(pts);
    state.caveDrips = pts;
    state.caveDripData = drips;
}

/* ------------------------------------------------------------
   Per-frame update — CULLING + DISTANCE LOD (items 97, 99).
   The rock shell is static and always visible; here we only touch
   the per-cave interior CONTENTS (glow crystals, pool, drips,
   lights, theme anim), gated by each cave's distance band. A cave
   the player is nowhere near does zero per-frame work.
   ------------------------------------------------------------ */
export function updateCaves(dt, elapsed) {
    if (!CAVES.length || !state.caveRender) return;
    const cam = state.camera && state.camera.position;
    const records = state.caveRender;
    const pulse = 1.55 + 0.35 * Math.sin(elapsed * 1.3);
    let anyNear = false, active = 0, nNear = 0, nMid = 0, nFar = 0, litLights = 0, totalLights = 0, activeGlow = 0, totalGlow = 0;

    for (const rec of records) {
        const d = cam ? Math.hypot(cam.x - rec.cx, cam.z - rec.cz) : Infinity;
        rec.prevBand = rec.band;
        rec.band = bandFor(d, rec.radius, rec.prevBand);
        const b = rec.band;
        const visible = b !== 'far';
        if (b === 'near') { nNear++; anyNear = true; } else if (b === 'mid') nMid++; else nFar++;
        if (visible) active++;

        if (rec.glowMesh) {
            totalGlow += rec.glowMesh.count;
            rec.glowMesh.visible = visible;
            if (visible) activeGlow += rec.glowMesh.count;
            if (b === 'near') rec.glowMesh.material.emissiveIntensity = pulse; // pulse only at full detail
        }
        if (rec.pool) rec.pool.visible = visible;
        if (rec.aux) for (let a = 0; a < rec.aux.length; a++) rec.aux[a].visible = visible; // water sheets

        for (let i = 0; i < rec.lights.length; i++) {
            const L = rec.lights[i];
            totalLights++;
            if (!visible) { L.light.visible = false; continue; }
            L.light.visible = true; litLights++;
            const dim = b === 'mid' ? 0.6 : 1; // LOD: dimmer in the mid band
            L.light.intensity = L.base * dim * (0.86 + 0.14 * Math.sin(elapsed * L.flick + i));
        }
        if (visible && rec.desc && rec.desc.update) {
            try { rec.desc.update({ cave: rec.cave, ci: rec.ci, band: b, dt, elapsed, near: b === 'near', mid: b === 'mid' }); } catch (e) {}
        }
        // Phase 2i: animate the wet cave's pools / stream / waterfall / mist
        // (only while observed — free when culled).
        if (visible && rec.cave.wet && rec.cave._water) {
            try { updateCaveWater(rec.cave, rec, dt, elapsed, b); } catch (e) {}
        }
        // items 81/82/87/89/90/91: the wet cave's extra water FX (icicles,
        // light shaft, algae, caustics, edge detail, footstep/ball ripples).
        if (visible && rec.cave._waterFx) {
            try { updateCaveWaterFx(rec.cave, rec, dt, elapsed, b); } catch (e) {}
        }
    }

    // Drips are the finest detail (a per-frame geometry write) — LOD drops them
    // outside the NEAR band, and the whole layer hides when no cave is near.
    if (state.caveDrips && state.caveDripData) {
        state.caveDrips.visible = anyNear;
        if (anyNear) {
            const arr = state.caveDrips.geometry.attributes.position.array;
            const list = state.caveDripData;
            let touched = false;
            for (let i = 0; i < list.length; i++) {
                const d = list[i];
                const rec = records[d.ci];
                if (!rec || rec.band !== 'near') continue;
                const t = (elapsed * d.speed + d.phase) % 1;
                arr[i * 3 + 1] = lerp(d.topY, d.floorY, t * t);
                // item 79: a small splash particle + a SOUND-SYNCED ping fired on the
                // exact frame this real drip lands, not just an ambient ripple ring.
                if (d.pool && t < d.lastT && !state.isPaused) {
                    spawnWaterRipple(d.x, d.z, d.floorY - 0.04);
                    spawnParticleBurst(d.x, d.floorY - 0.02, d.z, 0xcfeffa, 3);
                    dripLandingSplash(d.x, d.floorY, d.z);
                }
                d.lastT = t;
                touched = true;
            }
            if (touched) state.caveDrips.geometry.attributes.position.needsUpdate = true;
        }
    }

    state.caveCullStats = { active, near: nNear, mid: nMid, far: nFar, litLights, totalLights, activeGlow, totalGlow };
}

/* ------------------------------------------------------------
   Teardown.
   ------------------------------------------------------------ */
function disposeMesh(mesh) {
    if (!mesh) return;
    if (state.scene) state.scene.remove(mesh);
    if (mesh.geometry && mesh.geometry !== state.sharedBoxGeo) { try { mesh.geometry.dispose(); } catch (e) {} }
    if (mesh.material) { try { mesh.material.dispose(); } catch (e) {} }
}

export function disposeCaves() {
    disposeCaveLight();   // Phase 2h: lantern + shaft/glow textures (aux props freed below)
    disposeCaveAtmos();   // Phase 2h: dust field + atmos textures + caveFx reset
    disposeCaveWater();   // Phase 2i: pool/stream/waterfall/mist textures (aux meshes freed below)
    disposeCaveWaterFx(); // items 81/82/87/89/90/91: shared water-fx textures (aux meshes freed below)
    disposeMesh(state.caveRockMesh); state.caveRockMesh = null;
    if (state.caveGlowMeshes) { for (const m of state.caveGlowMeshes) disposeMesh(m); state.caveGlowMeshes = null; }
    disposeMesh(state.cavePool); state.cavePool = null;
    if (state.caveDrips) { disposeMesh(state.caveDrips); state.caveDrips = null; state.caveDripData = null; }
    if (state.caveDripTex) { try { state.caveDripTex.dispose(); } catch (e) {} state.caveDripTex = null; }
    if (state.caveRender) {
        for (const rec of state.caveRender) {
            for (const L of rec.lights) { if (state.scene) state.scene.remove(L.light); }
            if (rec.aux) for (const m of rec.aux) disposeMesh(m);
            if (rec.desc && rec.desc.dispose) { try { rec.desc.dispose(rec.cave); } catch (e) {} }
        }
        state.caveRender = null;
    }
    state.caveCullStats = null;
}
