/* ============================================================
   Particles — thin façade over the shared pool (Phase 4b, item 342)
   ------------------------------------------------------------
   The transient point-sprite system now lives in particle-pool.js
   (ONE pooled allocator, no per-burst heap allocation). This module
   keeps the historical entry-point names so every existing call site
   (capture / projectiles / creatures / caves / lava / mountain /
   weather) is unchanged, and it still owns the water-splash ripple
   rings — a separate short-lived Mesh system, not part of the point
   pool.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import {
    initParticlePool, updateParticlePool, emitBurst, emitMote,
} from './particle-pool.js';

// ---- Pooled point-sprite bursts (delegated to particle-pool.js) ----
export const initParticles = initParticlePool;
export const updateParticles = updateParticlePool;

export function spawnParticleBurst(x, y, z, hexColor, count = 16, endColor = null) {
    emitBurst(x, y, z, hexColor, count, endColor);
}

export function spawnTrailMote(x, y, z, hexColor) {
    emitMote(x, y, z, hexColor);
}

/* ============================================================
   Water Splash Ripples & Ground Decals
   ------------------------------------------------------------
   Both are flat, fading rings on a shared geometry (state.rippleGeo,
   built once in terrain.js, disposed once in game.js's teardown) —
   only per-instance material + growth curve differ, so a ground
   "decal" (item 352: scorch/dust/splash mark at a ball's rest point)
   is just a second flavor of the same mesh/array/cleanup path the
   water ripple already used, with zero new teardown surface.
   ============================================================ */
function spawnGroundMark(x, y, z, o) {
    if (!state.scene || !state.rippleGeo) return;
    const mat = new THREE.MeshBasicMaterial({
        color: o.color, transparent: true, opacity: o.opacity, depthWrite: false,
    });
    const ring = new THREE.Mesh(state.rippleGeo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y, z);
    ring.scale.setScalar(o.fromScale);
    ring.renderOrder = o.renderOrder;
    state.scene.add(ring);
    state.ripples.push({ mesh: ring, age: 0, life: o.life, from: o.fromScale, to: o.toScale, fromOpacity: o.opacity });
}

// item 478: sizeMul lets a caller scale the ring to the "weight" of what
// fell in — capture.js sizes it by the caught creature's tier (a bare ball
// vs. a legendary settling in still stays 1x for every OTHER caller: rain
// splashes, the ambient fish-ripple, projectiles.js's own ball-miss splash).
export function spawnWaterRipple(x, z, level = CONFIG.POND_WATER_LEVEL, sizeMul = 1) {
    spawnGroundMark(x, level + 0.03, z, {
        color: 0xcfeffb, opacity: 0.75, fromScale: 0.3 * sizeMul, toScale: 2.9 * sizeMul, life: 0.9,
        renderOrder: 2, // draw after water & foam so the ring never sorts under them
    });
}

// items 466/473: a small "sonar ping"-style expanding ring, precisely
// time-locked to the audio cue that triggers it (echo-locator calls,
// singing-crystal chimes) — a THIRD flavor of the same shared ripple-ring
// mesh/pool/cleanup as the water ripple and ground decal above, just
// floating at an arbitrary world Y (mid-air, not a water/ground surface)
// rather than a fixed one.
export function spawnFxRing(x, y, z, color, opts = {}) {
    spawnGroundMark(x, y, z, {
        color,
        opacity: opts.opacity !== undefined ? opts.opacity : 0.6,
        fromScale: opts.fromScale !== undefined ? opts.fromScale : 0.25,
        toScale: opts.toScale !== undefined ? opts.toScale : 1.8,
        life: opts.life !== undefined ? opts.life : 0.4,
        renderOrder: 3,
    });
}

// item 352: a fading ground-impact mark (scorch/dust/splash ring) at a missed
// ball's final rest point, tinted per surface by the caller (projectiles.js
// picks the color from the local zone palette / water check).
export function spawnGroundDecal(x, y, z, color, opts = {}) {
    spawnGroundMark(x, y + 0.012, z, {
        color,
        opacity: opts.opacity !== undefined ? opts.opacity : 0.5,
        fromScale: opts.fromScale !== undefined ? opts.fromScale : 0.5,
        toScale: opts.toScale !== undefined ? opts.toScale : 1.15,
        life: opts.life !== undefined ? opts.life : CONFIG.DECAL_LIFE,
        renderOrder: 1,
    });
}

export function updateWaterRipples(dt) {
    if (!state.ripples || state.ripples.length === 0) return;
    for (const rp of state.ripples) {
        rp.age += dt;
        const t = rp.age / rp.life;
        if (t >= 1) {
            state.scene.remove(rp.mesh);
            rp.mesh.material.dispose(); // geometry is shared, disposed in destroy()
            rp.dead = true;
            continue;
        }
        const s = rp.from + t * (rp.to - rp.from);
        rp.mesh.scale.set(s, s, 1);
        rp.mesh.material.opacity = rp.fromOpacity * (1 - t);
    }
    state.ripples = state.ripples.filter(rp => !rp.dead);
}
