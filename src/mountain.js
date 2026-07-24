/* ============================================================
   Mountain Features — waterfall, spring basin & magma vent
   ------------------------------------------------------------
   The mountain's SHAPE lives in heightfield.js; this module owns
   its dressing:
     - the waterfall ribbon draped down the rock face (scrolling
       procedural streak texture), spray bursts + ripples at the
       plunge pool, and the looping rush sound whose volume falls
       off with the player's distance
     - the elevated spring-basin pool surface
     - the magma vent: emissive lava disk (bloom catches it),
       lazily rising ember motes (own additive Points loop) and a
       gentle no-walk push-back so the player never stands in it
   Ember/spray extras are skipped on the 'low' quality tier.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { mulberry32 } from './random.js';
import { getTerrainHeight, getGroundY, getBasinLevel, getVentFloor, WATERFALL, BASIN, VENT, BORDER_FALL } from './heightfield.js';
import { spawnParticleBurst, spawnWaterRipple } from './particles.js';
import { startWaterfallLoop, setWaterfallVolume } from './audio.js';

/* ------------------------------------------------------------
   Build — called from buildTerrain (step 5.5)
   ------------------------------------------------------------ */
export function buildMountainFeatures() {
    buildBasinPool();
    buildWaterfall();
    buildBorderWaterfall();
    buildMagmaVent();
    startWaterfallLoop(); // silent until the player nears the falls
    state.sprayAcc = 0;
    state.borderSprayAcc = 0;
}

/* ------------------------------------------------------------
   Border waterfall — the MAIN river's source: a wide sheet
   pouring in over the perimeter cliff into the plunge pool.
   Taller and broader than the mountain cascade.
   ------------------------------------------------------------ */
function buildBorderWaterfall() {
    const poolY = CONFIG.POND_WATER_LEVEL + 0.06;
    const lipGround = getTerrainHeight(BORDER_FALL.lipX, BORDER_FALL.lipZ);
    const top = { x: BORDER_FALL.lipX, z: BORDER_FALL.lipZ, y: lipGround + 2.6 }; // just over the wall crest
    const bot = { x: BORDER_FALL.poolX, z: BORDER_FALL.poolZ, y: poolY };
    let px = -(bot.z - top.z), pz = bot.x - top.x;
    const pl = Math.hypot(px, pz) || 1;
    px /= pl; pz /= pl;
    const HALF_W = BORDER_FALL.width * 0.92;   // wide sheet

    const SEGS = 14;
    const positions = [], uvs = [], indices = [];
    for (let i = 0; i <= SEGS; i++) {
        const t = i / SEGS;
        const x = THREE.MathUtils.lerp(top.x, bot.x, t);
        const z = THREE.MathUtils.lerp(top.z, bot.z, t);
        const yLine = THREE.MathUtils.lerp(top.y, bot.y, t * t * (3 - 2 * t)); // ease down the cliff
        const y = Math.max(yLine, getTerrainHeight(x, z) + 0.16);
        positions.push(x - px * HALF_W, y, z - pz * HALF_W, x + px * HALF_W, y, z + pz * HALF_W);
        uvs.push(0, t * 3.2, 1, t * 3.2);
        if (i < SEGS) { const a = i * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
        map: makeFallTexture(), color: 0xe4f4fd, transparent: true,
        opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
    });
    const falls = new THREE.Mesh(geo, mat);
    falls.renderOrder = 2;
    state.scene.add(falls);
    state.borderFallMesh = falls;
    state.borderFallTex = mat.map;

    const foamGeo = new THREE.CircleGeometry(BORDER_FALL.width + 0.6, 24);
    const foamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false });
    const foam = new THREE.Mesh(foamGeo, foamMat);
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(bot.x, CONFIG.POND_WATER_LEVEL + 0.05, bot.z);
    foam.renderOrder = 2;
    state.scene.add(foam);
    state.borderFallFoam = foam;
}

