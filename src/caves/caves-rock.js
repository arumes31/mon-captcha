/* ============================================================
   Cave ROCK & material dressing (Phase 2g items 13–24)
   ------------------------------------------------------------
   Non-shell rock detail that gives each cave its geology, pushed
   through the DecorKit into the CULLED per-cave layer:
     flowstone drapes, rimstone floor dams, depth colour banding
     (warm near the mouth -> cold/dark deep), host-zone rock tints
     (alpine limestone / volcanic basalt / desert sandstone),
     wet-look gloss near water, ore veins (copper/iron/gold),
     embedded fossils, soot-blackened ceilings near lava-adjacent
     stretches, glowing fissures, mouth moss fading inward,
     guano / nitre under roosts, water-carved vs jagged floors.

   Deep caves are DARK until Phase 2h adds the lantern, so the
   emissive detail here (fissures, ore glints, nitre) reads now;
   the matte detail (flowstone / rimstone / fossils / moss / guano)
   reads at the lit mouths + under the per-cave point lights, and
   fully once 2h lights the interior — built regardless per brief.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { getGroundY } from '../heightfield.js';
import { perpAt, springY, mouthDist, inPool, pushAux, buildBoxInstances, matteMaterial } from './caves-decor.js';
import { addDeadEndTells, addDepthSilhouette, addFossilLandmark, addHandprint, addChamberArch, addExplorerCamp } from './caves-landmarks.js';

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const COLD = new THREE.Color(0.12, 0.14, 0.21);
const WARM = new THREE.Color(0.32, 0.22, 0.12);
const DAMP = new THREE.Color(0x0f2226);

// Host-zone base rock tone (authored cave-dark; the interior lights lift it).
// items 152/159: crystal/geode themes desaturate + cool-shift so the crystal
// glow reads as the dominant hue; fungal gets a faint warm-green bias — a
// concrete colour-temperature contrast between the two biomes' base rock.
function hostRockTint(zoneId, theme) {
    const base = (() => {
        switch (zoneId) {
            case 'alpine': case 'ice': case 'snow': return new THREE.Color(0.22, 0.23, 0.25); // limestone, pale cool
            case 'volcanic': return new THREE.Color(0.10, 0.09, 0.10);                          // basalt, near-black
            case 'desert': return new THREE.Color(0.25, 0.19, 0.12);                            // sandstone, warm
            case 'jungle': case 'swamp': return new THREE.Color(0.14, 0.16, 0.13);              // damp mossy stone
            default: return new THREE.Color(0.17, 0.16, 0.17);
        }
    })();
    if (theme === 'crystal' || theme === 'geode') {
        const hsl = { h: 0, s: 0, l: 0 }; base.getHSL(hsl);
        base.setHSL(hsl.h, hsl.s * 0.5, hsl.l * 0.92).lerp(new THREE.Color(0x131826), 0.2);
    } else if (theme === 'fungal') {
        base.lerp(new THREE.Color(0x162010), 0.14);
    }
    return base;
}
// items 133: chamber "mood" — deeper (lower-floor) spots read cooler/darker in
// addition to the existing mouth-distance warmth falloff.
function warmthAt(cave, x, z, floorY) {
    let w = Math.max(0, Math.min(1, 1 - mouthDist(cave, x, z) / 12));
    if (floorY != null) w -= Math.max(0, 0.3 - floorY) * 0.3;
    return Math.max(0, Math.min(1, w));
}
// depth colour banding: warm near the mouth, cold + darker deep.
function bandColor(base, warmth) {
    _c.copy(base);
    if (warmth > 0.5) _c.lerp(WARM, (warmth - 0.5) * 0.8);
    else _c.lerp(COLD, (0.5 - warmth) * 0.85);
    return _c.getHex();
}
// items 86/131: a CONTINUOUS wetness 0..1 (proximity to any pool + low, damp
// floor) instead of the old hard boolean, so walls read a genuine gradient
// into dampness rather than an all-or-nothing cutoff.
function wetness(cave, n) {
    let d = Infinity;
    if (cave.pool) d = Math.min(d, Math.hypot(n.x - cave.pool.x, n.z - cave.pool.z) - cave.pool.r);
    if (cave.pools) for (const p of cave.pools) d = Math.min(d, Math.hypot(n.x - p.x, n.z - p.z) - p.r);
    const proxDamp = isFinite(d) ? Math.max(0, 1 - Math.max(0, d) / 5) : 0;
    const floorDamp = Math.max(0, 0.4 - n.floorY) * 2.2;
    return Math.max(0, Math.min(1, Math.max(proxDamp, floorDamp)));
}
// blend a dry rock colour toward a damp tint proportional to wetness (used
// where a voxel stays in the matte bucket but should still read damp-adjacent).
function dampTint(hex, wet01) {
    _c2.setHex(hex).lerp(DAMP, wet01 * 0.45);
    return _c2.getHex();
}

/* ---- 13: flowstone drapes down the walls (wet-gloss near water) ---- */
function addFlowstone(kit, cave, rng, ds, tint) {
    for (const path of cave.paths) {
        for (let i = 1; i < path.length - 1; i++) {
            const n = path[i];
            if (n.belly || n.underwater || rng() > 0.34 * ds) continue;
            const perp = perpAt(path, i);
            const side = rng() < 0.5 ? -1 : 1;
            const wx = n.x + perp.nx * side * (n.hw - 0.05), wz = n.z + perp.nz * side * (n.hw - 0.05);
            const top = springY(n), floorY = getGroundY(n.x, n.z);
            const warmth = warmthAt(cave, n.x, n.z, n.floorY);
            const col = bandColor(tint, warmth);
            const wet01 = wetness(cave, n);           // items 86/131: continuous gradient
            const wet = rng() < wet01 * 0.85;
            const drapeW = 0.5 + rng() * 0.5;
            const steps = Math.max(3, Math.round((top - floorY) / 0.5));
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const y = floorY + (top - floorY) * t;
                const wob = Math.sin(t * 6 + n.x) * 0.13;
                const w = drapeW * (0.65 + 0.55 * (1 - t)); // wider at the bottom = draped sheet
                const x = wx + perp.tx * wob, z = wz + perp.tz * wob;
                if (wet) kit.wet(x, y, z, w, 0.62, 0.34, 0x1b2a2c, 0, rng() * 0.3, 0);
                else kit.rock(x, y, z, w, 0.62, 0.34, dampTint(col, wet01), 0, rng() * 0.3, 0);
            }
        }
    }
}

