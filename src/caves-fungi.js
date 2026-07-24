/* ============================================================
   Cave FUNGI / FLORA dressing (Phase 2g items 49–56)
   ------------------------------------------------------------
   Living cave flora for the fungal theme (+ wet-pool rings on the
   flooded theme, pale plants at any mouth):
     bracket / shelf fungi + tall glowing stalks + puffballs,
     dangling vines / roots near the mouths, glow mushrooms that
     BRIGHTEN as the player passes, puffballs that BURST into a spore
     cloud on player / ball contact, pale colourless plants near the
     entrance light, mushroom rings around wet pools, walk-through
     moss curtains at junctions, and softly glowing fungal floor mats
     in the deepest chamber.

   Glowing species are emissive (read in the dark); pale plants + vines
   are matte (read at the lit mouths / under 2h lighting). Proximity
   mushrooms + puffballs are individual meshes (per-item animation);
   everything else batches into instanced meshes. All land in the
   culled rec.aux layer; animated state registers on the decor record.
   ============================================================ */

import * as THREE from 'three';
import { getGroundY } from './heightfield.js';
import { pushAux, buildBoxInstances, buildGeoInstances, matteMaterial, emissiveMaterial, perpAt, vaultY, mouthDist, inPool } from './caves-decor.js';

function deepestChamber(cave) {
    if (!cave.chambers.length) return null;
    const main = cave.paths[0];
    let best = cave.chambers[0], bestY = Infinity;
    for (const ch of cave.chambers) { const y = main[ch.i] ? main[ch.i].floorY : 0; if (y < bestY) { bestY = y; best = ch; } }
    return best;
}

/* ---- 49a: bracket / shelf fungi jutting from the walls ---- */
export function addBrackets(rec, cave, ctx, color = 0xe0a84a) {
    const { rng, profile } = ctx, ds = profile.densityScale;
    const items = [];
    for (const path of cave.paths) {
        for (let i = 1; i < path.length - 1; i++) {
            const n = path[i]; if (n.underwater || rng() > 0.4 * ds) continue;
            const perp = perpAt(path, i), side = rng() < 0.5 ? -1 : 1;
            const shelves = 1 + Math.floor(rng() * 3);
            for (let s = 0; s < shelves; s++) {
                const x = n.x + perp.nx * (n.hw - 0.15) * side, z = n.z + perp.nz * (n.hw - 0.15) * side;
                const y = n.floorY + 0.4 + rng() * (n.ceilH * 0.5);
                items.push({ x, y, z, sx: 0.5 + rng() * 0.5, sy: 0.12, sz: 0.35 + rng() * 0.3, rx: -0.15 * side, ry: Math.atan2(perp.nz, perp.nx), rz: 0 });
            }
        }
    }
    const mat = emissiveMaterial(color, 0.9, 0.45);
    const mesh = buildBoxInstances(items, mat, false);
    mesh && pushAux(rec, mesh);
}

/* ---- 49b: tall glowing stalks (pale stem + luminous cap) ---- */
export function addStalks(rec, cave, ctx, color = 0x8affd0) {
    const { rng, profile } = ctx, ds = profile.densityScale;
    const stems = [], caps = [];
    for (const ch of cave.chambers) {
        const n = 1 + Math.floor(rng() * 3 * ds);
        for (let i = 0; i < n; i++) {
            const a = rng() * Math.PI * 2, r = rng() * 1.3;
            const x = ch.x + Math.cos(a) * r, z = ch.z + Math.sin(a) * r;
            if (inPool(cave, x, z, 0.4)) continue;
            const gy = getGroundY(x, z), h = 0.9 + rng() * 1.4;
            stems.push({ x, y: gy + h / 2, z, sx: 0.12, sy: h, sz: 0.12, rx: (rng() - 0.5) * 0.2, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.2 });
            caps.push({ x, y: gy + h, z, sx: 0.34 + rng() * 0.18, sy: 0.28, sz: 0.34 + rng() * 0.18, rx: 0, ry: rng() * Math.PI, rz: 0 });
        }
    }
    const smesh = buildBoxInstances(stems, matteMaterial(), false);
    if (smesh) { smesh.material.color.setHex(0xcdc6b2); pushAux(rec, smesh); }
    const cmesh = buildGeoInstances(new THREE.SphereGeometry(0.5, 8, 6), emissiveMaterial(color, 1.25, 0.4), caps);
    cmesh && pushAux(rec, cmesh);
}

