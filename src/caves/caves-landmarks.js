/* ============================================================
   Cave LANDMARKS — rare one-off decor & storytelling props
   ------------------------------------------------------------
   Items 135, 139, 144, 166, 174, 176 (backlog sections 8/10). All six
   are small, independently rng-gated additions called once per cave
   from `dressRockBase` (caves-rock.js), so every theme gets them for
   free without per-theme wiring. Everything here is aux/culled with
   the owning cave's cull record — no structural / always-on geometry,
   no new dynamic lights.
   ============================================================ */

import * as THREE from 'three';
import { getGroundY } from '../heightfield.js';
import { pushAux, buildBoxInstances, matteMaterial, emissiveMaterial, perpAt } from './caves-decor.js';
import { caveDeadEnds, caveDeepPoint } from './caves-gameplay.js';

/* ---- 139: visual dead-end TELLS — a debris pile or moss patch at every
   capped branch tip, so players learn to read them at a glance. ---- */
export function addDeadEndTells(rec, cave, ctx) {
    const { rng } = ctx;
    const ends = caveDeadEnds(cave);
    if (!ends.length) return;
    const items = [];
    for (const e of ends) {
        const gy = getGroundY(e.x, e.z);
        const debris = rng() < 0.6;
        const n = 4 + Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
            const a = rng() * Math.PI * 2, r = rng() * Math.min(0.8, e.r * 0.6);
            const x = e.x + Math.cos(a) * r, z = e.z + Math.sin(a) * r;
            items.push({
                x, y: gy + 0.05 + rng() * 0.06, z,
                sx: debris ? 0.22 + rng() * 0.2 : 0.3 + rng() * 0.25,
                sy: debris ? 0.14 + rng() * 0.12 : 0.06,
                sz: debris ? 0.22 + rng() * 0.2 : 0.3 + rng() * 0.25,
                color: debris ? (rng() < 0.5 ? 0x2c2620 : 0x3a3228) : (rng() < 0.5 ? 0x2f5a2c : 0x274d24),
                rx: 0, ry: rng() * Math.PI, rz: 0,
            });
        }
    }
    const mesh = buildBoxInstances(items, matteMaterial(), true);
    if (mesh) pushAux(rec, mesh);
}

/* ---- 174: layered dark rock clutter along big-chamber wall bases so unlit
   corners read as "more uneven cave" rather than flat void-black. ---- */
export function addDepthSilhouette(rec, cave, ctx) {
    const { rng } = ctx;
    if (!cave.chambers.length) return;
    const main = cave.paths[0];
    const items = [];
    for (const ch of cave.chambers) {
        const n = main[ch.i]; if (!n || rng() > 0.7) continue;
        const cnt = 4 + Math.floor(rng() * 4);
        for (let i = 0; i < cnt; i++) {
            const a = rng() * Math.PI * 2, rr = n.hw * (0.7 + rng() * 0.22);
            const x = ch.x + Math.cos(a) * rr, z = ch.z + Math.sin(a) * rr;
            const gy = getGroundY(x, z);
            const shade = 0.018 + rng() * 0.02;
            items.push({
                x, y: gy + 0.3 + rng() * 0.9, z,
                sx: 0.5 + rng() * 0.5, sy: 0.7 + rng() * 0.9, sz: 0.4 + rng() * 0.4,
                color: new THREE.Color(shade, shade, shade * 1.15).getHex(),
                rx: (rng() - 0.5) * 0.3, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.3,
            });
        }
    }
    const mesh = buildBoxInstances(items, matteMaterial(), true);
    if (mesh) pushAux(rec, mesh);
}

/* ---- 144: a rare fossil/bone-embedded landmark, distinct from the
   mineral-ore theme's small ammonite spiral — a curved rib-cage fan. ---- */
export function addFossilLandmark(rec, cave, ctx) {
    const { rng } = ctx;
    if (rng() > 0.28) return;
    const main = cave.paths[0];
    const i = 1 + Math.floor(rng() * (main.length - 2));
    const n = main[i]; if (!n || n.underwater) return;
    const perp = perpAt(main, i), side = rng() < 0.5 ? -1 : 1;
    const cx = n.x + perp.nx * (n.hw - 0.06) * side, cz = n.z + perp.nz * (n.hw - 0.06) * side;
    const cy = n.floorY + 0.9 + rng() * 0.6;
    const items = [];
    const ribs = 6;
    for (let r = 0; r < ribs; r++) {
        const t = r / (ribs - 1), ang = (t - 0.5) * Math.PI * 0.9;
        const rx0 = Math.sin(ang) * 0.55, ry0 = -Math.abs(Math.cos(ang)) * 0.5 + 0.5;
        items.push({ x: cx + perp.tx * rx0, y: cy + ry0, z: cz + perp.tz * rx0, sx: 0.08, sy: 0.4, sz: 0.1, rx: 0, ry: Math.atan2(perp.nz, perp.nx), rz: ang });
    }
    const mesh = buildBoxInstances(items, matteMaterial(), false);
    if (mesh) { mesh.material.color.setHex(0xcfc2a2); pushAux(rec, mesh); }
}