/* ---- 14: rimstone floor dams (terraced gour ridges in chambers) ---- */
function addRimstone(kit, cave, rng, ds, tint) {
    const main0 = cave.paths[0];
    for (const ch of cave.chambers) {
        if (inPool(cave, ch.x, ch.z, 1.5) || rng() > 0.6 * ds) continue;
        const chNode = main0[ch.i];
        const warmth = warmthAt(cave, ch.x, ch.z, chNode ? chNode.floorY : null);
        const col = bandColor(tint, warmth);
        const rings = 2 + Math.floor(rng() * 2);
        for (let r = 0; r < rings; r++) {
            const rad = 0.9 + r * 0.7;
            const seg = Math.max(6, Math.round(rad * 6));
            const a0 = rng() * Math.PI * 2, arc = Math.PI * (0.8 + rng() * 0.7);
            for (let s = 0; s < seg; s++) {
                const a = a0 + arc * (s / seg);
                const x = ch.x + Math.cos(a) * rad, z = ch.z + Math.sin(a) * rad;
                kit.rock(x, getGroundY(x, z) + 0.13, z, 0.34, 0.26, 0.34, col, 0, a, 0);
            }
        }
    }
}

/* ---- 22 + 24: host-zone tinted floor character (smooth vs jagged) + mouth moss ---- */
function addFloorAndMoss(kit, cave, rng, ds, tint) {
    const main = cave.paths[0];
    for (const path of cave.paths) {
        for (let i = 1; i < path.length - 1; i++) {
            const n = path[i];
            if (n.underwater) continue;
            const perp = perpAt(path, i);
            const warmth = warmthAt(cave, n.x, n.z, n.floorY);
            const wet01 = wetness(cave, n);
            // floor character: water-carved smooth flats near water, jagged chips elsewhere
            if (rng() < 0.4 * ds) {
                const lat = (rng() * 2 - 1) * (n.hw - 0.2);
                const x = n.x + perp.nx * lat, z = n.z + perp.nz * lat;
                const col = bandColor(tint, warmth);
                if (rng() < wet01 * 0.8) kit.wet(x, getGroundY(x, z) + 0.04, z, 0.6, 0.08, 0.6, 0x18292b, 0, rng() * Math.PI, 0);
                else kit.rock(x, getGroundY(x, z) + 0.1, z, 0.3 + rng() * 0.3, 0.2 + rng() * 0.25, 0.3 + rng() * 0.3, dampTint(col, wet01), (rng() - 0.5) * 0.5, rng() * Math.PI, (rng() - 0.5) * 0.5);
            }
        }
    }
    // mouth moss — matte green near each entrance, density fading inward (reads
    // in the daylight lift at the arch, black deep = reinforces the depth read).
    // item 168: density scales by host zone — lush in jungle/swamp, near-absent
    // in desert/volcanic (a bare-rock chip scatter stands in for moss there).
    const MOSS = [0x2f5a2c, 0x3a6b34, 0x274d24];
    const mf = mossFactor(cave.zoneId);
    for (const i of nearMouth(main)) {
        const n = main[i];
        const dens = Math.max(0, 1 - mouthDist(cave, n.x, n.z) / 6);
        if (dens <= 0) continue;
        const perp = perpAt(main, i);
        const count = Math.round((2 + rng() * 3) * dens * ds * Math.max(mf, 0.2));
        for (let k = 0; k < count; k++) {
            const lat = (rng() * 2 - 1) * n.hw;
            const x = n.x + perp.nx * lat, z = n.z + perp.nz * lat;
            const onWall = rng() < 0.45;
            const y = onWall ? n.floorY + 0.3 + rng() * 1.3 : getGroundY(x, z) + 0.06;
            if (mf < 0.25) { kit.rock(x, getGroundY(x, z) + 0.04, z, 0.22 + rng() * 0.2, 0.07, 0.22 + rng() * 0.2, 0x2a2620, 0, rng() * Math.PI, 0); continue; }
            const col = MOSS[Math.floor(rng() * MOSS.length)];
            kit.rock(x, y, z, 0.28 + rng() * 0.28, 0.1, 0.28 + rng() * 0.28, col, 0, rng() * Math.PI, 0);
        }
    }
}
// item 168: moss-suitability multiplier per host zone.
const MOSS_ZONE = { jungle: 1.4, swamp: 1.4, mushroom: 1.3, meadow: 1.0, lakeside: 1.1, alpine: 0.5, ice: 0.3, snow: 0.3, desert: 0.05, volcanic: 0.05 };
function mossFactor(zoneId) { return MOSS_ZONE[zoneId] !== undefined ? MOSS_ZONE[zoneId] : 0.9; }
function nearMouth(main) {
    const out = [];
    for (let i = 0; i < Math.min(3, main.length); i++) out.push(i);
    for (let i = Math.max(0, main.length - 3); i < main.length; i++) if (!out.includes(i)) out.push(i);
    return out.filter(i => i > 0 && i < main.length - 1);
}

