/* ============================================================
   Cave CRYSTAL dressing (Phase 2g items 57–64)
   ------------------------------------------------------------
   Faceted, self-illuminating crystal features for the crystal- and
   geode-themed caves (and light accents elsewhere):
     giant HERO crystal centrepiece, geodes (cracked rock revealing
     a crystal-lined hollow), theme-keyed crystal colour, slow
     shimmer / scale-pulse, chime-on-ball-strike, selenite needle
     fields, amethyst wall pockets, and the rare "singing crystal"
     that glows + sings a soft tone as the player approaches.

   All crystals are emissive so they READ in the dark deep chambers
   (no lantern until Phase 2h). They are built as custom faceted
   geometry (hex spires, gem octahedra, bladed needles), pushed into
   the culled rec.aux layer, and their animated / interactive state
   (shimmer, chime points, singing) is registered on the per-cave
   decor record for updateDecor.
   ============================================================ */

import * as THREE from 'three';
import { getGroundY } from '../heightfield.js';
import { pushAux, buildGeoInstances, emissiveMaterial, perpAt } from './caves-decor.js';

// base geometries (each mesh gets its OWN cloned geo so the core teardown can
// dispose per-mesh without double-freeing a shared one).
function spireGeo(sides, r, h) { const g = new THREE.ConeGeometry(r, h, sides); g.translate(0, h / 2, 0); return g; }
function gemGeo(s) { return new THREE.OctahedronGeometry(s); }

function biggestChamber(cave) {
    if (cave.topo && cave.topo.cathedral) return cave.topo.cathedral;
    if (!cave.chambers.length) return null;
    const main = cave.paths[0];
    let best = cave.chambers[0], bestHW = -1;
    for (const ch of cave.chambers) { const hw = main[ch.i] ? main[ch.i].hw : 0; if (hw > bestHW) { bestHW = hw; best = ch; } }
    return best;
}

/* ---- 57 + 60 + 61: giant faceted HERO crystal + surrounding cluster ---- */
export function addHeroCrystal(rec, cave, ctx, decor, color) {
    const { rng } = ctx;
    const ch = biggestChamber(cave); if (!ch) return;
    const x = ch.x, z = ch.z, fy = getGroundY(x, z);
    const h = 2.6 + rng() * 1.3, r = 0.55 + rng() * 0.3;
    const mat = emissiveMaterial(color, 1.5, 0.2); mat.metalness = 0.1;
    const mesh = new THREE.Mesh(spireGeo(6, r, h), mat);
    mesh.position.set(x, fy, z); mesh.rotation.y = rng() * Math.PI;
    mesh.castShadow = false;
    pushAux(rec, mesh);
    decor.hero = { mesh, mat, baseEmis: 1.5, sx: 1, sy: 1, sz: 1, phase: rng() * 6 };
    decor.chimePoints.push({ x, y: fy + h * 0.5, z, pick: rng(), spark: color });
    cave._heroPos = { x, y: fy + h * 0.6, z, color };
    // surrounding smaller spires leaning outward (static instanced cluster)
    const items = [], nS = 5 + Math.floor(rng() * 4);
    for (let i = 0; i < nS; i++) {
        const a = rng() * Math.PI * 2, rr = r + 0.5 + rng() * 1.0;
        const sx = x + Math.cos(a) * rr, sz = z + Math.sin(a) * rr, sh = 0.8 + rng() * 1.4;
        const gy = getGroundY(sx, sz);
        items.push({ x: sx, y: gy, z: sz, sx: 0.5 + rng() * 0.4, sy: sh, sz: 0.5 + rng() * 0.4, rx: (rng() - 0.5) * 0.55, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.55 });
        decor.chimePoints.push({ x: sx, y: gy + sh * 0.5, z: sz, pick: rng(), spark: color });
    }
    const cmat = emissiveMaterial(color, 1.35, 0.28);
    const cmesh = buildGeoInstances(spireGeo(6, 0.5, 1), cmat, items);
    if (cmesh) { pushAux(rec, cmesh); cmat.userData = { base: 1.35, ph: rng() * 6 }; decor.crystalMats.push(cmat); }
}

