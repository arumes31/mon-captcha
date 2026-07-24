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

// Item 314: per-archetype material finish so silhouettes read distinctly
// (wet-translucent slime/jelly, matte fur, harder mineral shell/carapace)
// instead of every part sharing one flat roughness/metalness — pure
// MeshStandardMaterial tuning keyed by body plan, no new geometry/parts.
const ARCHETYPE_FINISH = {
    slime: { rough: 0.26, metal: 0.0 }, jelly: { rough: 0.22, metal: 0.0 }, ghost: { rough: 0.35, metal: 0.0 },
    bunny: { rough: 0.88, metal: 0.0 }, fox: { rough: 0.85, metal: 0.0 }, elk: { rough: 0.87, metal: 0.0 }, otter: { rough: 0.7, metal: 0.02 },
    golem: { rough: 0.6, metal: 0.16 }, crab: { rough: 0.55, metal: 0.12 }, turtle: { rough: 0.6, metal: 0.06 }, beetle: { rough: 0.4, metal: 0.24 },
    bird: { rough: 0.62, metal: 0.02 }, duck: { rough: 0.6, metal: 0.02 }, owl: { rough: 0.7, metal: 0.0 },
    dragon: { rough: 0.5, metal: 0.1 }, phoenix: { rough: 0.4, metal: 0.14 },
    spider: { rough: 0.68, metal: 0.05 }, snail: { rough: 0.5, metal: 0.05 }, mushroom: { rough: 0.8, metal: 0.0 },
    fish: { rough: 0.3, metal: 0.06 }, dragonfly: { rough: 0.38, metal: 0.1 }, bat: { rough: 0.72, metal: 0.0 },
    hummingbird: { rough: 0.38, metal: 0.16 }, swarm: { rough: 0.5, metal: 0.0 },
};
const DEFAULT_FINISH = { rough: 0.72, metal: 0.04 }; // matches the previous flat global default

function creatureMat(color, o = {}) {
    const glow = o.glow || 0;
    const gi = glow ? (o.glowI || 1.4) : 0;
    const op = o.trans ? (o.opacity || 0.82) : 1;
    const rough = o.rough != null ? o.rough : DEFAULT_FINISH.rough;
    const metal = o.metal != null ? o.metal : DEFAULT_FINISH.metal;
    const key = color + '|' + (o.trans ? 1 : 0) + '|' + glow + '|' + gi + '|' + op + '|' + rough + '|' + metal;
    let m = creatureMatCache.get(key);
    if (!m) {
        m = new THREE.MeshStandardMaterial({
            color,
            roughness: rough,
            metalness: metal,
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

// Item 305: a per-CREATURE (not per-part) hue/lightness shift so several
// instances of the same species don't read as visual clones — one shift
// reused across every part of a given creature keeps its internal palette
// contrast (body vs belly vs accent) intact. Glow-flagged parts are left
// untouched so the rarity-tier glow color stays a crisp, consistent tell.
const _jitterColor = new THREE.Color();
const _jitterHsl = { h: 0, s: 0, l: 0 };
function jitterHex(hex, hueShift, lightShift) {
    _jitterColor.set(hex);
    _jitterColor.getHSL(_jitterHsl);
    _jitterColor.setHSL(
        (_jitterHsl.h + hueShift + 1) % 1,
        _jitterHsl.s,
        THREE.MathUtils.clamp(_jitterHsl.l + lightShift, 0.04, 0.96)
    );
    return _jitterColor.getHex();
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
    const finish = ARCHETYPE_FINISH[def.plan] || DEFAULT_FINISH;

    // item 305: one hue/lightness shift for this whole creature instance
    const hueJ = (Math.random() - 0.5) * 0.05;
    const lightJ = (Math.random() - 0.5) * 0.16;

    // Part helper: shared geo/mat, optional rotation & parent attachment
    // (eyes/snouts parented to heads so look-around animation carries them)
    const add = (w, h, d, color, x, y, z, o = {}) => {
        const finalColor = o.glow ? color : jitterHex(color, hueJ, lightJ);
        const mat = creatureMat(finalColor, {
            ...o,
            rough: o.rough != null ? o.rough : finish.rough,
            metal: o.metal != null ? o.metal : finish.metal,
        });
        const mesh = new THREE.Mesh(creatureGeo(w, h, d), mat);
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
