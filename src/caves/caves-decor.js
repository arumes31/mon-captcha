/* ============================================================
   Cave decoration KIT (Phase 2g) — shared infrastructure
   ------------------------------------------------------------
   The rock / crystal / fungi theme packs (caves-rock.js,
   caves-crystals.js, caves-fungi.js) all decorate a cave through
   this kit so their detail lands in the CULLED per-cave layer the
   Phase 2e foundation gives for free:
     - DecorKit batches world-space voxel detail into a handful of
       InstancedMeshes (matte rock, wet-gloss rock, emissive-by-hue)
       and pushes them into the cave's cull record (`rec.aux`), so
       they hide when the player is far and dispose with the cave.
     - per-cave animated / interactive state (hero crystal shimmer,
       singing crystal, proximity glow mushrooms, burstable puffballs,
       ball-strike chimes, glowing floor mats) lives in `decorByCave`,
       driven every frame by `updateDecor` — the single `update` hook
       every theme registers. It only runs while a cave is observed
       (band !== 'far'), so all this animation is free when unseen.

   Geometry note: `state.sharedBoxGeo` is a V-unit cube (V=VOXEL_SIZE),
   so instance scale 1 == V world units. The box helpers here take
   WORLD dimensions and convert (×SC). Custom-geometry meshes (crystal
   facets, needles) scale their own base geometry directly.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { spawnParticleBurst, spawnFxRing } from '../particles.js';
import { playCrystalChime, playSingingCrystal, playSporePoof } from '../audio.js';
// NOTE (item 461): a music.js import was tried here for a beat-synced crystal
// shimmer, but this module sits on heightfield.js's OWN evaluation path
// (heightfield.js -> caves-data.js -> caves-water.js -> caves-decor.js for
// pushAux), and music.js imports zones/zones.js -> heightfield.js — a real
// circular import that threw "Cannot access 'PARTITION' before initialization"
// (heightfield.js's PARTITION export, read by zones.js, wasn't assigned yet).
// Reverted here; the cloud-side half of item 461 lives safely in atmosphere.js
// instead (that module is never on heightfield.js's own load path).

export const V = CONFIG.VOXEL_SIZE;
export const SC = 1 / V;                 // world units -> sharedBoxGeo instance scale

// Interaction radii (world units)
const CHIME_R = 2.3;   // a ball this close to a crystal point chimes it
const PUFF_R = 1.55;   // player / ball this close bursts a puffball
const MUSH_R = 6.5;    // glow-mushroom proximity brighten reach
const SING_R = 9.0;    // singing-crystal glow + tone reach

/* ------------------------------------------------------------
   Per-cave decoration state (keyed by the cave object so the
   theme dispose(cave) hook can find + clear it; mirrored on
   cave._decor for the test probe).
   ------------------------------------------------------------ */
export const decorByCave = new Map();
export function getDecor(cave) { return decorByCave.get(cave); }

export function initDecor(ci, cave) {
    const d = {
        ci, cave,
        hero: null,            // { mesh, mat, baseEmis, sx, sy, sz, phase, halo }
        crystalMats: [],       // instanced-crystal materials to shimmer (userData.base/ph)
        chimePoints: [],       // [{ x, y, z, pick, spark[, singing] }]
        singing: [],           // [{ x, y, z, mat, baseEmis, cd, baseColor, cycle }]
        mushrooms: [],         // [{ x, y, z, mat, baseEmis }]
        puffballs: [],         // [{ x, y, z, mesh, baseScale, spore, burst, regrow, grow }]
        mats: [],              // floor-mat materials (userData.base/ph)
        sparkles: [],          // [{ pts, arr, list }] — orbiting crystal-facet glints (item 149)
        spores: [],            // [{ pts, arr, list }] — fungal spore drift (items 150/156)
        shimmerMats: [],       // [{ mat, base, ph }] — shared subtle shimmer for static emissive props (item 171)
        flash: 0, chimeCd: 0, showPulse: 0,
    };
    decorByCave.set(cave, d);
    cave._decor = d;
    return d;
}

export function disposeDecor(cave) {
    // The meshes themselves live in rec.aux and are disposed by the core cave
    // teardown; here we only drop the animated-state entry.
    decorByCave.delete(cave);
    if (cave) cave._decor = null;
}

/* ------------------------------------------------------------
   Materials.
   ------------------------------------------------------------ */
export function matteMaterial() { return new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.04 }); }
export function glossMaterial() { return new THREE.MeshStandardMaterial({ roughness: 0.13, metalness: 0.45 }); }
export function emissiveMaterial(color, intensity = 1.5, rough = 0.34) {
    return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: rough, metalness: 0.0 });
}

/* ------------------------------------------------------------
   Instanced-mesh builders. Box helpers convert WORLD size -> scale.
   ------------------------------------------------------------ */
