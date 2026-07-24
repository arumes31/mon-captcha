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

export function spawnParticleBurst(x, y, z, hexColor, count = 16) {
    emitBurst(x, y, z, hexColor, count);
}

export function spawnTrailMote(x, y, z, hexColor) {
    emitMote(x, y, z, hexColor);
}

/* ============================================================
   Water Splash Ripples (expanding fading rings on the pond)
   ============================================================ */
export function spawnWaterRipple(x, z, level = CONFIG.POND_WATER_LEVEL) {
    if (!state.scene || !state.rippleGeo) return;
    const mat = new THREE.MeshBasicMaterial({
        color: 0xcfeffb, transparent: true, opacity: 0.75, depthWrite: false,
    });
    const ring = new THREE.Mesh(state.rippleGeo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, level + 0.03, z);
    ring.scale.setScalar(0.3);
    ring.renderOrder = 2; // draw after water & foam so the ring never sorts under them
    state.scene.add(ring);
    state.ripples.push({ mesh: ring, age: 0, life: 0.9 });
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
        const s = 0.3 + t * 2.6;
        rp.mesh.scale.set(s, s, 1);
        rp.mesh.material.opacity = 0.75 * (1 - t);
    }
    state.ripples = state.ripples.filter(rp => !rp.dead);
}
