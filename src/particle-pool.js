/* ============================================================
   Particle pool (Phase 4b, item 342)
   ------------------------------------------------------------
   ONE pooled GPU-particle allocator that every transient particle
   burst in the game draws from — capture pops, ball/creature trail
   motes, splash sprays, cave spores, waterfall mist, lava spit,
   weather splashes. A single fixed-size ring buffer of point sprites
   (CONFIG.PARTICLE_POOL) backs it all: spawning only WRITES into the
   ring (advancing an index and reusing the oldest slot), so there is
   NO per-burst heap allocation and therefore no GC hitching under
   heavy capture/VFX activity.

   Front door (the API 4u's VFX layer builds on):
     initParticlePool()                       build the pool + Points object
     emit(x,y,z, r,g,b, vx,vy,vz, life)       write ONE particle (low-level)
     emitBurst(x,y,z, hexColor, count)        radial spark burst
     emitMote(x,y,z, hexColor)                single slow lofting trail mote
     updateParticlePool(dt)                   integrate + fade the live set
     particlePoolStats()                      {pool, active, spawned}
     disposeParticlePool()                    teardown

   The pool's Points object + typed arrays live on state.particles /
   state.particleData, exactly as the pre-4b particles.js published
   them, so teardown in game.js and every existing call site are
   unaffected. particles.js re-exports the burst API under its old
   names (spawnParticleBurst / spawnTrailMote) so nothing else changes.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';

// Shared colour scratch — reused by every emit so a burst never allocates.
const _col = new THREE.Color();

export function initParticlePool() {
    const n = CONFIG.PARTICLE_POOL;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const alphas = new Float32Array(n);
    const ages = new Float32Array(n);
    const lives = new Float32Array(n);
    const velocities = new Float32Array(n * 3);
    const active = new Uint8Array(n);

    // Park the idle pool far underground (same convention as expired motes) so
    // the black points don't stack up visibly at the origin.
    for (let i = 0; i < n; i++) positions[i * 3 + 1] = -1000;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

    const mat = new THREE.PointsMaterial({
        size: 0.25,
        vertexColors: true,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        sizeAttenuation: true,
    });

    const points = new THREE.Points(geo, mat);
    state.scene.add(points);
    state.particles = points;
    state.particleData = { positions, colors, alphas, ages, lives, velocities, active, next: 0, spawned: 0 };
}

/* ------------------------------------------------------------
   Low-level single-particle write — the ONE allocation front door.
   Reuses the oldest ring slot; never touches the heap.
   ------------------------------------------------------------ */
export function emit(x, y, z, r, g, b, vx, vy, vz, life) {
    const d = state.particleData;
    if (!d) return -1;
    const idx = d.next;
    d.next = (d.next + 1) % CONFIG.PARTICLE_POOL;

    d.positions[idx * 3] = x;
    d.positions[idx * 3 + 1] = y;
    d.positions[idx * 3 + 2] = z;
    d.velocities[idx * 3] = vx;
    d.velocities[idx * 3 + 1] = vy;
    d.velocities[idx * 3 + 2] = vz;
    d.colors[idx * 3] = r;
    d.colors[idx * 3 + 1] = g;
    d.colors[idx * 3 + 2] = b;
    d.alphas[idx] = 1.0;
    d.ages[idx] = 0;
    d.lives[idx] = life;
    d.active[idx] = 1;
    d.spawned++;
    return idx;
}

export function emitBurst(x, y, z, hexColor, count = 16) {
    const d = state.particleData;
    if (!d) return;
    _col.set(hexColor);
    const r = _col.r, g = _col.g, b = _col.b;
    for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const up = Math.random() * 0.7 + 0.3;
        const sp = CONFIG.PARTICLE_SPEED * (0.4 + Math.random() * 0.7);
        emit(x, y, z, r, g, b,
            Math.cos(ang) * sp, up * sp, Math.sin(ang) * sp,
            CONFIG.PARTICLE_LIFE * (0.6 + Math.random() * 0.6));
    }
}

// Single sparkle mote with barely any velocity — chained along a moving ball or
// a sucked-in creature they read as a fading streak trail.
export function emitMote(x, y, z, hexColor) {
    _col.set(hexColor);
    emit(
        x + (Math.random() - 0.5) * 0.09,
        y + (Math.random() - 0.5) * 0.09,
        z + (Math.random() - 0.5) * 0.09,
        _col.r, _col.g, _col.b,
        (Math.random() - 0.5) * 0.5,
        0.9 + Math.random() * 0.6, // slight lift offsets gravity
        (Math.random() - 0.5) * 0.5,
        0.28 + Math.random() * 0.16
    );
}

export function updateParticlePool(dt) {
    const d = state.particleData;
    if (!d) return;
    let any = false;
    for (let i = 0; i < CONFIG.PARTICLE_POOL; i++) {
        if (!d.active[i]) continue;
        any = true;
        d.ages[i] += dt;
        if (d.ages[i] >= d.lives[i]) {
            d.active[i] = 0;
            d.alphas[i] = 0;
            d.positions[i * 3] = 0;
            d.positions[i * 3 + 1] = -1000;
            d.positions[i * 3 + 2] = 0;
            continue;
        }
        d.velocities[i * 3 + 1] += CONFIG.BALL_GRAVITY * dt;
        d.positions[i * 3] += d.velocities[i * 3] * dt;
        d.positions[i * 3 + 1] += d.velocities[i * 3 + 1] * dt;
        d.positions[i * 3 + 2] += d.velocities[i * 3 + 2] * dt;
        d.alphas[i] = 1 - (d.ages[i] / d.lives[i]);
    }
    if (any) {
        state.particles.geometry.attributes.position.needsUpdate = true;
        state.particles.geometry.attributes.color.needsUpdate = true;
        state.particles.geometry.attributes.alpha.needsUpdate = true;
    }
}

export function particlePoolStats() {
    const d = state.particleData;
    if (!d) return { pool: CONFIG.PARTICLE_POOL, active: 0, spawned: 0 };
    let active = 0;
    for (let i = 0; i < CONFIG.PARTICLE_POOL; i++) if (d.active[i]) active++;
    return { pool: CONFIG.PARTICLE_POOL, active, spawned: d.spawned };
}

export function disposeParticlePool() {
    if (state.particles) {
        if (state.scene) state.scene.remove(state.particles);
        const g = state.particles.geometry, m = state.particles.material;
        if (g) { try { g.dispose(); } catch (e) {} }
        if (m) { try { m.dispose(); } catch (e) {} }
        state.particles = null;
    }
    state.particleData = null;
}
