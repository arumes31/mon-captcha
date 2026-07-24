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
import { getGroundY } from '../heightfield.js';
import { perpAt, springY, mouthDist, inPool } from './caves-decor.js';

const _c = new THREE.Color();
const COLD = new THREE.Color(0.12, 0.14, 0.21);
const WARM = new THREE.Color(0.32, 0.22, 0.12);

// Host-zone base rock tone (authored cave-dark; the interior lights lift it).
function hostRockTint(zoneId) {
    switch (zoneId) {
        case 'alpine': case 'ice': case 'snow': return new THREE.Color(0.22, 0.23, 0.25); // limestone, pale cool
        case 'volcanic': return new THREE.Color(0.10, 0.09, 0.10);                          // basalt, near-black
        case 'desert': return new THREE.Color(0.25, 0.19, 0.12);                            // sandstone, warm
        case 'jungle': case 'swamp': return new THREE.Color(0.14, 0.16, 0.13);              // damp mossy stone
        default: return new THREE.Color(0.17, 0.16, 0.17);
    }
}
function warmthAt(cave, x, z) { return Math.max(0, Math.min(1, 1 - mouthDist(cave, x, z) / 12)); }
// depth colour banding: warm near the mouth, cold + darker deep.
function bandColor(base, warmth) {
    _c.copy(base);
    if (warmth > 0.5) _c.lerp(WARM, (warmth - 0.5) * 0.8);
    else _c.lerp(COLD, (0.5 - warmth) * 0.85);
    return _c.getHex();
}
function nearWater(cave, n) {
    if (cave.pool && Math.hypot(n.x - cave.pool.x, n.z - cave.pool.z) < cave.pool.r + 3) return true;
    return n.floorY < 0.4; // deep damp floor
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
            const warmth = warmthAt(cave, n.x, n.z);
            const col = bandColor(tint, warmth);
            const wet = nearWater(cave, n) && rng() < 0.6;
            const drapeW = 0.5 + rng() * 0.5;
            const steps = Math.max(3, Math.round((top - floorY) / 0.5));
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const y = floorY + (top - floorY) * t;
                const wob = Math.sin(t * 6 + n.x) * 0.13;
                const w = drapeW * (0.65 + 0.55 * (1 - t)); // wider at the bottom = draped sheet
                const x = wx + perp.tx * wob, z = wz + perp.tz * wob;
                if (wet) kit.wet(x, y, z, w, 0.62, 0.34, 0x1b2a2c, 0, rng() * 0.3, 0);
                else kit.rock(x, y, z, w, 0.62, 0.34, col, 0, rng() * 0.3, 0);
            }
        }
    }
}

/* ---- 14: rimstone floor dams (terraced gour ridges in chambers) ---- */
function addRimstone(kit, cave, rng, ds, tint) {
    for (const ch of cave.chambers) {
        if (inPool(cave, ch.x, ch.z, 1.5) || rng() > 0.6 * ds) continue;
        const warmth = warmthAt(cave, ch.x, ch.z);
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
            const warmth = warmthAt(cave, n.x, n.z);
            // floor character: water-carved smooth flats near water, jagged chips elsewhere
            if (rng() < 0.4 * ds) {
                const lat = (rng() * 2 - 1) * (n.hw - 0.2);
                const x = n.x + perp.nx * lat, z = n.z + perp.nz * lat;
                const col = bandColor(tint, warmth);
                if (nearWater(cave, n)) kit.wet(x, getGroundY(x, z) + 0.04, z, 0.6, 0.08, 0.6, 0x18292b, 0, rng() * Math.PI, 0);
                else kit.rock(x, getGroundY(x, z) + 0.1, z, 0.3 + rng() * 0.3, 0.2 + rng() * 0.25, 0.3 + rng() * 0.3, col, (rng() - 0.5) * 0.5, rng() * Math.PI, (rng() - 0.5) * 0.5);
            }
        }
    }
    // mouth moss — matte green near each entrance, density fading inward (reads
    // in the daylight lift at the arch, black deep = reinforces the depth read)
    const MOSS = [0x2f5a2c, 0x3a6b34, 0x274d24];
    for (const i of nearMouth(main)) {
        const n = main[i];
        const dens = Math.max(0, 1 - mouthDist(cave, n.x, n.z) / 6);
        if (dens <= 0) continue;
        const perp = perpAt(main, i);
        const count = Math.round((2 + rng() * 3) * dens * ds);
        for (let k = 0; k < count; k++) {
            const lat = (rng() * 2 - 1) * n.hw;
            const x = n.x + perp.nx * lat, z = n.z + perp.nz * lat;
            const onWall = rng() < 0.45;
            const y = onWall ? n.floorY + 0.3 + rng() * 1.3 : getGroundY(x, z) + 0.06;
            const col = MOSS[Math.floor(rng() * MOSS.length)];
            kit.rock(x, y, z, 0.28 + rng() * 0.28, 0.1, 0.28 + rng() * 0.28, col, 0, rng() * Math.PI, 0);
        }
    }
}
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

/* ---- 17–20: ore veins (one seeded mineral per cave, glowing) ---- */
const MINERALS = [
    { c: 0x39c47a, spark: 0x8fffc4 }, // copper-green patina
    { c: 0xcf5a2e, spark: 0xff9a5a }, // iron-red
    { c: 0xf2c04a, spark: 0xfff0a0 }, // gold
];
export function addOreVeins(kit, cave, ctx) {
    const { rng, profile } = ctx, ds = profile.densityScale;
    const min = MINERALS[Math.floor(rng() * MINERALS.length)];
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

/* ---- base rock pass applied to EVERY theme ---- */
export function dressRockBase(kit, cave, ctx) {
    const { rng, profile } = ctx, ds = profile.densityScale;
    const tint = hostRockTint(cave.zoneId);
    addFlowstone(kit, cave, rng, ds, tint);
    addRimstone(kit, cave, rng, ds, tint);
    addFloorAndMoss(kit, cave, rng, ds, tint);
    addSootCeiling(kit, cave, rng, ds);
}
