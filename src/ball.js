/* ============================================================
   Capture Ball — shared voxel ball asset & glow helpers
   ------------------------------------------------------------
   One set of cached geometries/materials builds every ball in
   the game: the held viewmodel ball, the thrown projectile and
   the grounded ball of the catch sequence. Voxel-styled: box
   slices approximating a sphere — warm coral-red crown, cream
   base, emissive gold equator band + center button (the bloom
   pass catches the gold rim). Never dispose per-ball; caches
   are torn down once via disposeBallCaches().
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';

// ---- Shared caches (ball layer only) ----
const ballGeoCache = new Map();   // "w,h,d" -> BoxGeometry
const ballMatCache = new Map();   // key -> MeshStandardMaterial
let glowTexture = null;           // radial-gradient CanvasTexture
let glowSpriteMat = null;         // shared additive sprite material

function ballGeo(w, h, d) {
    const key = w.toFixed(4) + ',' + h.toFixed(4) + ',' + d.toFixed(4);
    let g = ballGeoCache.get(key);
    if (!g) { g = new THREE.BoxGeometry(w, h, d); ballGeoCache.set(key, g); }
    return g;
}

function ballMat(color, o = {}) {
    const key = color + '|' + (o.glow || 0) + '|' + (o.glowI || 0) + '|' + (o.rough || 0);
    let m = ballMatCache.get(key);
    if (!m) {
        m = new THREE.MeshStandardMaterial({
            color,
            roughness: o.rough !== undefined ? o.rough : 0.42,
            metalness: o.metal !== undefined ? o.metal : 0.12,
        });
        if (o.glow) {
            m.emissive = new THREE.Color(o.glow);
            m.emissiveIntensity = o.glowI || 1;
        }
        ballMatCache.set(key, m);
    }
    return m;
}

/* ------------------------------------------------------------
   The ball itself — 6 box slices stack into a voxel sphere:
   coral-red top half, cream bottom half, a slightly proud gold
   band riding the equator and a gold button with a white-hot
   core facing +Z (the "front" of the ball).
   ------------------------------------------------------------ */
export function makeCaptureBall(opts = {}) {
    const R = CONFIG.BALL_RADIUS;
    const group = new THREE.Group();
    const shadow = opts.shadow !== false;

    // gentle self-glow keeps both halves warm even on the shaded side.
    // Phase 2k item 83: the cave-found "grotto ball" is the same voxel shape in a
    // cool crystal-teal material variant so it reads distinct in the hand/flight.
    const cave = opts.variant === 'cave';
    const RED = cave
        ? ballMat(0x2fb6c8, { glow: 0x5ff0e0, glowI: 0.3 })                // crystal-teal crown
        : ballMat(0xd94f35, { glow: 0xff5a3c, glowI: 0.14 });             // warm coral-red crown
    const CREAM = cave
        ? ballMat(0xd8f4ee, { glow: 0xbfeee6, glowI: 0.16, rough: 0.4 })  // pale glacier base
        : ballMat(0xf4e6c8, { glow: 0xffe2b8, glowI: 0.1, rough: 0.45 }); // cream base
    const GOLD = cave
        ? ballMat(0x8fe0d0, { glow: 0x9ffff0, glowI: 0.6, rough: 0.24, metal: 0.4 })
        : ballMat(0xd9a441, { glow: 0xffb84d, glowI: 0.45, rough: 0.3, metal: 0.35 });
    const CORE = cave
        ? ballMat(0xeafffb, { glow: 0xcffff6, glowI: 1.8, rough: 0.18 })
        : ballMat(0xfff3d6, { glow: 0xffe9b0, glowI: 1.6, rough: 0.2 });

    const slices = 6;
    const h = (R * 2) / slices;
    for (let i = 0; i < slices; i++) {
        const yc = -R + (i + 0.5) * h;
        const w = Math.max(2 * Math.sqrt(Math.max(R * R - yc * yc, 0)) * 0.96, R * 0.52);
        const mesh = new THREE.Mesh(ballGeo(w, h * 1.02, w), i >= slices / 2 ? RED : CREAM);
        mesh.position.y = yc;
        if (shadow) mesh.castShadow = true;
        group.add(mesh);
    }

    // Gold equator band — slightly wider than the fattest slice so it reads
    // as a proud rim from every angle (and gives bloom a ring to catch)
    const bandW = 2 * R * 0.96 * 1.06;
    const band = new THREE.Mesh(ballGeo(bandW, h * 0.62, bandW), GOLD);
    if (shadow) band.castShadow = true;
    group.add(band);

    // Center button: gold frame + white-hot core (a bloom point)
    const btn = new THREE.Mesh(ballGeo(R * 0.5, R * 0.5, R * 0.16), GOLD);
    btn.position.set(0, 0, R * 0.94);
    group.add(btn);
    const core = new THREE.Mesh(ballGeo(R * 0.24, R * 0.24, R * 0.1), CORE);
    core.position.set(0, 0, R * 1.02);
    group.add(core);

    return group;
}

/* ------------------------------------------------------------
   Glow helpers — one shared radial-gradient texture drives the
   projectile point-glow sprite (shared material) and the catch
   flash sprites (per-flash materials, disposed by capture.js).
   ------------------------------------------------------------ */
export function getGlowTexture() {
    if (!glowTexture) {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.35, 'rgba(255,255,255,0.5)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 64, 64);
        glowTexture = new THREE.CanvasTexture(c);
    }
    return glowTexture;
}

// Soft warm point-glow riding the flying ball (shared material — never
// dispose per-ball; skipped entirely on the 'low' quality tier)
export function makeBallGlowSprite() {
    if (!glowSpriteMat) {
        glowSpriteMat = new THREE.SpriteMaterial({
            map: getGlowTexture(), color: 0xffc27a, transparent: true, opacity: 0.55,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
    }
    const s = new THREE.Sprite(glowSpriteMat);
    s.scale.setScalar(CONFIG.BALL_RADIUS * 5.5);
    return s;
}

// Impact/success flash sprite — material is unique (caller animates its
// opacity and MUST dispose it when the flash dies)
export function makeFlashSprite(color, scale) {
    const mat = new THREE.SpriteMaterial({
        map: getGlowTexture(), color, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const s = new THREE.Sprite(mat);
    s.scale.setScalar(scale);
    return s;
}

// Balls share cached geo/materials — removing one never disposes anything
export function removeBall(group) {
    if (group && group.parent) group.parent.remove(group);
}

// Shared caches are disposed exactly once, on teardown
export function disposeBallCaches() {
    for (const g of ballGeoCache.values()) { try { g.dispose(); } catch (e) {} }
    ballGeoCache.clear();
    for (const m of ballMatCache.values()) { try { m.dispose(); } catch (e) {} }
    ballMatCache.clear();
    if (glowSpriteMat) { try { glowSpriteMat.dispose(); } catch (e) {} glowSpriteMat = null; }
    if (glowTexture) { try { glowTexture.dispose(); } catch (e) {} glowTexture = null; }
}
