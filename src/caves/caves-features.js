/* ============================================================
   Cave TOPOLOGY dressing (Phase 2f) — render side of the shapes
   ------------------------------------------------------------
   caves-shapes.js lays out the topology in FIELD terms (node
   cross-sections + extra paths); heightfield.js carves + confines
   them. This module renders the READABLE rock that sells each
   feature: choke rubble with a squeeze gap, talus scatter on the
   descending slopes, fallen breakdown blocks (cover), a shaft
   collar, a natural rock bridge arch, and the translucent water
   SHEET ceiling of an under-river crossing.

   Structural rock (choke / talus / fallen / collar / arch) is pushed
   into the shared always-on `rock[]` layer — it defines how the space
   reads and must never pop as you approach. It is kept modest so the
   ~42k instance ceiling holds. The water sheet is a per-cave mesh
   toggled by the cull band (rec.aux), like the wet-cave pool.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { getGroundY } from '../heightfield.js';

const V = CONFIG.VOXEL_SIZE;

function boulder(rock, x, y, z, s, rng, tintDown = 1) {
    rock.push({
        x, y, z, sx: s, sy: s * (0.6 + rng() * 0.4), sz: s * (0.72 + rng() * 0.36),
        color: new THREE.Color(0.11 * tintDown + rng() * 0.04, 0.105 * tintDown, 0.125 * tintDown).getHex(),
        rx: rng() * 0.5, ry: rng() * Math.PI, rz: rng() * 0.5,
    });
}

// items 132/170: a scatter of small loose scree/pebbles around a collapse-
// adjacent point (choke pile / fallen block) — "breakable-looking" foreshadow
// rubble distinct from the bigger structural boulders above.
function scree(rock, cx, cz, radius, rng, count) {
    for (let i = 0; i < count; i++) {
        const a = rng() * Math.PI * 2, r = rng() * radius;
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        const s = 0.12 + rng() * 0.16;
        rock.push({
            x, y: getGroundY(x, z) + s * V * 0.4, z, sx: s, sy: s * (0.6 + rng() * 0.3), sz: s * (0.7 + rng() * 0.3),
            color: new THREE.Color(0.1 + rng() * 0.05, 0.095 + rng() * 0.03, 0.1 + rng() * 0.04).getHex(),
            rx: rng() * 0.6, ry: rng() * Math.PI, rz: rng() * 0.6,
        });
    }
}

// Structural topology rock for one cave -> pushed into the always-on rock layer.
export function buildTopoRock(cave, rock, rng) {
    const t = cave.topo;
    if (!t) return;

    // item 3: partial cave-in — rubble mounds flanking the squeeze, centre clear
    for (const ch of (t.choke || [])) {
        const gy = getGroundY(ch.x, ch.z);
        for (const side of [-1, 1]) {
            const n = 2 + Math.floor(rng() * 2);
            for (let i = 0; i < n; i++) {
                const lat = side * (0.55 + rng() * (ch.hw - 0.1));
                const x = ch.x + ch.nx * lat, z = ch.z + ch.nz * lat;
                const s = 0.5 + rng() * 0.7;
                boulder(rock, x, getGroundY(x, z) + s * V * 0.45, z, s, rng);
            }
        }
        // a couple of high boulders wedged near the ceiling (partial collapse)
        for (let i = 0; i < 2; i++) {
            const lat = (rng() - 0.5) * ch.hw * 1.2;
            boulder(rock, ch.x + ch.nx * lat, gy + 1.9 + rng() * 0.5, ch.z + ch.nz * lat, 0.55 + rng() * 0.4, rng, 0.9);
        }
        scree(rock, ch.x, ch.z, ch.hw + 0.6, rng, 5 + Math.floor(rng() * 4)); // items 132/170
    }

    // item 11: talus scatter on the descending slope nodes
    for (const path of cave.paths) {
        for (const nd of path) {
            if (!nd.talus || rng() > 0.75) continue;
            const per = perpXZ(path, nd);
            const nR = 1 + Math.floor(rng() * 2);
            for (let i = 0; i < nR; i++) {
                const lat = (rng() - 0.5) * Math.max(0.3, nd.hw - 0.3);
                const x = nd.x + per.nx * lat, z = nd.z + per.nz * lat;
                const s = 0.3 + rng() * 0.45;
                boulder(rock, x, getGroundY(x, z) + s * V * 0.4, z, s, rng);
            }
        }
    }

    // item 12: fallen breakdown blocks (cover) — large tilted slabs on the floor
    for (const fb of (t.fallen || [])) {
        const gy = getGroundY(fb.x, fb.z);
        rock.push({
            x: fb.x, y: gy + fb.s * V * 0.6, z: fb.z,
            sx: fb.s * 1.3, sy: fb.s * (0.8 + Math.random() * 0.5), sz: fb.s * 1.15,
            color: new THREE.Color(0.12, 0.115, 0.135).getHex(),
            rx: fb.tilt, ry: fb.rot, rz: fb.tilt * 0.6,
        });
        if (Math.random() < 0.5) boulder(rock, fb.x + (Math.random() - 0.5) * fb.s, gy + 0.2, fb.z + (Math.random() - 0.5) * fb.s, 0.4 + Math.random() * 0.3, rng);
        scree(rock, fb.x, fb.z, fb.s * 1.6, rng, 4 + Math.floor(rng() * 3)); // items 132/170
    }

    // item 1: shaft collar — a rough rim of rock around the drop mouth
    for (const sh of (t.shafts || [])) {
        const ring = 7;
        for (let i = 0; i < ring; i++) {
            const a = (i / ring) * Math.PI * 2 + rng();
            const r = 1.1 + rng() * 0.4;
            const x = sh.x + Math.cos(a) * r, z = sh.z + Math.sin(a) * r;
            const s = 0.45 + rng() * 0.35;
            boulder(rock, x, getGroundY(x, z) + s * V * 0.5, z, s, rng);
        }
    }

    // item 2: natural rock bridge arch spanning over the gallery (decorative)
    for (const br of (t.bridges || [])) {
        const steps = 9;
        const rise = Math.max(1.6, br.topY - br.deckY);
        for (let s = 0; s <= steps; s++) {
            const tt = s / steps;
            const off = (tt - 0.5) * br.span;
            const x = br.x + br.nx * off, z = br.z + br.nz * off;
            const y = br.deckY + Math.sin(Math.PI * tt) * rise;
            for (let w = -1; w <= 1; w++) {
                rock.push({
                    x: x + br.tx * w * 0.7, y, z: z + br.tz * w * 0.7,
                    sx: 0.9, sy: 0.8, sz: 0.9,
                    color: new THREE.Color(0.1 + rng() * 0.03, 0.098, 0.12).getHex(),
                    rx: (rng() - 0.5) * 0.3, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.3,
                });
            }
        }
    }
}

// item 8: translucent water SHEET as the under-river ceiling (per cave, culled).
export function buildTopoWater(cave, rec) {
    if (!cave.topo || !cave.topo.water || !cave.topo.water.length) return;
    rec.aux = rec.aux || [];
    for (const w of cave.topo.water) {
        const len = Math.max(2.5, Math.abs(w.from - w.to) + 2.5);
        const geo = new THREE.PlaneGeometry(len, 4.2);
        const mat = new THREE.MeshStandardMaterial({
            color: 0x2a6b86, emissive: 0x123845, emissiveIntensity: 0.5,
            roughness: 0.2, metalness: 0.2, transparent: true, opacity: 0.6, side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geo, mat);
        const midOff = (w.from + w.to) / 2;
        mesh.position.set(w.cx + w.nx * midOff, w.y, w.cz + w.nz * midOff);
        mesh.rotation.x = -Math.PI / 2;
        mesh.rotation.z = Math.atan2(w.nz, w.nx);
        mesh.renderOrder = 1;
        state.scene.add(mesh);
        rec.aux.push(mesh);
    }
}

function perpXZ(path, node) {
    let i = path.indexOf(node);
    if (i < 0) i = 0;
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz) || 1;
    return { nx: -tz / l, nz: tx / l };
}