/* ---- 58: geodes — cracked rock rim revealing a crystal-lined hollow ---- */
export function addGeodes(rec, cave, ctx, decor, color, count) {
    const { rng } = ctx;
    const main = cave.paths[0];
    const shards = [], rim = [];
    for (let g = 0; g < count; g++) {
        let x, z;
        if (cave.chambers.length && rng() < 0.55) {
            const ch = cave.chambers[Math.floor(rng() * cave.chambers.length)];
            x = ch.x + (rng() - 0.5) * 1.6; z = ch.z + (rng() - 0.5) * 1.6;
        } else {
            const i = 1 + Math.floor(rng() * (main.length - 2)); const n = main[i]; if (n.underwater) continue;
            const perp = perpAt(main, i), side = rng() < 0.5 ? -1 : 1;
            x = n.x + perp.nx * (n.hw - 0.4) * side; z = n.z + perp.nz * (n.hw - 0.4) * side;
        }
        const y = getGroundY(x, z), R = 0.55 + rng() * 0.3;
        // raised rocky rim (ring of dark boxes) — the cracked-open geode wall
        const ring = 9;
        for (let k = 0; k < ring; k++) {
            const a = (k / ring) * Math.PI * 2;
            rim.push({ x: x + Math.cos(a) * R, y: y + 0.16 + rng() * 0.12, z: z + Math.sin(a) * R });
        }
        // inner crystals pointing up + outward
        const nSh = 5 + Math.floor(rng() * 4);
        for (let s = 0; s < nSh; s++) {
            const a = rng() * Math.PI * 2, rr = rng() * R * 0.55, sh = 0.28 + rng() * 0.5;
            shards.push({ x: x + Math.cos(a) * rr, y: y + 0.12, z: z + Math.sin(a) * rr, sx: 0.16 + rng() * 0.12, sy: sh, sz: 0.16 + rng() * 0.12, rx: (rng() - 0.5) * 0.7, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.7 });
        }
        decor.chimePoints.push({ x, y: y + 0.35, z, pick: rng(), spark: color });
    }
    // rim -> a matte-ish dark emissive-free box mesh via the shard color at very
    // low intensity would look wrong, so build the rim as its own dark instanced
    // box mesh (kept in aux, culled). Reuse the shard builder for crystals.
    if (rim.length) {
        const rmat = new THREE.MeshStandardMaterial({ color: 0x161318, roughness: 0.95, metalness: 0.05 });
        const geo = new THREE.BoxGeometry(0.34, 0.34, 0.34);
        const rmesh = buildGeoInstances(geo, rmat, rim.map(o => ({ ...o, sx: 1, sy: 1, sz: 1, ry: rng() * Math.PI })));
        rmesh && pushAux(rec, rmesh);
    }
    const mat = emissiveMaterial(color, 1.4, 0.26);
    const mesh = buildGeoInstances(spireGeo(6, 0.5, 1), mat, shards);
    if (mesh) { pushAux(rec, mesh); mat.userData = { base: 1.4, ph: rng() * 6 }; decor.crystalMats.push(mat); }
}

/* ---- 62: selenite needle fields (pale bladed spikes) ---- */
export function addSelenite(rec, cave, ctx, decor) {
    const { rng } = ctx;
    const main = cave.paths[0];
    const items = [];
    const fields = 1 + (rng() < 0.5 ? 1 : 0);
    for (let f = 0; f < fields; f++) {
        const i = 1 + Math.floor(rng() * (main.length - 2)); const n = main[i]; if (n.underwater) continue;
        const perp = perpAt(main, i), lat = (rng() * 2 - 1) * n.hw * 0.6;
        const cx = n.x + perp.nx * lat, cz = n.z + perp.nz * lat;
        const nN = 6 + Math.floor(rng() * 8);
        for (let k = 0; k < nN; k++) {
            const a = rng() * Math.PI * 2, rr = rng() * 0.7, h = 0.7 + rng() * 1.2;
            const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
            items.push({ x, y: getGroundY(x, z), z, sx: 0.09, sy: h, sz: 0.09, rx: (rng() - 0.5) * 0.4, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.4 });
        }
        decor.chimePoints.push({ x: cx, y: getGroundY(cx, cz) + 0.6, z: cz, pick: rng(), spark: 0xeaf2ff });
    }
    const mat = emissiveMaterial(0xdfeaff, 1.05, 0.18);
    const mesh = buildGeoInstances(spireGeo(4, 0.5, 1), mat, items); // 4-sided = bladed needle
    if (mesh) { pushAux(rec, mesh); mat.userData = { base: 1.05, ph: rng() * 6 }; decor.crystalMats.push(mat); }
}