/* ---- 21: soot-blackened ceiling near lava-adjacent (volcanic-host) caves ---- */
function addSootCeiling(kit, cave, rng, ds) {
    if (cave.zoneId !== 'volcanic') return;
    for (const path of cave.paths) {
        for (let i = 1; i < path.length - 1; i++) {
            const n = path[i];
            if (n.underwater || rng() > 0.5 * ds) continue;
            const perp = perpAt(path, i);
            const lat = (rng() * 2 - 1) * n.hw * 0.7;
            const sh = n.ceilH * 0.42;
            const vy = n.floorY + sh + (n.ceilH - sh) * Math.sqrt(Math.max(0, 1 - (lat / n.hw) ** 2)) - 0.2;
            const x = n.x + perp.nx * lat, z = n.z + perp.nz * lat;
            kit.rock(x, vy, z, 0.5 + rng() * 0.4, 0.28, 0.5 + rng() * 0.4, 0x080706, (rng() - 0.5) * 0.3, rng() * Math.PI, (rng() - 0.5) * 0.3);
        }
    }
}

/* ---- 130: visible rock-layer STRATA banding inside larger chambers ---- */
function addStrataBanding(kit, cave, rng, ds, tint) {
    const main = cave.paths[0];
    for (const ch of cave.chambers) {
        const n = main[ch.i]; if (!n || n.hw < 2.15 || rng() > 0.75 * ds) continue;
        const bands = 3 + Math.floor(rng() * 3);
        const warmth = warmthAt(cave, ch.x, ch.z, n.floorY);
        for (let b = 0; b < bands; b++) {
            const y = n.floorY + 0.55 + b * ((n.ceilH * 0.55) / bands) + rng() * 0.15;
            const col = bandColor(tint, Math.max(0, Math.min(1, warmth + (rng() - 0.5) * 0.18)));
            const seg = Math.max(8, Math.round(n.hw * 5));
            const a0 = rng() * Math.PI * 2, arc = Math.PI * (0.6 + rng() * 0.9);
            for (let s = 0; s < seg; s++) {
                const a = a0 + arc * (s / seg);
                const rad = n.hw * (0.85 + rng() * 0.15);
                const x = ch.x + Math.cos(a) * rad, z = ch.z + Math.sin(a) * rad;
                kit.rock(x, y, z, 0.4 + rng() * 0.3, 0.14, 0.32, col, 0, a, 0);
            }
        }
    }
}

