/* ============================================================
   Particle pool (Phase 4b, item 342)
   ------------------------------------------------------------
   ONE pooled GPU-particle allocator that every transient particle
   burst in the game draws from — capture pops, ball/creature trail
   motes, splash sprays, cave spores, waterfall mist, lava spit,
   weather splashes. A ring buffer of point sprites backs it all:
   spawning only WRITES into the ring (advancing an index and
   reusing the oldest slot), so there is NO per-burst heap
   allocation and therefore no GC hitching under heavy capture/VFX
   activity.

   Front door (the API 4u's VFX layer builds on):
     initParticlePool()                       build the pool + Points object
     emit(x,y,z, r,g,b, vx,vy,vz, life, ...)  write ONE particle (low-level)
     emitBurst(x,y,z, hexColor, count, endHex) radial spark burst
     emitMote(x,y,z, hexColor)                single slow lofting trail mote
     updateParticlePool(dt)                   integrate + fade the live set
     particlePoolStats()                      {pool, active, spawned}
     disposeParticlePool()                    teardown

   The pool's Points object + typed arrays live on state.particles /
   state.particleData, exactly as the pre-4b particles.js published
   them, so teardown in game.js and every existing call site are
   unaffected. particles.js re-exports the burst API under its old
   names (spawnParticleBurst / spawnTrailMote) so nothing else changes.

   Backlog items folded in here (world-graphics-improvements.md):
     264  pool size is picked from a tier table (PARTICLE_POOL_HIGH/
          MEDIUM/LOW) instead of one fixed budget, and the pool
          transparently rebuilds itself if state.qualityLevel changes
          later (the FPS auto-scaler stepping the tier up/down) —
          nothing outside this module needs to know or call anything.
     244  each particle now carries a colorEnd it lerps toward over
          its lifetime (not just an alpha fade), so bursts read richer.
     250  emitBurst/emitMote thin their count/rate with distance from
          the camera instead of paying full density at any range.
     268  a burst spawning well outside the view frustum is skipped
          outright (existing live particles keep simulating/fading;
          this only gates brand-new spawns) — a cheap stand-in for
          culling.js's chunk-based system, which only tracks the
          instanced terrain/flora/wall meshes, not this pool.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';

// Shared colour scratch — reused by every emit so a burst never allocates.
const _col = new THREE.Color();
const _colEnd = new THREE.Color();

// Which tier the currently-live pool was sized for (item 264).
let builtTier = null;

function tierPoolSize(tier) {
    if (tier === 'low') return CONFIG.PARTICLE_POOL_LOW;
    if (tier === 'medium') return CONFIG.PARTICLE_POOL_MEDIUM;
    return CONFIG.PARTICLE_POOL_HIGH;
}

function buildPool(n) {
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);      // the LIVE, rendered color (lerped each frame)
    const colorsStart = new Float32Array(n * 3); // item 244: color-over-lifetime endpoints
    const colorsEnd = new Float32Array(n * 3);
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
    state.particleData = {
        positions, colors, colorsStart, colorsEnd, alphas, ages, lives, velocities, active,
        next: 0, spawned: 0, size: n,
    };
}

export function initParticlePool() {
    // quality.js hasn't sampled FPS yet at this point in game.js's init(), but
    // the software-renderer probe (engine.js, via gpu-detect.js) already ran —
    // that's the same signal quality.js itself uses to force the 'low' floor.
    const tier = state.softwareRenderer ? 'low' : (state.qualityLevel || 'high');
    buildPool(tierPoolSize(tier));
    builtTier = tier;
}

// item 264: swap in a differently-sized pool when the live quality tier no
// longer matches the one the pool was built for. Live particles are not
// migrated (a tier change is rare and transitional) — just a fresh pool.
function resizePoolForTier(tier) {
    const oldPoints = state.particles;
    buildPool(tierPoolSize(tier));
    if (oldPoints) {
        if (state.scene) state.scene.remove(oldPoints);
        try { oldPoints.geometry.dispose(); } catch (e) {}
        try { oldPoints.material.dispose(); } catch (e) {}
    }
    builtTier = tier;
}

/* ------------------------------------------------------------
   Low-level single-particle write — the ONE allocation front door.
   Reuses the oldest ring slot; never touches the heap. endR/G/B are
   optional (item 244) — default to a darkened version of the start
   color so every burst reads as "cooling" rather than a flat fade.
   ------------------------------------------------------------ */
export function emit(x, y, z, r, g, b, vx, vy, vz, life, endR, endG, endB) {
    const d = state.particleData;
    if (!d) return -1;
    const idx = d.next;
    d.next = (d.next + 1) % d.size;

    d.positions[idx * 3] = x;
    d.positions[idx * 3 + 1] = y;
    d.positions[idx * 3 + 2] = z;
    d.velocities[idx * 3] = vx;
    d.velocities[idx * 3 + 1] = vy;
    d.velocities[idx * 3 + 2] = vz;
    d.colors[idx * 3] = r;
    d.colors[idx * 3 + 1] = g;
    d.colors[idx * 3 + 2] = b;
    d.colorsStart[idx * 3] = r;
    d.colorsStart[idx * 3 + 1] = g;
    d.colorsStart[idx * 3 + 2] = b;
    d.colorsEnd[idx * 3] = endR !== undefined ? endR : r * 0.35;
    d.colorsEnd[idx * 3 + 1] = endG !== undefined ? endG : g * 0.35;
    d.colorsEnd[idx * 3 + 2] = endB !== undefined ? endB : b * 0.35;
    d.alphas[idx] = 1.0;
    d.ages[idx] = 0;
    d.lives[idx] = life;
    d.active[idx] = 1;
    d.spawned++;
    return idx;
}