// Elevated spring pool inside the basin (simple tinted disc — the big
// reflective Water plane only serves the main 0-level network)
function buildBasinPool() {
    const geo = new THREE.CircleGeometry(BASIN.r + 0.35, 28);
    const mat = new THREE.MeshStandardMaterial({
        color: 0x2d8fa3, roughness: 0.15, metalness: 0.1,
        transparent: true, opacity: 0.82,
        emissive: 0x0c2f38, emissiveIntensity: 0.5,
    });
    const pool = new THREE.Mesh(geo, mat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(BASIN.x, getBasinLevel() + 0.02, BASIN.z);
    state.scene.add(pool);
    state.basinPool = pool;
}

// Vertical streak texture for the falling water (repeat-wrapped so the
// per-frame offset.y scroll reads as falling)
function makeFallTexture() {
    const w = 64, h = 256;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    const r = mulberry32(CONFIG.WORLD_SEED ^ 0xfa11);
    for (let i = 0; i < 46; i++) { // long soft streaks
        const x = r() * w;
        const y0 = r() * h;
        const len = 60 + r() * 160;
        const wid = 1.5 + r() * 3.5;
        const grad = g.createLinearGradient(0, y0, 0, y0 + len);
        const a = 0.25 + r() * 0.5;
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.5, `rgba(240,250,255,${a})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(x, y0, wid, len);
        if (y0 + len > h) g.fillRect(x, y0 - h, wid, len); // wrap seam
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex; // caller tracks the texture for disposal
}

// Ribbon draped from the basin lip down the rock face to the plunge pool
function buildWaterfall() {
    const top = { x: WATERFALL.lipX, z: WATERFALL.lipZ, y: getBasinLevel() + 0.05 };
    const bot = { x: WATERFALL.poolX, z: WATERFALL.poolZ, y: CONFIG.POND_WATER_LEVEL + 0.06 };
    // ribbon side direction: perpendicular to the fall line
    let px = -(bot.z - top.z), pz = bot.x - top.x;
    const pl = Math.hypot(px, pz) || 1;
    px /= pl; pz /= pl;
    const HALF_W = 0.8;

    const SEGS = 10;
    const positions = [];
    const uvs = [];
    const indices = [];
    for (let i = 0; i <= SEGS; i++) {
        const t = i / SEGS;
        const x = THREE.MathUtils.lerp(top.x, bot.x, t);
        const z = THREE.MathUtils.lerp(top.z, bot.z, t);
        // ease-in drop hugging the face, held just proud of the rock
        const yLine = THREE.MathUtils.lerp(top.y, bot.y, t * t * (3 - 2 * t));
        const y = Math.max(yLine, getTerrainHeight(x, z) + 0.14);
        positions.push(x - px * HALF_W, y, z - pz * HALF_W, x + px * HALF_W, y, z + pz * HALF_W);
        uvs.push(0, t * 2.4, 1, t * 2.4);
        if (i < SEGS) {
            const a = i * 2;
            indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
        map: makeFallTexture(),
        color: 0xdff2fb,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const falls = new THREE.Mesh(geo, mat);
    falls.renderOrder = 2;
    state.scene.add(falls);
    state.waterfallMesh = falls;
    state.fallTex = mat.map;

    // static foam pad where the falls hit the pool
    const foamGeo = new THREE.CircleGeometry(1.5, 20);
    const foamMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false,
    });
    const foam = new THREE.Mesh(foamGeo, foamMat);
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(bot.x, CONFIG.POND_WATER_LEVEL + 0.045, bot.z);
    foam.renderOrder = 2;
    state.scene.add(foam);
    state.waterfallFoam = foam;
}

/* ------------------------------------------------------------
   Magma vent — lava disc + closed-form rising ember points
   ------------------------------------------------------------ */
function buildMagmaVent() {
    const floorY = getVentFloor();

    const lavaGeo = new THREE.CircleGeometry(VENT.r, 24);
    const lavaMat = new THREE.MeshStandardMaterial({
        color: 0xff5a1f,
        emissive: 0xff4a12,
        emissiveIntensity: 2.1, // bloom catches the pocket
        roughness: 0.9,
    });
    const lava = new THREE.Mesh(lavaGeo, lavaMat);
    lava.rotation.x = -Math.PI / 2;
    lava.position.set(VENT.x, floorY + 0.12, VENT.z);
    state.scene.add(lava);
    state.lavaMesh = lava;

    // ember motes: fixed pool animated in closed form (phase loops)
    const N = 26;
    const pos = new Float32Array(N * 3);
    const seedR = mulberry32(CONFIG.WORLD_SEED ^ 0xe3be5);
    const embers = [];
    for (let i = 0; i < N; i++) {
        embers.push({
            ox: (seedR() * 2 - 1) * VENT.r * 0.8,
            oz: (seedR() * 2 - 1) * VENT.r * 0.8,
            speed: 0.16 + seedR() * 0.22,      // cycles per second
            phase: seedR(),
            sway: 0.5 + seedR() * 0.8,
        });
        pos[i * 3 + 1] = -1000;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
        color: 0xffa040, size: 0.16, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    state.scene.add(points);
    state.emberPoints = points;
    state.emberData = { embers, baseY: floorY + 0.15 };
}

/* ------------------------------------------------------------
   Per-frame update — ribbon scroll, spray, embers, lava pulse,
   waterfall volume, magma push-back. Called from the game loop.
   ------------------------------------------------------------ */
export function updateMountainFeatures(dt, elapsed) {
    const low = state.qualityLevel === 'low';

    // falling-water scroll + breathing opacity
    if (state.waterfallMesh) {
        state.waterfallMesh.material.map.offset.y -= dt * 1.35;
        state.waterfallMesh.material.opacity = 0.8 + Math.sin(elapsed * 3.1) * 0.06;
    }
    if (state.waterfallFoam) {
        state.waterfallFoam.material.opacity = 0.34 + Math.sin(elapsed * 4.3) * 0.08;
        const s = 1 + Math.sin(elapsed * 2.2) * 0.06;
        state.waterfallFoam.scale.set(s, s, 1);
    }

    // border waterfall sheet scroll + breathing
    if (state.borderFallMesh) {
        state.borderFallMesh.material.map.offset.y -= dt * 1.5;
        state.borderFallMesh.material.opacity = 0.84 + Math.sin(elapsed * 2.7) * 0.07;
    }
    if (state.borderFallFoam) {
        state.borderFallFoam.material.opacity = 0.38 + Math.sin(elapsed * 3.6) * 0.09;
        const s = 1 + Math.sin(elapsed * 1.9) * 0.07;
        state.borderFallFoam.scale.set(s, s, 1);
    }

    // spray bursts + ripples at both plunge pools (skipped on 'low')
    if (!low && !state.isPaused) {
        state.sprayAcc = (state.sprayAcc || 0) + dt;
        if (state.sprayAcc > 0.16) {
            state.sprayAcc = 0;
            const jx = (Math.random() - 0.5) * 1.4, jz = (Math.random() - 0.5) * 1.4;
            spawnParticleBurst(WATERFALL.poolX + jx, CONFIG.POND_WATER_LEVEL + 0.12, WATERFALL.poolZ + jz, 0xeaf6ff, 2);
            if (Math.random() < 0.3) spawnWaterRipple(WATERFALL.poolX + jx, WATERFALL.poolZ + jz);
        }
        state.borderSprayAcc = (state.borderSprayAcc || 0) + dt;
        if (state.borderSprayAcc > 0.1) { // heavier spray at the big border falls
            state.borderSprayAcc = 0;
            const jx = (Math.random() - 0.5) * BORDER_FALL.width * 1.5;
            const jz = (Math.random() - 0.5) * BORDER_FALL.width * 1.5;
            spawnParticleBurst(BORDER_FALL.poolX + jx, CONFIG.POND_WATER_LEVEL + 0.14, BORDER_FALL.poolZ + jz, 0xeaf6ff, 3);
            if (Math.random() < 0.35) spawnWaterRipple(BORDER_FALL.poolX + jx, BORDER_FALL.poolZ + jz);
        }
    }

    // lava glow pulse
    if (state.lavaMesh) {
        state.lavaMesh.material.emissiveIntensity = 1.9 + Math.sin(elapsed * 1.7) * 0.5;
    }

    // rising embers (closed-form loop; hidden on 'low')
    if (state.emberPoints && state.emberData) {
        state.emberPoints.visible = !low;
        if (!low) {
            const arr = state.emberPoints.geometry.attributes.position.array;
            const { embers, baseY } = state.emberData;
            for (let i = 0; i < embers.length; i++) {
                const e = embers[i];
                const t = (elapsed * e.speed + e.phase) % 1;
                arr[i * 3] = VENT.x + e.ox + Math.sin(elapsed * 0.9 + e.phase * 17) * e.sway * t;
                arr[i * 3 + 1] = baseY + t * 2.6;
                arr[i * 3 + 2] = VENT.z + e.oz + Math.cos(elapsed * 0.8 + e.phase * 23) * e.sway * t;
            }
            state.emberPoints.geometry.attributes.position.needsUpdate = true;
            state.emberPoints.material.opacity = 0.55 + Math.sin(elapsed * 3.7) * 0.25;
        }
    }

    // player interactions: waterfall loudness + magma push-back
    if (state.controls) {
        const p = state.controls.getObject().position;
        const dFall = Math.hypot(p.x - WATERFALL.poolX, p.z - WATERFALL.poolZ);
        const dBorder = Math.hypot(p.x - BORDER_FALL.poolX, p.z - BORDER_FALL.poolZ);
        const k = THREE.MathUtils.clamp(1 - dFall / 30, 0, 1);
        const kb = THREE.MathUtils.clamp(1 - dBorder / 34, 0, 1);
        setWaterfallVolume(Math.max(0.3 * k * k, 0.4 * kb * kb)); // louder near the big falls

        // scenic hazard: standing in the vent just nudges you back out
        const dvx = p.x - VENT.x, dvz = p.z - VENT.z;
        const dv = Math.hypot(dvx, dvz);
        if (dv < VENT.r + 0.7 && state.player.velocity) {
            const push = (VENT.r + 0.7 - dv) * 26 * dt;
            const inv = 1 / (dv || 0.001);
            state.player.velocity.x += dvx * inv * push * 10;
            state.player.velocity.z += dvz * inv * push * 10;
        }
    }
}

/* ------------------------------------------------------------
   Teardown
   ------------------------------------------------------------ */
function disposeMesh(mesh) {
    if (!mesh) return;
    if (state.scene) state.scene.remove(mesh);
    if (mesh.geometry) { try { mesh.geometry.dispose(); } catch (e) {} }
    if (mesh.material) { try { mesh.material.dispose(); } catch (e) {} }
}

export function disposeMountainFeatures() {
    disposeMesh(state.basinPool); state.basinPool = null;
    disposeMesh(state.waterfallMesh); state.waterfallMesh = null;
    disposeMesh(state.waterfallFoam); state.waterfallFoam = null;
    disposeMesh(state.borderFallMesh); state.borderFallMesh = null;
    disposeMesh(state.borderFallFoam); state.borderFallFoam = null;
    disposeMesh(state.lavaMesh); state.lavaMesh = null;
    disposeMesh(state.emberPoints); state.emberPoints = null;
    state.emberData = null;
    if (state.fallTex) { try { state.fallTex.dispose(); } catch (e) {} state.fallTex = null; }
    if (state.borderFallTex) { try { state.borderFallTex.dispose(); } catch (e) {} state.borderFallTex = null; }
    if (state.waterfallSrc) { try { state.waterfallSrc.stop(); } catch (e) {} state.waterfallSrc = null; }
    state.waterfallGain = null;
}