const _dummy = new THREE.Object3D();
const _col = new THREE.Color();

export function buildBoxInstances(items, mat, perColor) {
    if (!items.length) return null;
    const mesh = new THREE.InstancedMesh(state.sharedBoxGeo, mat, items.length);
    for (let i = 0; i < items.length; i++) {
        const d = items[i];
        _dummy.position.set(d.x, d.y, d.z);
        _dummy.scale.set(d.sx * SC, d.sy * SC, d.sz * SC);
        _dummy.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        if (perColor && d.color != null) { _col.setHex(d.color); mesh.setColorAt(i, _col); }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false; mesh.receiveShadow = true;
    return mesh;
}

// Custom-geometry instances (crystals, needles). Scale multiplies the base geo
// directly. `geo` becomes owned by the mesh (disposed with it by the core).
export function buildGeoInstances(geo, mat, items) {
    if (!items.length) { geo.dispose(); return null; }
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    for (let i = 0; i < items.length; i++) {
        const d = items[i];
        _dummy.position.set(d.x, d.y, d.z);
        _dummy.scale.set(d.sx, d.sy, d.sz);
        _dummy.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false; mesh.receiveShadow = false;
    return mesh;
}

export function pushAux(rec, mesh) {
    if (!mesh || !state.scene) return mesh;
    state.scene.add(mesh);
    (rec.aux = rec.aux || []).push(mesh);
    return mesh;
}

/* ------------------------------------------------------------
   DecorKit — batches per-cave voxel detail into 1 matte + 1 gloss +
   N emissive-by-hue meshes, all pushed into the culled rec.aux layer.
   All coordinates + sizes are WORLD units.
   ------------------------------------------------------------ */
export class DecorKit {
    constructor(rec) { this.rec = rec; this._matte = []; this._gloss = []; this._emis = new Map(); this.count = 0; }
    rock(x, y, z, w, h, d, color, rx, ry, rz) { this._matte.push({ x, y, z, sx: w, sy: h, sz: d, color, rx, ry, rz }); this.count++; }
    wet(x, y, z, w, h, d, color, rx, ry, rz) { this._gloss.push({ x, y, z, sx: w, sy: h, sz: d, color, rx, ry, rz }); this.count++; }
    emit(color, x, y, z, w, h, d, rx, ry, rz) {
        let a = this._emis.get(color); if (!a) { a = []; this._emis.set(color, a); }
        a.push({ x, y, z, sx: w, sy: h, sz: d, rx, ry, rz }); this.count++;
    }
    // item 171: when a `decor` record is passed, every kit.emit() emissive
    // batch (ore veins, fissures, nests, veins, moss trails, ...) registers a
    // shared subtle shimmer so static-looking props don't read dead next to
    // the more prominent crystal/singing shimmer.
    flush(decor) {
        pushAux(this.rec, buildBoxInstances(this._matte, matteMaterial(), true));
        pushAux(this.rec, buildBoxInstances(this._gloss, glossMaterial(), true));
        for (const [color, items] of this._emis) {
            const mat = emissiveMaterial(color);
            const mesh = buildBoxInstances(items, mat, false);
            pushAux(this.rec, mesh);
            if (mesh && decor) decor.shimmerMats.push({ mat, base: mat.emissiveIntensity, ph: Math.random() * 6 });
        }
    }
}

/* ------------------------------------------------------------
   Tunnel geometry helpers (shared by the dressing modules).
   ------------------------------------------------------------ */
export function perpAt(path, i) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz) || 1;
    return { nx: -tz / l, nz: tx / l, tx: tx / l, tz: tz / l };
}
export function springY(n) { return n.floorY + n.ceilH * 0.42; }
// ceiling height at lateral fraction f = lat/hw in [-1,1]
export function vaultY(n, f) { const sh = n.ceilH * 0.42; return n.floorY + sh + (n.ceilH - sh) * Math.sqrt(Math.max(0, 1 - f * f)); }
// distance from the nearest entrance (0 at a mouth, grows inward)
export function mouthDist(cave, x, z) {
    let best = Infinity;
    for (const e of cave.entrances) best = Math.min(best, Math.hypot(x - e.x, z - e.z));
    return best;
}
// is (x,z) inside the wet cave's pool footprint?
export function inPool(cave, x, z, pad = 0.5) {
    return cave.pool && Math.hypot(x - cave.pool.x, z - cave.pool.z) < cave.pool.r + pad;
}

/* ------------------------------------------------------------
   Per-frame animator — the single `update` hook every theme
   registers. Runs ONLY while the cave is observed (band !== far).
   ------------------------------------------------------------ */