/* ---- 134: narrow-passage compression cues — short converging groove marks
   flanking a squeeze so `CAVE_MIN_NAV_HW` reads visually tight ---- */
function addSqueezeCues(kit, cave, rng, ds) {
    const tight = CONFIG.CAVE_MIN_NAV_HW + 0.3;
    for (const path of cave.paths) {
        for (let i = 1; i < path.length - 1; i++) {
            const n = path[i];
            if (n.underwater || n.hw > tight || rng() > 0.55 * ds) continue;
            const perp = perpAt(path, i);
            for (const side of [-1, 1]) {
                const cnt = 1 + Math.floor(rng() * 2);
                for (let k = 0; k < cnt; k++) {
                    const along = (rng() - 0.5) * 0.6;
                    const x = n.x + perp.tx * along + perp.nx * side * (n.hw - 0.08);
                    const z = n.z + perp.tz * along + perp.nz * side * (n.hw - 0.08);
                    const y = n.floorY + 0.5 + rng() * 1.0;
                    const ang = Math.atan2(perp.nz, perp.nx) + side * 0.35;
                    kit.rock(x, y, z, 0.5, 0.06, 0.14, 0x0c0b0d, 0, ang, 0);
                }
            }
        }
    }
}

/* ---- 142: tool-mark / claw-mark wall detail near tunnel-classed passages ---- */
function addClawMarks(kit, cave, rng, ds) {
    for (const path of cave.paths) {
        for (let i = 1; i < path.length - 1; i++) {
            const n = path[i];
            if (n.underwater || n.hw > CONFIG.CAVE_TUNNEL_MAX_HW || rng() > 0.2 * ds) continue;
            const perp = perpAt(path, i), side = rng() < 0.5 ? -1 : 1;
            const x = n.x + perp.nx * side * (n.hw - 0.06), z = n.z + perp.nz * side * (n.hw - 0.06);
            const y = n.floorY + 0.6 + rng() * 1.0;
            const claws = 3 + Math.floor(rng() * 2);
            for (let c = 0; c < claws; c++) {
                const off = (c - (claws - 1) / 2) * 0.12;
                kit.rock(x + perp.tx * off, y + off * 0.4, z + perp.tz * off, 0.03, 0.4 + rng() * 0.3, 0.05, 0x0a0a0c, 0, Math.atan2(perp.nz, perp.nx), 0.25);
            }
        }
    }
}

/* ---- 143: chromatic tint bleed onto rock near glowing chamber features so
   light bleed feels physically grounded (uses the cave's own accent hue). ---- */
function addGlowBleed(kit, cave, rng, ds) {
    if (!cave._glow) return;
    const main = cave.paths[0];
    const bleed = new THREE.Color(cave._glow);
    for (const ch of cave.chambers) {
        const n = main[ch.i]; if (!n || rng() > 0.55 * ds) continue;
        const cnt = 4 + Math.floor(rng() * 4);
        for (let k = 0; k < cnt; k++) {
            const a = rng() * Math.PI * 2, rr = n.hw * (0.5 + rng() * 0.5);
            const x = ch.x + Math.cos(a) * rr, z = ch.z + Math.sin(a) * rr;
            const y = n.floorY + 0.3 + rng() * (n.ceilH * 0.5);
            _c2.setHex(0x131215).lerp(bleed, 0.12 + rng() * 0.16);
            kit.rock(x, y, z, 0.3 + rng() * 0.25, 0.22, 0.26, _c2.getHex(), 0, rng() * Math.PI, 0);
        }
    }
}

