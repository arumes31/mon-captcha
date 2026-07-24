/* ============================================================
   Creature Factory & Shared Caches
   ============================================================ */

import * as THREE from 'three';
import { state } from '../state.js';
import { CREATURE_PLANS } from './plans.js';

// ---- Shared geometry & material caches (creature layer only) ----
const creatureGeoCache = new Map();   // "w,h,d" -> BoxGeometry
const creatureMatCache = new Map();   // "color|flags" -> MeshStandardMaterial

function creatureGeo(w, h, d) {
    const key = w + ',' + h + ',' + d;
    let g = creatureGeoCache.get(key);
    if (!g) { g = new THREE.BoxGeometry(w, h, d); creatureGeoCache.set(key, g); }
    return g;
}

function creatureMat(color, o = {}) {
    const glow = o.glow || 0;
    const gi = glow ? (o.glowI || 1.4) : 0;
    const op = o.trans ? (o.opacity || 0.82) : 1;
    const key = color + '|' + (o.trans ? 1 : 0) + '|' + glow + '|' + gi + '|' + op;
    let m = creatureMatCache.get(key);
    if (!m) {
        m = new THREE.MeshStandardMaterial({
            color,
            roughness: 0.72,
            metalness: 0.04,
            transparent: !!o.trans,
            opacity: op,
        });
        if (glow) {
            m.emissive = new THREE.Color(glow);
            m.emissiveIntensity = gi;
        }
        creatureMatCache.set(key, m);
    }
    return m;
}

// Shared caches are disposed exactly once, on teardown
export function disposeCreatureCaches() {
    for (const g of creatureGeoCache.values()) { try { g.dispose(); } catch (e) {} }
    creatureGeoCache.clear();
    for (const m of creatureMatCache.values()) { try { m.dispose(); } catch (e) {} }
    creatureMatCache.clear();
}

/* ------------------------------------------------------------
   Creature factory — builds one voxel creature from a type def.
   Geometry & materials come from the shared caches; `parts`
   collects every mesh (the crosshair-hover raycast iterates it).
   ------------------------------------------------------------ */
export function makeCreature(def) {
    const group = new THREE.Group();
    const parts = [];
    const P = def.palette;

    // Part helper: shared geo/mat, optional rotation & parent attachment
    // (eyes/snouts parented to heads so look-around animation carries them)
    const add = (w, h, d, color, x, y, z, o = {}) => {
        const mesh = new THREE.Mesh(creatureGeo(w, h, d), creatureMat(color, o));
        mesh.position.set(x, y, z);
        if (o.rx) mesh.rotation.x = o.rx;
        if (o.ry) mesh.rotation.y = o.ry;
        if (o.rz) mesh.rotation.z = o.rz;
        mesh.castShadow = true;
        (o.parent || group).add(mesh);
        parts.push(mesh);
        return mesh;
    };

    CREATURE_PLANS[def.plan](P, add, group.userData);
    group.scale.setScalar(def.scale);
    state.scene.add(group);
    // materials list stays empty by design: creature materials live in the
    // shared cache and are disposed once via disposeCreatureCaches()
    return { group, parts, materials: [] };
}
