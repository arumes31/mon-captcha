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
import { getGroundY } from '../heightfield.js';
import { pushAux, buildBoxInstances, buildGeoInstances, matteMaterial, emissiveMaterial, perpAt, vaultY, mouthDist, inPool } from './caves-decor.js';

// item 163: a small per-instance hue/lightness jitter around a base colour so
// a batch of repeated props (vines, pale plants, moss curtains) doesn't read
// as visibly cloned.
const _jc = new THREE.Color();
function jitterColor(hex, rng, amt = 0.1) {
    _jc.setHex(hex).offsetHSL((rng() - 0.5) * amt, (rng() - 0.5) * amt * 0.6, (rng() - 0.5) * amt * 0.5);
    return _jc.getHex();
}

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
    return caps.map(c => ({ x: c.x, y: c.y, z: c.z })); // spore-drift anchors (item 150)
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
    const ch = deepestChamber(cave); if (!ch) return [];
    const capGeo = new THREE.SphereGeometry(0.3, 10, 7);
    const stems = [], anchors = [];
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
        anchors.push({ x, y: gy + h, z });
    }
    capGeo.dispose();
    const smesh = buildBoxInstances(stems, matteMaterial(), false);
    if (smesh) { smesh.material.color.setHex(0xd6cebc); pushAux(rec, smesh); }
    return anchors; // spore-drift anchors (item 150)
}

/* ---- 150/156: spore-particle drift anchored near glow mushrooms/stalks —
   a slow floaty motion distinct from the orbiting crystal sparkles, giving
   fungal caves an ambient "magical forest floor" read. ---- */
export function addSporeField(rec, cave, ctx, decor, anchors, color = 0xcfe79a) {
    if (!anchors.length) return;
    const { rng, profile } = ctx;
    const per = profile.tier === 'low' ? 0 : (profile.tier === 'medium' ? 2 : 3);
    if (per <= 0) return;
    const count = Math.min(40, anchors.length * per);
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) pos[i * 3 + 1] = -1000;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color, size: 0.06, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pushAux(rec, pts);
    const list = [];
    for (let i = 0; i < count; i++) {
        const a = anchors[Math.floor(rng() * anchors.length)];
        list.push({ x: a.x + (rng() - 0.5) * 0.6, z: a.z + (rng() - 0.5) * 0.6, base: a.y, y: a.y, top: a.y + 1.2 + rng() * 0.8, rise: 0.08 + rng() * 0.12, ph: rng() * 6.28, amp: 0.1 + rng() * 0.15 });
    }
    decor.spores.push({ pts, arr: pos, list });
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
            const jScale = 0.85 + rng() * 0.3; // item 163: per-strand scale jitter
            for (let s = 0; s < seg; s++) {
                wob += (rng() - 0.5) * 0.1;
                items.push({ x: x + wob, y: topY - s * 0.3, z: z + wob * 0.5, sx: 0.07 * jScale, sy: 0.32 * jScale, sz: 0.07 * jScale, rx: 0, ry: rng() * Math.PI, rz: 0, color: jitterColor(0x3f5e34, rng) });
            }
        }
    }
    const mesh = buildBoxInstances(items, matteMaterial(), true); // item 163: per-instance colour jitter
    if (mesh) pushAux(rec, mesh); // dark green roots
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
                items.push({ x: x + (rng() - 0.5) * 0.2, y: gy + h / 2, z: z + (rng() - 0.5) * 0.2, sx: 0.05, sy: h, sz: 0.05, rx: (rng() - 0.5) * 0.5, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.5, color: jitterColor(0xb8c0ad, rng, 0.08) });
            }
        }
    }
    const mesh = buildBoxInstances(items, matteMaterial(), true); // item 163: per-instance colour jitter
    if (mesh) pushAux(rec, mesh); // pale, near-colourless
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
            const jScale = 0.85 + rng() * 0.3; // item 163: per-strand scale jitter
            for (let k = 0; k < seg; k++) items.push({ x, y: topY - k * 0.3, z, sx: 0.06 * jScale, sy: 0.3 * jScale, sz: 0.06 * jScale, rx: 0, ry: rng() * Math.PI, rz: 0, color: jitterColor(0x38542e, rng) });
        }
    }
    const mesh = buildBoxInstances(items, matteMaterial(), true); // item 163: per-instance colour jitter
    if (mesh) pushAux(rec, mesh);
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

/* ---- 151: bioluminescent VEIN patterns creeping across walls near fungi
   clusters (kit-batched, not just point glow sources like brackets/stalks). ---- */
export function addBioVeins(kit, cave, ctx, color = 0x6dffb0) {
    const { rng, profile } = ctx, ds = profile.densityScale;
    const main = cave.paths[0];
    for (const ch of cave.chambers) {
        if (rng() > 0.6 * ds) continue;
        const n = main[ch.i]; if (!n || n.underwater) continue;
        const perp = perpAt(main, ch.i), side = rng() < 0.5 ? -1 : 1;
        const x0 = n.x + perp.nx * (n.hw - 0.05) * side, z0 = n.z + perp.nz * (n.hw - 0.05) * side;
        const y0 = n.floorY + 0.5 + rng() * 1.2;
        const branches = 2 + Math.floor(rng() * 2);
        for (let b = 0; b < branches; b++) {
            let bx = x0, bz = z0, by = y0;
            const dx = (rng() - 0.5) * 0.32, dy = rng() * 0.12, dz = (rng() - 0.5) * 0.32;
            const segs = 4 + Math.floor(rng() * 4);
            for (let s = 0; s < segs; s++) {
                kit.emit(color, bx, by, bz, 0.07, 0.05, 0.07, 0, rng() * Math.PI, 0);
                bx += dx + (rng() - 0.5) * 0.15; by += dy + (rng() - 0.5) * 0.04; bz += dz + (rng() - 0.5) * 0.15;
            }
        }
    }
}

/* ---- 157: a ground-level glowing moss TRAIL leading toward a feature (hero
   crystal / singing crystal / deepest chamber) as a breadcrumb — brighter
   near the target, dimmer along the approach. ---- */
export function addMossTrail(kit, cave, ctx, target, color = 0x6dffb0) {
    if (!target) return;
    const { rng } = ctx;
    const main = cave.paths[0];
    let ti = 0, bd = Infinity;
    for (let i = 0; i < main.length; i++) { const dd = (main[i].x - target.x) ** 2 + (main[i].z - target.z) ** 2; if (dd < bd) { bd = dd; ti = i; } }
    const startEnd = ti > main.length / 2 ? 0 : main.length - 1;
    const lo = Math.min(startEnd, ti), hi = Math.max(startEnd, ti);
    const dim = new THREE.Color(color).multiplyScalar(0.45).getHex();
    for (let i = lo; i <= hi; i += 2) {
        const n = main[i]; if (!n || n.underwater || rng() > 0.65) continue;
        const perp = perpAt(main, i), lat = (rng() * 2 - 1) * n.hw * 0.5;
        const x = n.x + perp.nx * lat, z = n.z + perp.nz * lat;
        const near = Math.abs(i - ti) / Math.max(1, hi - lo) < 0.35;
        kit.emit(near ? color : dim, x, n.floorY + 0.03, z, 0.16 + rng() * 0.1, 0.04, 0.16 + rng() * 0.1, 0, rng() * Math.PI, 0);
    }
}