/* ---- 176: a rare glowing handprint / marking easter-egg, tinted to the
   cave's own accent hue so it reads as a discovered detail, not a light. ---- */
export function addHandprint(rec, cave, ctx) {
    const { rng } = ctx;
    if (rng() > 0.15 || !cave._glow) return;
    const main = cave.paths[0];
    const i = 1 + Math.floor(rng() * (main.length - 2));
    const n = main[i]; if (!n || n.underwater) return;
    const perp = perpAt(main, i), side = rng() < 0.5 ? -1 : 1;
    const x = n.x + perp.nx * (n.hw - 0.04) * side, z = n.z + perp.nz * (n.hw - 0.04) * side;
    const y = n.floorY + 1.0 + rng() * 0.8;
    const heading = Math.atan2(perp.nz, perp.nx);
    const items = [{ x, y, z, sx: 0.22, sy: 0.28, sz: 0.05, rx: 0, ry: heading, rz: 0 }]; // palm
    const fingers = 4;
    for (let f = 0; f < fingers; f++) {
        const fo = (f - (fingers - 1) / 2) * 0.09;
        items.push({ x: x + perp.tx * fo, y: y + 0.2, z: z + perp.tz * fo, sx: 0.05, sy: 0.16, sz: 0.04, rx: 0, ry: heading, rz: 0 });
    }
    const mat = emissiveMaterial(cave._glow, 0.9, 0.4);
    const mesh = buildBoxInstances(items, mat, false);
    if (mesh) pushAux(rec, mesh);
}

/* ---- 135: occasional natural rock-ARCH landmark spanning a larger chamber
   — purely decorative (skips a cave that already got the gameplay `bridge`
   topology feature's own arch, to avoid two arches reading as redundant). ---- */
export function addChamberArch(rec, cave, ctx) {
    const { rng } = ctx;
    if (cave.topo && cave.topo.features && cave.topo.features.includes('bridge')) return;
    const main = cave.paths[0];
    const ch = (cave.topo && cave.topo.cathedral) || cave.chambers[0];
    if (!ch) return;
    const n = main[ch.i]; if (!n || n.hw < 2.0 || rng() > 0.35) return;
    const perp = perpAt(main, ch.i);
    const span = n.hw * 1.8, rise = Math.max(1.6, n.ceilH * 0.55);
    const deckY = n.floorY + rise * 0.15;
    const items = [];
    const steps = 9;
    for (let s = 0; s <= steps; s++) {
        const t = s / steps, off = (t - 0.5) * span;
        const x = n.x + perp.nx * off, z = n.z + perp.nz * off;
        const y = deckY + Math.sin(Math.PI * t) * rise;
        for (let w = -1; w <= 1; w++) {
            items.push({ x: x + perp.tx * w * 0.6, y, z: z + perp.tz * w * 0.6, sx: 0.85, sy: 0.75, sz: 0.85, rx: (rng() - 0.5) * 0.25, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.25 });
        }
    }
    const mesh = buildBoxInstances(items, matteMaterial(), false);
    if (mesh) { mesh.material.color.setHex(0x111014); pushAux(rec, mesh); }
}

/* ---- 166: a rare abandoned-camp / old-explorer decor set at the cave's
   deepest point — a discoverable narrative beat, purely cosmetic. ---- */
export function addExplorerCamp(rec, cave, ctx) {
    const { rng } = ctx;
    if (rng() > 0.12) return;
    const dp = caveDeepPoint(cave);
    const x = dp.x, z = dp.z, gy = getGroundY(x, z);
    const items = [];
    const ring = 8; // cold ash-ring (long-dead campfire)
    for (let i = 0; i < ring; i++) {
        const a = (i / ring) * Math.PI * 2;
        items.push({ x: x + Math.cos(a) * 0.5, y: gy + 0.05, z: z + Math.sin(a) * 0.5, sx: 0.16, sy: 0.1, sz: 0.16, color: 0x1a1512, rx: 0, ry: a, rz: 0 });
    }
    items.push({ x, y: gy + 0.03, z, sx: 0.5, sy: 0.05, sz: 0.5, color: 0x0e0c0a, rx: 0, ry: 0, rz: 0 }); // ash/char centre
    const ba = rng() * Math.PI * 2; // a bedroll
    items.push({ x: x + Math.cos(ba) * 1.0, y: gy + 0.04, z: z + Math.sin(ba) * 1.0, sx: 0.55, sy: 0.06, sz: 1.1, color: 0x3a3228, rx: 0, ry: ba, rz: 0 });
    for (let i = 0; i < 3; i++) { // scattered supply crates
        const a = rng() * Math.PI * 2, r = 0.8 + rng() * 0.8;
        items.push({ x: x + Math.cos(a) * r, y: gy + 0.12, z: z + Math.sin(a) * r, sx: 0.3, sy: 0.24, sz: 0.3, color: 0x4a3a24, rx: 0, ry: rng() * Math.PI, rz: 0 });
    }
    const mesh = buildBoxInstances(items, matteMaterial(), true);
    if (mesh) pushAux(rec, mesh);
}