function burstPuffball(pb) {
    pb.burst = true; pb.regrow = 6.5 + Math.random() * 3.5; pb.mesh.visible = false;
    spawnParticleBurst(pb.x, pb.y + 0.16, pb.z, pb.spore, 22);
    spawnParticleBurst(pb.x, pb.y + 0.28, pb.z, 0xe9f0cf, 10);
    if (!state.isPaused) playSporePoof();
}

export function updateDecor(u) {
    const d = getDecor(u.cave);
    if (!d) return;
    const dt = u.dt, t = u.elapsed;
    const cam = state.camera && state.camera.position;

    // chime flash decay + chamber-wide "light show" pulse decay (item 153)
    if (d.flash > 0) d.flash = Math.max(0, d.flash - dt * 2.4);
    if (d.showPulse > 0) d.showPulse = Math.max(0, d.showPulse - dt * 0.55);

    // hero crystal — slow shimmer + gentle scale pulse (+ chime flash); a soft
    // halo sprite (item 147) rides the same pulse so the landmark reads as a
    // faint glow bloom without an extra light.
    if (d.hero) {
        const h = d.hero;
        const s = 1 + 0.035 * Math.sin(t * 0.85 + h.phase);
        h.mesh.scale.set(h.sx * s, h.sy * s, h.sz * s);
        const pulse = 1 + 0.26 * Math.sin(t * 1.05 + h.phase) + 1.1 * d.flash;
        if (h.mat) h.mat.emissiveIntensity = h.baseEmis * pulse;
        if (h.halo) {
            h.halo.scale.setScalar(h.haloScale * (1 + 0.06 * Math.sin(t * 0.85 + h.phase) + 0.2 * d.flash));
            h.halo.material.opacity = h.haloOpacity * (0.85 + 0.15 * Math.sin(t * 0.6 + h.phase));
        }
    }
    // crystal-cluster group shimmer + chime response + the rare synchronized
    // chamber-wide light show (item 153) + a proximity glint that brightens as
    // the player nears (approximates item 154's "catches your own glow" read).
    let nearestChime = 999;
    if (cam && d.chimePoints.length) {
        for (let i = 0; i < d.chimePoints.length; i++) {
            const cp = d.chimePoints[i];
            const dd = Math.hypot(cam.x - cp.x, cam.z - cp.z);
            if (dd < nearestChime) nearestChime = dd;
        }
    }
    const glint = Math.max(0, 1 - nearestChime / 4.5) * 0.35;
    // item 148: a footstep-vibration flicker — correlated with the player's own
    // grounded movement speed, fading out with distance from the cluster, so
    // nearby crystals read as resonant with the player's own footfalls.
    const speed = (cam && state.player && state.player.velocity && state.player.grounded) ? Math.min(1, state.player.velocity.length() / 6) : 0;
    const vib = speed * 0.09 * Math.sin(t * 24) * Math.max(0, 1 - nearestChime / 6);
    for (const m of d.crystalMats) m.emissiveIntensity = m.userData.base * (1 + 0.16 * Math.sin(t * 1.4 + m.userData.ph) + 1.0 * d.flash + 1.6 * d.showPulse + glint + vib);
    // shared subtle shimmer for otherwise-static emissive decor (item 171)
    for (const sm of d.shimmerMats) sm.mat.emissiveIntensity = sm.base * (1 + 0.09 * Math.sin(t * 1.05 + sm.ph));

    // ball-strike chime — only when the player is truly near/inside
    if (u.near && d.chimePoints.length && state.projectiles.length) {
        if (d.chimeCd > 0) d.chimeCd -= dt;
        for (const p of state.projectiles) {
            if (!p.active) continue;
            for (const cp of d.chimePoints) {
                const dx = p.pos.x - cp.x, dy = p.pos.y - cp.y, dz = p.pos.z - cp.z;
                if (dx * dx + dy * dy + dz * dz < CHIME_R * CHIME_R) {
                    if (d.chimeCd <= 0) {
                        playCrystalChime(cp.pick);
                        d.flash = 1; d.chimeCd = 0.12;
                        spawnParticleBurst(cp.x, cp.y, cp.z, cp.spark, 5);
                        // item 473: an actual expanding ripple-ring, precisely on
                        // playCrystalChime's onset — distinct from the general
                        // emissiveIntensity glow pulse (d.flash) above.
                        spawnFxRing(cp.x, cp.y, cp.z, cp.spark, {
                            fromScale: 0.2, toScale: CONFIG.CRYSTAL_CHIME_RIPPLE_SCALE,
                            life: CONFIG.CRYSTAL_CHIME_RIPPLE_LIFE, opacity: 0.55,
                        });
                        // a ball-struck singing crystal starts its own colour-cycle
                        // (item 145) and lights up the whole cluster (item 153)
                        if (cp.singing) { cp.singing.cycle = 1.0; d.showPulse = 1.0; }
                    }
                    break;
                }
            }
        }
    }

    // singing crystal — proximity glow + retriggered soft tone + a colour-cycle
    // pulse (item 145) that decays after any chime hit; the proximity trigger
    // also lights the whole chamber cluster (item 153).
    for (const sc of d.singing) {
        const dist = cam ? Math.hypot(cam.x - sc.x, cam.z - sc.z) : 999;
        const prox = Math.max(0, 1 - dist / SING_R);
        sc.mat.emissiveIntensity = sc.baseEmis * (1 + prox * 2.1) * (1 + 0.13 * Math.sin(t * 2.2));
        if (sc.cycle > 0) {
            sc.cycle = Math.max(0, sc.cycle - dt * 0.6);
            if (sc.baseColor) sc.mat.color.copy(sc.baseColor).offsetHSL(0.12 * Math.sin(sc.cycle * Math.PI * 3), 0.1 * sc.cycle, 0.08 * sc.cycle);
        } else if (sc.baseColor && !sc.mat.color.equals(sc.baseColor)) sc.mat.color.copy(sc.baseColor);
        sc.cd -= dt;
        if (prox > 0.42 && sc.cd <= 0 && !state.isPaused) { playSingingCrystal(); sc.cd = 2.7; sc.cycle = 1.0; d.showPulse = Math.max(d.showPulse, 0.8); }
    }

    // glow mushrooms brighten as the player passes
    for (const mk of d.mushrooms) {
        const dist = cam ? Math.hypot(cam.x - mk.x, cam.z - mk.z) : 999;
        const target = mk.baseEmis * (1 + 2.6 * Math.max(0, 1 - dist / MUSH_R));
        mk.mat.emissiveIntensity += (target - mk.mat.emissiveIntensity) * Math.min(1, dt * 6);
    }

    // glowing floor mats — slow breathing
    for (const mm of d.mats) mm.emissiveIntensity = mm.userData.base * (0.78 + 0.22 * Math.sin(t * 0.65 + mm.userData.ph));

    // orbiting crystal-facet sparkles (item 149) — small Points clouds circling
    // an anchor (hero / geode cluster), only moved while the cave is observed.
    for (const sk of d.sparkles) {
        const L = sk.list, arr = sk.arr;
        for (let i = 0; i < L.length; i++) {
            const s = L[i];
            const a = t * s.sp + s.ph;
            arr[i * 3] = s.ax + Math.cos(a) * s.r;
            arr[i * 3 + 1] = s.ay + Math.sin(a * 0.7 + s.ph) * 0.22;
            arr[i * 3 + 2] = s.az + Math.sin(a) * s.r;
        }
        sk.pts.geometry.attributes.position.needsUpdate = true;
        sk.pts.material.opacity = sk.baseOpacity * (0.6 + 0.4 * Math.abs(Math.sin(t * 1.3 + sk.phase)));
    }

    // fungal spore drift (items 150/156) — slow floaty motes, distinct motion
    // from the orbiting crystal sparkles above.
    for (const sp of d.spores) {
        const L = sp.list, arr = sp.arr;
        for (let i = 0; i < L.length; i++) {
            const m = L[i];
            m.y += m.rise * dt; if (m.y > m.top) m.y = m.base;
            arr[i * 3] = m.x + Math.sin(t * 0.35 + m.ph) * m.amp;
            arr[i * 3 + 1] = m.y;
            arr[i * 3 + 2] = m.z + Math.cos(t * 0.3 + m.ph) * m.amp;
        }
        sp.pts.geometry.attributes.position.needsUpdate = true;
    }

    // puffballs — burst on player / ball contact, slow regrow. NOTE: the core
    // cull pass force-sets every aux mesh visible each frame BEFORE this update
    // runs, so a burst puffball must be re-hidden here every frame until regrow.
    if (u.near) for (const pb of d.puffballs) {
        if (pb.burst) { pb.regrow -= dt; if (pb.regrow <= 0) { pb.burst = false; pb.grow = 0; pb.mesh.visible = true; } else pb.mesh.visible = false; continue; }
        if (pb.grow < 1) { pb.grow = Math.min(1, pb.grow + dt * 0.9); pb.mesh.scale.setScalar(pb.baseScale * pb.grow); }
        let hit = cam && (cam.x - pb.x) ** 2 + (cam.z - pb.z) ** 2 < PUFF_R * PUFF_R && Math.abs(cam.y - pb.y) < 2.4;
        if (!hit) for (const p of state.projectiles) {
            if (!p.active) continue;
            if ((p.pos.x - pb.x) ** 2 + (p.pos.y - pb.y) ** 2 + (p.pos.z - pb.z) ** 2 < PUFF_R * PUFF_R) { hit = true; break; }
        }
        if (hit) burstPuffball(pb);
    }
}