/* ---- 63: amethyst wall pockets (clusters of purple gems set in the wall) ---- */
export function addAmethyst(rec, cave, ctx, decor, color = 0x9a5cff) {
    const { rng, profile } = ctx, ds = profile.densityScale;
    const items = [];
    for (const path of cave.paths) {
        for (let i = 1; i < path.length - 1; i++) {
            const n = path[i]; if (n.underwater || rng() > 0.3 * ds) continue;
            const perp = perpAt(path, i), side = rng() < 0.5 ? -1 : 1;
            const x = n.x + perp.nx * (n.hw - 0.02) * side, z = n.z + perp.nz * (n.hw - 0.02) * side;
            const y = n.floorY + 0.6 + rng() * 1.5;
            const nSh = 3 + Math.floor(rng() * 4);
            for (let s = 0; s < nSh; s++) {
                items.push({ x: x + (rng() - 0.5) * 0.5, y: y + (rng() - 0.5) * 0.4, z: z + (rng() - 0.5) * 0.5, sx: 0.13 + rng() * 0.1, sy: 0.13 + rng() * 0.1, sz: 0.13 + rng() * 0.1, rx: rng() * 0.8, ry: rng() * Math.PI, rz: rng() * 0.8 });
            }
            decor.chimePoints.push({ x, y, z, pick: rng(), spark: color });
        }
    }
    const mat = emissiveMaterial(color, 1.4, 0.28);
    const mesh = buildGeoInstances(gemGeo(0.5), mat, items);
    if (mesh) { pushAux(rec, mesh); mat.userData = { base: 1.4, ph: rng() * 6 }; decor.crystalMats.push(mat); }
}

/* ---- 64: rare "singing crystal" — glows + sings a soft tone on approach ---- */
export function addSingingCrystal(rec, cave, ctx, decor, color) {
    const { rng } = ctx;
    let x, z;
    if (cave.chambers.length > 1) { const ch = cave.chambers[1]; x = ch.x + (rng() - 0.5) * 1.2; z = ch.z + (rng() - 0.5) * 1.2; }
    else if (cave.chambers.length) { const ch = cave.chambers[0]; x = ch.x + (rng() - 0.5) * 2.0; z = ch.z + (rng() - 0.5) * 2.0; }
    else { const main = cave.paths[0], n = main[Math.floor(main.length / 2)]; x = n.x; z = n.z; }
    const fy = getGroundY(x, z), h = 2.3 + rng() * 0.9, r = 0.35;
    const mat = emissiveMaterial(color, 1.4, 0.16); mat.metalness = 0.15;
    const mesh = new THREE.Mesh(spireGeo(6, r, h), mat);
    mesh.position.set(x, fy, z); mesh.rotation.y = rng() * Math.PI; mesh.castShadow = false;
    pushAux(rec, mesh);
    decor.singing.push({ x, y: fy + h * 0.5, z, mat, baseEmis: 1.4, cd: 1.0 });
    decor.chimePoints.push({ x, y: fy + h * 0.5, z, pick: rng(), spark: color });
    // a few attendant small spires so it reads as a tuned cluster
    const items = [], nS = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < nS; i++) {
        const a = rng() * Math.PI * 2, rr = 0.5 + rng() * 0.6, sh = 0.6 + rng() * 0.7;
        const sx = x + Math.cos(a) * rr, sz = z + Math.sin(a) * rr;
        items.push({ x: sx, y: getGroundY(sx, sz), z: sz, sx: 0.35, sy: sh, sz: 0.35, rx: (rng() - 0.5) * 0.4, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.4 });
    }
    const cmat = emissiveMaterial(color, 1.25, 0.24);
    const cmesh = buildGeoInstances(spireGeo(6, 0.5, 1), cmat, items);
    if (cmesh) { pushAux(rec, cmesh); cmat.userData = { base: 1.25, ph: rng() * 6 }; decor.crystalMats.push(cmat); }
}

// chamber-centre chime points so the CORE cave-hue crystal clusters also chime.
export function addChamberChimes(cave, decor, color) {
    for (const ch of cave.chambers) decor.chimePoints.push({ x: ch.x, y: getGroundY(ch.x, ch.z) + 0.6, z: ch.z, pick: Math.random(), spark: color });
}