/* ---- 52: puffballs that BURST into spores (player / ball contact) ---- */
export function addPuffballs(rec, cave, ctx, decor, color = 0xd7e79a, count = 4) {
    const { rng } = ctx;
    const main = cave.paths[0];
    const geo = new THREE.SphereGeometry(0.26, 10, 8);
    const stems = [];
    for (let p = 0; p < count; p++) {
        let x, z;
        if (cave.chambers.length && rng() < 0.7) { const ch = cave.chambers[Math.floor(rng() * cave.chambers.length)]; x = ch.x + (rng() - 0.5) * 1.8; z = ch.z + (rng() - 0.5) * 1.8; }
        else { const i = 1 + Math.floor(rng() * (main.length - 2)); const n = main[i]; if (n.underwater) continue; const perp = perpAt(main, i); const lat = (rng() * 2 - 1) * n.hw * 0.6; x = n.x + perp.nx * lat; z = n.z + perp.nz * lat; }
        if (inPool(cave, x, z, 0.5)) continue;
        const gy = getGroundY(x, z), baseScale = 0.85 + rng() * 0.6;
        const mat = emissiveMaterial(color, 0.85, 0.55);
        const mesh = new THREE.Mesh(geo.clone(), mat);
        mesh.position.set(x, gy + 0.26 * baseScale, z); mesh.scale.setScalar(baseScale); mesh.castShadow = false;
        pushAux(rec, mesh);
        decor.puffballs.push({ x, y: gy + 0.26 * baseScale, z, mesh, baseScale, spore: 0xc9e08a, burst: false, regrow: 0, grow: 1 });
        stems.push({ x, y: gy + 0.08, z, sx: 0.14, sy: 0.16, sz: 0.14, rx: 0, ry: 0, rz: 0 });
    }
    geo.dispose();
    const smesh = buildBoxInstances(stems, matteMaterial(), false);
    if (smesh) { smesh.material.color.setHex(0xbfb79f); pushAux(rec, smesh); }
}

/* ---- 51: glow mushrooms that brighten as the player passes (deepest chamber) ---- */
export function addProximityMushrooms(rec, cave, ctx, decor, color = 0x7dffb0, count = 5) {
    const { rng } = ctx;
    const ch = deepestChamber(cave); if (!ch) return;
    const capGeo = new THREE.SphereGeometry(0.3, 10, 7);
    const stems = [];
    for (let i = 0; i < count; i++) {
        const a = rng() * Math.PI * 2, r = rng() * 1.6;
        const x = ch.x + Math.cos(a) * r, z = ch.z + Math.sin(a) * r;
        if (inPool(cave, x, z, 0.4)) continue;
        const gy = getGroundY(x, z), h = 0.4 + rng() * 0.7;
        const mat = emissiveMaterial(color, 0.55, 0.42);
        const cap = new THREE.Mesh(capGeo.clone(), mat);
        cap.position.set(x, gy + h, z); cap.scale.set(1, 0.7, 1); cap.castShadow = false;
        pushAux(rec, cap);
        decor.mushrooms.push({ x, y: gy + h, z, mat, baseEmis: 0.55 });
        stems.push({ x, y: gy + h / 2, z, sx: 0.11, sy: h, sz: 0.11, rx: 0, ry: 0, rz: 0 });
    }
    capGeo.dispose();
    const smesh = buildBoxInstances(stems, matteMaterial(), false);
    if (smesh) { smesh.material.color.setHex(0xd6cebc); pushAux(rec, smesh); }
}

/* ---- 50: dangling vines / roots near the mouths ---- */
export function addVines(rec, cave, ctx) {
    const { rng } = ctx;
    const main = cave.paths[0];
    const items = [];
    const idx = [1, 2, main.length - 3, main.length - 2].filter(i => i > 0 && i < main.length - 1);
    for (const i of idx) {
        const n = main[i]; if (n.underwater) continue;
        const dens = Math.max(0, 1 - mouthDist(cave, n.x, n.z) / 6);
        if (dens <= 0.05) continue;
        const perp = perpAt(main, i);
        const nV = Math.round((1 + rng() * 3) * dens);
        for (let v = 0; v < nV; v++) {
            const lat = (rng() * 2 - 1) * n.hw * 0.8;
            const x = n.x + perp.nx * lat, z = n.z + perp.nz * lat;
            const topY = vaultY(n, lat / n.hw) - 0.1, len = 0.6 + rng() * 1.4, seg = Math.max(2, Math.round(len / 0.3));
            let wob = 0;
            for (let s = 0; s < seg; s++) {
                wob += (rng() - 0.5) * 0.1;
                items.push({ x: x + wob, y: topY - s * 0.3, z: z + wob * 0.5, sx: 0.07, sy: 0.32, sz: 0.07, rx: 0, ry: rng() * Math.PI, rz: 0 });
            }
        }
    }
    const mesh = buildBoxInstances(items, matteMaterial(), false);
    if (mesh) { mesh.material.color.setHex(0x3f5e34); pushAux(rec, mesh); } // dark green roots
}