/* ------------------------------------------------------------
   Item 250/268 helpers — distance-based thinning + a same-frame-
   cached view-frustum test, so a burst that lands well off-screen
   (a distant weather splash, a cave spore group behind the player)
   doesn't pay full fill-rate for nothing anyone can see.
   ------------------------------------------------------------ */
const _frustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();
const _spawnPoint = new THREE.Vector3();
let _frustumReady = false;

function ensureFrustum() {
    if (_frustumReady) return;
    const cam = state.camera;
    if (!cam) return;
    cam.updateMatrixWorld(); // cheap: recomputes matrixWorldInverse from this frame's pose
    _projScreenMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreenMatrix);
    _frustumReady = true;
}

function cameraDistance(x, y, z) {
    const cam = state.camera;
    if (!cam) return 0;
    const dx = x - cam.position.x, dy = y - cam.position.y, dz = z - cam.position.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// item 268: only gate spawns once they're comfortably past the near LOD ring —
// close-range bursts (capture pops, footwork right at the player) are always
// spawned outright, so nothing near the camera ever pops in/out at the frustum edge.
function offscreenBeyondNear(x, y, z, dist) {
    if (dist <= CONFIG.PARTICLE_LOD_NEAR) return false;
    if (!state.camera) return false;
    ensureFrustum();
    _spawnPoint.set(x, y, z);
    return !_frustum.containsPoint(_spawnPoint);
}

// item 250: thin a burst's particle count with distance instead of full
// density at any range — a distant splash still reads, just sparser.
function lodCount(count, dist) {
    if (dist <= CONFIG.PARTICLE_LOD_NEAR) return count;
    if (dist >= CONFIG.PARTICLE_LOD_FAR) return Math.max(1, Math.round(count * CONFIG.PARTICLE_LOD_MIN_FRACTION));
    const t = (dist - CONFIG.PARTICLE_LOD_NEAR) / (CONFIG.PARTICLE_LOD_FAR - CONFIG.PARTICLE_LOD_NEAR);
    const frac = 1 - t * (1 - CONFIG.PARTICLE_LOD_MIN_FRACTION);
    return Math.max(1, Math.round(count * frac));
}

export function emitBurst(x, y, z, hexColor, count = 16, endColor = null) {
    const d = state.particleData;
    if (!d) return;
    const dist = cameraDistance(x, y, z);
    if (offscreenBeyondNear(x, y, z, dist)) return;
    count = lodCount(count, dist);

    _col.set(hexColor);
    const r = _col.r, g = _col.g, b = _col.b;
    let er, eg, eb;
    if (endColor !== null) {
        _colEnd.set(endColor);
        er = _colEnd.r; eg = _colEnd.g; eb = _colEnd.b;
    }
    for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const up = Math.random() * 0.7 + 0.3;
        const sp = CONFIG.PARTICLE_SPEED * (0.4 + Math.random() * 0.7);
        emit(x, y, z, r, g, b,
            Math.cos(ang) * sp, up * sp, Math.sin(ang) * sp,
            CONFIG.PARTICLE_LIFE * (0.6 + Math.random() * 0.6),
            endColor !== null ? er : undefined, endColor !== null ? eg : undefined, endColor !== null ? eb : undefined);
    }
}

// Single sparkle mote with barely any velocity — chained along a moving ball or
// a sucked-in creature they read as a fading streak trail.
export function emitMote(x, y, z, hexColor) {
    const dist = cameraDistance(x, y, z);
    if (offscreenBeyondNear(x, y, z, dist)) return;
    // item 250: far-but-onscreen motes still thin out probabilistically —
    // scaling a single mote's "count" doesn't apply, so roll for it instead.
    if (dist > CONFIG.PARTICLE_LOD_NEAR) {
        const t = Math.min(1, (dist - CONFIG.PARTICLE_LOD_NEAR) / (CONFIG.PARTICLE_LOD_FAR - CONFIG.PARTICLE_LOD_NEAR));
        const keepChance = 1 - t * (1 - CONFIG.PARTICLE_LOD_MIN_FRACTION);
        if (Math.random() > keepChance) return;
    }
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
    _frustumReady = false; // item 268: refresh once per frame, lazily, on first emit below

    if (builtTier !== null && state.qualityLevel !== builtTier) {
        resizePoolForTier(state.qualityLevel); // item 264
    }

    const d = state.particleData;
    if (!d) return;
    let any = false;
    for (let i = 0; i < d.size; i++) {
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
        const t = d.ages[i] / d.lives[i];
        d.alphas[i] = 1 - t;

        // item 244: color-over-lifetime — lerp the rendered color from the
        // spawn hue toward its (usually darker/cooler) end color.
        const b3 = i * 3;
        d.colors[b3] = d.colorsStart[b3] + (d.colorsEnd[b3] - d.colorsStart[b3]) * t;
        d.colors[b3 + 1] = d.colorsStart[b3 + 1] + (d.colorsEnd[b3 + 1] - d.colorsStart[b3 + 1]) * t;
        d.colors[b3 + 2] = d.colorsStart[b3 + 2] + (d.colorsEnd[b3 + 2] - d.colorsStart[b3 + 2]) * t;
    }
    if (any) {
        state.particles.geometry.attributes.position.needsUpdate = true;
        state.particles.geometry.attributes.color.needsUpdate = true;
        state.particles.geometry.attributes.alpha.needsUpdate = true;
    }
}

export function particlePoolStats() {
    const d = state.particleData;
    if (!d) return { pool: CONFIG.PARTICLE_POOL_HIGH, active: 0, spawned: 0 };
    let active = 0;
    for (let i = 0; i < d.size; i++) if (d.active[i]) active++;
    return { pool: d.size, active, spawned: d.spawned };
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
    builtTier = null; // force a fresh tier pick on the next initParticlePool()
}