/* ---- 17–20 + 138: ore veins (one seeded mineral per cave, glowing); the
   mineral POOL itself varies by theme so crystal/geode caves lean toward
   cool silver/platinum veins instead of the warm copper/iron/gold trio. ---- */
const MINERALS = [
    { c: 0x39c47a, spark: 0x8fffc4 }, // copper-green patina
    { c: 0xcf5a2e, spark: 0xff9a5a }, // iron-red
    { c: 0xf2c04a, spark: 0xfff0a0 }, // gold
];
const MINERALS_COOL = [
    { c: 0x9fc4ff, spark: 0xd8ecff }, // silver-blue
    { c: 0xd7bfff, spark: 0xf0e0ff }, // platinum-violet
];
export function addOreVeins(kit, cave, ctx) {
    const { rng, profile, theme } = ctx, ds = profile.densityScale;
    const pool = (theme === 'crystal' || theme === 'geode') ? MINERALS_COOL : MINERALS;
    const min = pool[Math.floor(rng() * pool.length)];
    for (const path of cave.paths) {
        for (let i = 1; i < path.length - 1; i++) {
            const n = path[i];
            if (n.underwater || rng() > 0.42 * ds) continue;
            const perp = perpAt(path, i);
            const side = rng() < 0.5 ? -1 : 1;
            let lat = (n.hw - 0.08) * side, y = n.floorY + 0.4 + rng() * 1.1;
            const run = 3 + Math.floor(rng() * 4);
            for (let s = 0; s < run; s++) {
                const x = n.x + perp.nx * lat + perp.tx * (s * 0.35), z = n.z + perp.nz * lat + perp.tz * (s * 0.35);
                kit.emit(min.c, x, y, z, 0.16, 0.15 + rng() * 0.12, 0.16, rng() * 0.4, rng() * Math.PI, rng() * 0.4);
                y += (rng() - 0.28) * 0.35; lat += (rng() - 0.5) * 0.12;
            }
        }
    }
    return min;
}

/* ---- 17b: embedded fossils (pale ammonite spiral in a wall) ---- */
export function addFossils(kit, cave, ctx) {
    const { rng } = ctx;
    const main = cave.paths[0];
    const n = 1 + Math.floor(rng() * 2);
    for (let f = 0; f < n; f++) {
        const i = 1 + Math.floor(rng() * (main.length - 2));
        const nd = main[i]; if (nd.underwater || nd.belly) continue;
        const perp = perpAt(main, i); const side = rng() < 0.5 ? -1 : 1;
        const cx = nd.x + perp.nx * (nd.hw - 0.05) * side, cz = nd.z + perp.nz * (nd.hw - 0.05) * side;
        const cy = nd.floorY + 1.0 + rng() * 1.0;
        const seg = 12, turns = 2.2;
        for (let s = 0; s < seg; s++) {
            const t = s / seg, ang = t * turns * Math.PI * 2, rad = 0.5 * (1 - t * 0.7);
            const off = Math.cos(ang) * rad, yy = cy + Math.sin(ang) * rad;
            const x = cx + perp.tx * off, z = cz + perp.tz * off;
            kit.rock(x, yy, z, 0.15, 0.15, 0.11, 0xb8ab8c, 0, 0, ang);
        }
    }
}

/* ---- 23: glowing fissures (emissive cracks across chamber floors) ---- */
export function addFissures(kit, cave, ctx, color = 0xff6a2a) {
    const { rng } = ctx;
    for (const ch of cave.chambers) {
        if (inPool(cave, ch.x, ch.z, 1.0) || rng() > 0.7) continue;
        const a = rng() * Math.PI * 2, len = 1.6 + rng() * 2.2, seg = Math.round(len / 0.3);
        let dev = 0;
        for (let s = 0; s < seg; s++) {
            dev += (rng() - 0.5) * 0.4;
            const along = (s / seg - 0.5) * len;
            const px = ch.x + Math.cos(a) * along + Math.cos(a + 1.57) * dev * 0.3;
            const pz = ch.z + Math.sin(a) * along + Math.sin(a + 1.57) * dev * 0.3;
            kit.emit(color, px, getGroundY(px, pz) + 0.05, pz, 0.14, 0.07, 0.14, 0, a, 0);
        }
    }
}