/* ---- 53: pale colourless plants near the entrance light ---- */
export function addPalePlants(rec, cave, ctx) {
    const { rng } = ctx;
    const main = cave.paths[0];
    const items = [];
    const idx = [1, 2, main.length - 3, main.length - 2].filter(i => i > 0 && i < main.length - 1);
    for (const i of idx) {
        const n = main[i]; if (n.underwater) continue;
        const dens = Math.max(0, 1 - mouthDist(cave, n.x, n.z) / 6);
        if (dens <= 0.05) continue;
        const perp = perpAt(main, i);
        const nP = Math.round((2 + rng() * 3) * dens);
        for (let p = 0; p < nP; p++) {
            const lat = (rng() * 2 - 1) * (n.hw - 0.2);
            const x = n.x + perp.nx * lat, z = n.z + perp.nz * lat, gy = getGroundY(x, z);
            const blades = 2 + Math.floor(rng() * 3);
            for (let b = 0; b < blades; b++) {
                const h = 0.2 + rng() * 0.4;
                items.push({ x: x + (rng() - 0.5) * 0.2, y: gy + h / 2, z: z + (rng() - 0.5) * 0.2, sx: 0.05, sy: h, sz: 0.05, rx: (rng() - 0.5) * 0.5, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.5 });
            }
        }
    }
    const mesh = buildBoxInstances(items, matteMaterial(), false);
    if (mesh) { mesh.material.color.setHex(0xb8c0ad); pushAux(rec, mesh); } // pale, near-colourless
}

/* ---- 54: mushroom rings around wet pools ---- */
export function addPoolRing(rec, cave, ctx, color = 0x8affd0) {
    const { rng } = ctx;
    const p = cave.pool; if (!p) return;
    const stems = [], caps = [];
    const n = 7 + Math.floor(rng() * 6);
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rng() * 0.3, r = p.r + 0.35 + rng() * 0.7;
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r, gy = getGroundY(x, z), h = 0.3 + rng() * 0.5;
        stems.push({ x, y: gy + h / 2, z, sx: 0.09, sy: h, sz: 0.09, rx: 0, ry: 0, rz: 0 });
        caps.push({ x, y: gy + h, z, sx: 0.24 + rng() * 0.14, sy: 0.18, sz: 0.24 + rng() * 0.14, rx: 0, ry: rng() * Math.PI, rz: 0 });
    }
    const smesh = buildBoxInstances(stems, matteMaterial(), false);
    if (smesh) { smesh.material.color.setHex(0xcdc6b2); pushAux(rec, smesh); }
    const cmesh = buildGeoInstances(new THREE.SphereGeometry(0.5, 8, 6), emissiveMaterial(color, 1.1, 0.4), caps);
    cmesh && pushAux(rec, cmesh);
}

/* ---- 55: walk-through moss curtains at junctions ---- */
export function addMossCurtains(rec, cave, ctx) {
    const { rng } = ctx;
    const items = [];
    // curtains hang at chamber nodes (the roomy junction-ish points)
    for (const ch of cave.chambers) {
        if (rng() > 0.7) continue;
        const main = cave.paths[0], n = main[ch.i]; if (!n || n.underwater) continue;
        const perp = perpAt(main, ch.i);
        const span = n.hw * 1.7;
        const strands = Math.max(5, Math.round(span / 0.3));
        for (let s = 0; s <= strands; s++) {
            const lat = (s / strands - 0.5) * 2 * (n.hw - 0.1);
            const x = n.x + perp.nx * lat, z = n.z + perp.nz * lat;
            const topY = vaultY(n, lat / n.hw) - 0.1, len = 0.7 + rng() * 1.3, seg = Math.max(2, Math.round(len / 0.3));
            for (let k = 0; k < seg; k++) items.push({ x, y: topY - k * 0.3, z, sx: 0.06, sy: 0.3, sz: 0.06, rx: 0, ry: rng() * Math.PI, rz: 0 });
        }
    }
    const mesh = buildBoxInstances(items, matteMaterial(), false);
    if (mesh) { mesh.material.color.setHex(0x38542e); pushAux(rec, mesh); }
}

/* ---- 56: softly glowing fungal floor mats in the deepest chamber ---- */
export function addFloorMats(rec, cave, ctx, decor, color = 0x6effa8) {
    const { rng } = ctx;
    const ch = deepestChamber(cave); if (!ch) return;
    const items = [];
    const patches = 3 + Math.floor(rng() * 4);
    for (let p = 0; p < patches; p++) {
        const a = rng() * Math.PI * 2, r = rng() * 1.7;
        const x = ch.x + Math.cos(a) * r, z = ch.z + Math.sin(a) * r;
        if (inPool(cave, x, z, 0.3)) continue;
        const tiles = 2 + Math.floor(rng() * 3);
        for (let t = 0; t < tiles; t++) {
            const tx = x + (rng() - 0.5) * 0.9, tz = z + (rng() - 0.5) * 0.9;
            items.push({ x: tx, y: getGroundY(tx, tz) + 0.03, z: tz, sx: 0.5 + rng() * 0.5, sy: 0.06, sz: 0.5 + rng() * 0.5, rx: 0, ry: rng() * Math.PI, rz: 0 });
        }
    }
    if (!items.length) return;
    const mat = emissiveMaterial(color, 0.7, 0.5);
    mat.userData = { base: 0.7, ph: rng() * 6 };
    const mesh = buildBoxInstances(items, mat, false);
    if (mesh) { pushAux(rec, mesh); decor.mats.push(mat); }
}