/* ---- 16: wet-look gloss around water ---- */
export function addWetGloss(kit, cave, ctx) {
    const { rng } = ctx;
    const p = cave.pool; if (!p) return;
    const n = 9 + Math.floor(rng() * 6);
    for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2, r = p.r + 0.2 + rng() * 1.3;
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        kit.wet(x, getGroundY(x, z) + 0.03, z, 0.42 + rng() * 0.4, 0.08, 0.42 + rng() * 0.4, 0x14333a, 0, rng() * Math.PI, 0);
    }
}

/* ---- guano / nitre under roosts (bat theme) ---- */
export function addGuano(kit, cave, ctx) {
    const { rng, profile } = ctx, ds = profile.densityScale;
    const main = cave.paths[0];
    const spots = cave.chambers.map(c => ({ x: c.x, z: c.z }));
    for (let i = 2; i < main.length - 2; i += 3) spots.push({ x: main[i].x, z: main[i].z });
    for (const sp of spots) {
        if (rng() > 0.75 * ds) continue;
        const n = 5 + Math.floor(rng() * 6);
        for (let i = 0; i < n; i++) {
            const a = rng() * Math.PI * 2, r = rng() * 1.4;
            const x = sp.x + Math.cos(a) * r, z = sp.z + Math.sin(a) * r;
            const col = rng() < 0.5 ? 0x241f18 : 0x6b6152; // droppings + pale nitre crust
            kit.rock(x, getGroundY(x, z) + 0.05, z, 0.34 + rng() * 0.34, 0.08, 0.34 + rng() * 0.34, col, 0, rng() * Math.PI, 0);
        }
        if (rng() < 0.5) kit.emit(0x9fb0c0, sp.x, getGroundY(sp.x, sp.z) + 2.1, sp.z, 0.12, 0.12, 0.12, 0, 0, 0);
    }
}

/* ---- 172: theme-consistent floor LITTER — bones near predator roosts (bat),
   shells near water features (flooded) — for at-a-glance readability. ---- */
export function addFloorLitter(kit, cave, ctx, kind) {
    const { rng, profile } = ctx, ds = profile.densityScale;
    if (kind === 'bones') {
        for (const ch of cave.chambers) {
            if (rng() > 0.6 * ds) continue;
            const n = 2 + Math.floor(rng() * 3);
            for (let i = 0; i < n; i++) {
                const a = rng() * Math.PI * 2, r = rng() * 1.3;
                const x = ch.x + Math.cos(a) * r, z = ch.z + Math.sin(a) * r;
                kit.rock(x, getGroundY(x, z) + 0.04, z, 0.3 + rng() * 0.25, 0.05, 0.09, 0xcfc7b0, 0, a, 0);
            }
        }
    } else if (kind === 'shells') {
        const p = cave.pool; if (!p) return;
        const n = 5 + Math.floor(rng() * 5);
        for (let i = 0; i < n; i++) {
            const a = rng() * Math.PI * 2, r = p.r + 0.15 + rng() * 0.9;
            const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
            kit.rock(x, getGroundY(x, z) + 0.03, z, 0.12 + rng() * 0.08, 0.06, 0.12 + rng() * 0.08, 0xd8cdb8, rng() * 0.5, rng() * Math.PI, rng() * 0.5);
        }
    }
}

/* ---- base rock pass applied to EVERY theme ---- */
export function dressRockBase(kit, cave, ctx) {
    const { rng, profile } = ctx, ds = profile.densityScale;
    const tint = hostRockTint(cave.zoneId, ctx.theme);          // items 152/159
    addFlowstone(kit, cave, rng, ds, tint);
    addRimstone(kit, cave, rng, ds, tint);
    addFloorAndMoss(kit, cave, rng, ds, tint);                  // items 86/131/168
    addSootCeiling(kit, cave, rng, ds);
    addStrataBanding(kit, cave, rng, ds, tint);                 // item 130
    addSqueezeCues(kit, cave, rng, ds);                         // item 134
    addClawMarks(kit, cave, rng, ds);                           // item 142
    addGlowBleed(kit, cave, rng, ds);                           // item 143
    // one-off landmarks (all rare/gated internally, aux-culled with the cave)
    addDeadEndTells(kit.rec, cave, ctx);                        // item 139
    addDepthSilhouette(kit.rec, cave, ctx);                     // item 174
    addFossilLandmark(kit.rec, cave, ctx);                      // item 144
    addHandprint(kit.rec, cave, ctx);                           // item 176
    addChamberArch(kit.rec, cave, ctx);                         // item 135
    addExplorerCamp(kit.rec, cave, ctx);                        // item 166
}
