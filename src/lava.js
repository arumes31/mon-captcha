/* ============================================================
   Lava River — flowing magma course through the volcanic zone
   ------------------------------------------------------------
   Phase 2c. The volcanic zone's magma is expanded into a winding
   FLOWING lava river that pours out of the vent flank, plus a
   larger lava pool at its head. Everything is draped ON the
   terrain surface (getGroundY) — lava flows sit on the ground,
   so there is no heightfield coupling to keep getGroundY exact.

   Owns:
     - the seeded lava course (polyline from the vent into the
       volcanic sector) + the head pool
     - an emissive, animated crust surface (scrolling glow veins,
       bloom-catching) with scorched margins
     - ember motes drifting up along the banks
     - faint rising heat-shimmer haze (skipped on low)
     - a steam column where the lava meets water (isWaterAt)
     - a no-walk push-back hazard along the whole course
       (lavaAt(); still no health system)
   Low tier: fewer embers, no shimmer, no steam motes — the
   emissive surfaces stay.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { mulberry32 } from './random.js';
import { getGroundY, isWaterAt, VENT, PARTITION } from './heightfield.js';
import { spawnParticleBurst } from './particles.js';
import { weatherCur, weatherNext } from './weather/weather.js';

// Public registry (course polyline + head pool + steam junction), read by the
// ?probe hook and lavaAt below. Empty until buildLava() runs.
export const LAVA = { course: [], pool: null, steam: null };

// Per-crust-instance flow data (item 232) — kept module-side (not on `state`,
// mirroring LAVA/course-only-pure convention) since it is purely a build->update
// handoff for this file's own animation loop, reset every buildLava() call.
let lavaCells = [];
const _flowColor = new THREE.Color();

/* ------------------------------------------------------------
   Seeded course generation — a winding polyline flowing outward
   from the vent into the volcanic sector, halting at the rim or
   where it meets water (that meeting point becomes a steam vent).
   ------------------------------------------------------------ */
function buildLavaCourse() {
    const rng = mulberry32((CONFIG.WORLD_SEED ^ 0x1a7a3c) >>> 0);
    const half = CONFIG.ARENA_SIZE / 2;
    const volBearing = PARTITION.rot + (PARTITION.volcanicSector + 0.5) * PARTITION.sectorWidth;
    // The vent sits near the rim on the mountain flank, so the flow must head
    // INWARD through the volcanic wedge (not outward off the map): aim it from
    // the vent toward a target in the mid volcanic sector, down toward the valley.
    const targetR = (CONFIG.POND_RADIUS + half) * 0.42;
    const tx = Math.cos(volBearing) * targetR, tz = Math.sin(volBearing) * targetR;
    let ang = Math.atan2(tz - VENT.z, tx - VENT.x);

    const nodes = [];
    let x = VENT.x, z = VENT.z;
    let uAcc = 0; // cumulative arc-length from the vent — drives the item 232/235
                  // flow-wave animation and the vent-biased ember concentration
    const N = 9;
    for (let i = 0; i < N; i++) {
        const hw = Math.max(0.95, 2.4 - i * 0.14 + (rng() - 0.5) * 0.3);
        nodes.push({ x, z, hw, u: uAcc });
        ang += (rng() - 0.5) * 0.6;                  // meander
        const step = 3.4 + rng() * 1.6;
        const nx = x + Math.cos(ang) * step, nz = z + Math.sin(ang) * step;
        if (Math.hypot(nx, nz) > half - 4 || Math.hypot(nx, nz) < CONFIG.POND_RADIUS + 2) break;
        if (isWaterAt(nx, nz, 0.6)) {                // met water -> steam junction, then stop
            nodes.push({ x: nx, z: nz, hw: Math.max(0.9, hw - 0.2), water: true, u: uAcc + step });
            LAVA.steam = { x: nx, z: nz };
            break;
        }
        uAcc += step;
        x = nx; z = nz;
    }
    LAVA.course = nodes;
    // bigger lava pool at the head (overlapping the vent), for a larger lava area
    LAVA.pool = { x: VENT.x, z: VENT.z, r: 3.8 };
}

// Idempotent course generator. buildLava() (render pass) runs AFTER buildFlora()
// in the terrain build, so flora asks for the course early via this; it is pure
// (seeded polyline, no scene objects) and buildLava() regenerates it identically.
export function ensureLavaCourse() {
    if (!LAVA.course.length) buildLavaCourse();
    return LAVA.course;
}

// Is (x,z) in the lava river/pool footprint plus a scorch margin? Flora uses
// this to keep trees/grass/props out of the molten course and its burnt banks.
// The default margin (2.2) also keeps most tree CANOPIES — which spread a couple
// of units past the trunk — from overhanging the flow.
export function inLavaFootprint(x, z, margin = 2.2) {
    ensureLavaCourse();
    const lv = lavaAt(x, z);
    return !!lv && lv.lat < lv.hw + margin;
}

/* ------------------------------------------------------------
   Field query for push-back / effects. Nearest of the course
   segments and the head pool. Returns null when far from lava.
   ------------------------------------------------------------ */
export function lavaAt(x, z) {
    const nodes = LAVA.course;
    let best = null;
    for (let i = 0; i < nodes.length - 1; i++) {
        const a = nodes[i], b = nodes[i + 1];
        const abx = b.x - a.x, abz = b.z - a.z;
        const len2 = abx * abx + abz * abz || 1e-6;
        let s = ((x - a.x) * abx + (z - a.z) * abz) / len2;
        if (s < 0) s = 0; else if (s > 1) s = 1;
        const px = a.x + abx * s, pz = a.z + abz * s;
        const lat = Math.hypot(x - px, z - pz);
        const hw = a.hw + (b.hw - a.hw) * s;
        const u = (a.u !== undefined && b.u !== undefined) ? a.u + (b.u - a.u) * s : undefined;
        if (!best || lat - hw < best.lat - best.hw) best = { lat, hw, projX: px, projZ: pz, u };
    }
    const pool = LAVA.pool;
    if (pool) {
        const lat = Math.hypot(x - pool.x, z - pool.z);
        if (!best || lat - pool.r < best.lat - best.hw) best = { lat, hw: pool.r, projX: pool.x, projZ: pool.z };
    }
    if (!best) return null;
    best.inside = best.lat < best.hw;
    return best;
}

/* ------------------------------------------------------------
   Build — called from buildTerrain after the mountain features.
   The flowing surface is rendered as emissive VOXEL cubes that
   conform to the terrain (getGroundY per column), so the lava
   never clips through the blocky ground the way a flat ribbon
   did on the steep vent flank — and it reads as molten voxels,
   in keeping with the world's look.
   ------------------------------------------------------------ */
export function buildLava() {
    LAVA.course = []; LAVA.pool = null; LAVA.steam = null;
    lavaCells = [];
    buildLavaCourse();
    const nodes = LAVA.course;
    if (nodes.length < 2) return;
    const V = CONFIG.VOXEL_SIZE;

    // bounding box over the course + head pool
    let minX = LAVA.pool.x - LAVA.pool.r, maxX = LAVA.pool.x + LAVA.pool.r;
    let minZ = LAVA.pool.z - LAVA.pool.r, maxZ = LAVA.pool.z + LAVA.pool.r;
    for (const n of nodes) {
        minX = Math.min(minX, n.x - n.hw - 0.5); maxX = Math.max(maxX, n.x + n.hw + 0.5);
        minZ = Math.min(minZ, n.z - n.hw - 0.5); maxZ = Math.max(maxZ, n.z + n.hw + 0.5);
    }
    const half = CONFIG.ARENA_SIZE / 2 - 1;
    const cells = [];
    const crustR = mulberry32((CONFIG.WORLD_SEED ^ 0xba5a17) >>> 0);
    for (let x = minX; x <= maxX; x += V) {
        for (let z = minZ; z <= maxZ; z += V) {
            if (Math.abs(x) > half || Math.abs(z) > half) continue;
            const lv = lavaAt(x, z);
            if (!lv || !lv.inside) continue;
            const y = getGroundY(x, z) + V * 0.15;   // molten crust sitting just proud
            const jit = (crustR() - 0.5) * 0.08;
            // item 232 (flow animation): course cells carry lv.u (arc-length along
            // the course) so the per-frame update can sweep a brightness wave
            // downstream; pool cells have no u, so a radial wave (a slow "boil")
            // stands in instead.
            const flowU = lv.u !== undefined ? lv.u : null;
            const radial = flowU === null ? Math.hypot(x - LAVA.pool.x, z - LAVA.pool.z) : 0;
            cells.push({ x, y, z, jit, flowU, radial });
        }
    }
    if (cells.length) {
        const mat = new THREE.MeshStandardMaterial({
            color: 0x330f06, emissive: 0xff5a18, emissiveIntensity: 1.8, roughness: 0.85, metalness: 0.0,
        });
        const mesh = new THREE.InstancedMesh(state.sharedBoxGeo, mat, cells.length);
        mesh.castShadow = false; mesh.receiveShadow = false;
        const dummy = new THREE.Object3D();
        const col = new THREE.Color();
        for (let i = 0; i < cells.length; i++) {
            const c = cells[i];
            dummy.position.set(c.x, c.y, c.z);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
            // dark basalt crust base tone, jittered — the uniform emissive is the glow
            col.setRGB(0.20 + c.jit, 0.06 + c.jit * 0.4, 0.03);
            mesh.setColorAt(i, col);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        state.scene.add(mesh);
        state.lavaRiver = mesh;
        lavaCells = cells;
    }

    // item 231: warm bounce point-lights along the course so nearby rock/steam
    // pick up lava glow beyond the emissive crust surface itself. Skipped
    // entirely on a confirmed software renderer (state.softwareRenderer, set by
    // engine.js before the world builds) rather than only gated live, so a weak
    // device never pays for the light objects at all; still re-checked live
    // against state.qualityLevel each frame in case FPS sampling steps down.
    if (!state.softwareRenderer) {
        const lights = [];
        const poolLight = new THREE.PointLight(0xff6a2a, 2.2, 9, 2);
        poolLight.position.set(LAVA.pool.x, getGroundY(LAVA.pool.x, LAVA.pool.z) + 1.3, LAVA.pool.z);
        state.scene.add(poolLight);
        lights.push(poolLight);
        const midNode = nodes[Math.floor(nodes.length / 2)];
        if (midNode) {
            const courseLight = new THREE.PointLight(0xff5a1f, 1.6, 7, 2);
            courseLight.position.set(midNode.x, getGroundY(midNode.x, midNode.z) + 1.0, midNode.z);
            state.scene.add(courseLight);
            lights.push(courseLight);
        }
        state.lavaBounceLights = lights;
    } else {
        state.lavaBounceLights = [];
    }

    // --- ember motes drifting up along the banks (closed-form loop) ---
    const EN = 40;
    const epos = new Float32Array(EN * 3);
    const seedR = mulberry32((CONFIG.WORLD_SEED ^ 0xe1b005) >>> 0);
    const embers = [];
    for (let i = 0; i < EN; i++) {
        // item 235: bias segment choice toward LOW index (nearer the vent) so
        // ember density visibly concentrates at the source rather than
        // spreading flat across the whole course.
        const seg = Math.min(nodes.length - 2, Math.floor(Math.pow(seedR(), 1.7) * (nodes.length - 1)));
        const a = nodes[seg], b = nodes[seg + 1], s = seedR();
        const bx = a.x + (b.x - a.x) * s, bz = a.z + (b.z - a.z) * s;
        embers.push({
            bx: bx + (seedR() * 2 - 1) * a.hw, bz: bz + (seedR() * 2 - 1) * a.hw,
            baseY: getGroundY(bx, bz) + 0.2, speed: 0.18 + seedR() * 0.28,
            phase: seedR(), sway: 0.4 + seedR() * 0.7,
        });
        epos[i * 3 + 1] = -1000;
    }
    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute('position', new THREE.BufferAttribute(epos, 3));
    const eMat = new THREE.PointsMaterial({
        color: 0xffb050, size: 0.17, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const emberPts = new THREE.Points(eGeo, eMat);
    emberPts.frustumCulled = false;
    state.scene.add(emberPts);
    state.lavaEmbers = emberPts;
    state.lavaEmberData = embers;

    // --- heat-shimmer haze: faint additive sprites rising over the flow ---
    const HN = 22;
    const hpos = new Float32Array(HN * 3);
    const haze = [];
    for (let i = 0; i < HN; i++) {
        const seg = Math.min(nodes.length - 2, Math.floor(seedR() * (nodes.length - 1)));
        const a = nodes[seg], b = nodes[seg + 1], s = seedR();
        const bx = a.x + (b.x - a.x) * s, bz = a.z + (b.z - a.z) * s;
        haze.push({ bx, bz, baseY: getGroundY(bx, bz) + 0.3, speed: 0.1 + seedR() * 0.12, phase: seedR() });
        hpos[i * 3 + 1] = -1000;
    }
    const hGeo = new THREE.BufferGeometry();
    hGeo.setAttribute('position', new THREE.BufferAttribute(hpos, 3));
    const hMat = new THREE.PointsMaterial({
        color: 0xff8c4a, size: 1.5, transparent: true, opacity: 0.09,
        map: makeHazeSprite(), blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const hazePts = new THREE.Points(hGeo, hMat);
    hazePts.frustumCulled = false;
    state.scene.add(hazePts);
    state.lavaHaze = hazePts;
    state.lavaHazeData = haze;
    state.lavaHazeTex = hMat.map;

    // --- steam column where lava meets water ---
    if (LAVA.steam) {
        buildSteamColumn(LAVA.steam);
        buildMoltenReflection(LAVA.steam); // item 241
    }

    // --- item 240: ash-fall drifting over the course, shown only while the
    //     volcanic zone's weather sits in 'overcast' (distinct from the
    //     rising ember/haze — these motes fall) ---
    buildAshFall(minX, maxX, minZ, maxZ);
}

// item 241: a soft warm glow patch on the adjacent water surface at the
// steam junction — molten light reflecting off the nearest water feature.
function buildMoltenReflection(pt) {
    const y = Math.max(getGroundY(pt.x, pt.z), CONFIG.POND_WATER_LEVEL) + 0.03;
    const geo = new THREE.CircleGeometry(1.7, 20);
    const mat = new THREE.MeshBasicMaterial({
        color: 0xff6a2a, transparent: true, opacity: 0.32,
        blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pt.x, y, pt.z);
    mesh.renderOrder = 2;
    state.scene.add(mesh);
    state.lavaGlowReflection = mesh;
}

// item 240: ash motes — same closed-form-loop Points technique as the embers/
// haze above, but falling (not rising) and only visible in 'overcast' weather.
function buildAshFall(minX, maxX, minZ, maxZ) {
    const AN = 26;
    const apos = new Float32Array(AN * 3);
    const seedR = mulberry32((CONFIG.WORLD_SEED ^ 0xa54a11) >>> 0);
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const spanX = Math.max(6, (maxX - minX) / 2 + 3), spanZ = Math.max(6, (maxZ - minZ) / 2 + 3);
    const motes = [];
    for (let i = 0; i < AN; i++) {
        motes.push({
            ox: (seedR() * 2 - 1) * spanX, oz: (seedR() * 2 - 1) * spanZ,
            topY: getGroundY(cx, cz) + 5 + seedR() * 3, speed: 0.5 + seedR() * 0.5,
            phase: seedR(), sway: 0.3 + seedR() * 0.5,
        });
        apos[i * 3 + 1] = -1000;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(apos, 3));
    const mat = new THREE.PointsMaterial({
        color: 0x8a8378, size: 0.13, transparent: true, opacity: 0.55,
        map: makeHazeSprite(), blending: THREE.NormalBlending, depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.visible = false;
    state.scene.add(pts);
    state.lavaAsh = pts;
    state.lavaAshData = { motes, cx, cz };
    state.lavaAshTex = mat.map;
}

function makeHazeSprite() {
    const s = 32;
    const cv = document.createElement('canvas'); cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.8)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
}

function buildSteamColumn(pt) {
    const SN = 30;
    const spos = new Float32Array(SN * 3);
    const seedR = mulberry32((CONFIG.WORLD_SEED ^ 0x57ea00) >>> 0);
    const puffs = [];
    const baseY = Math.max(getGroundY(pt.x, pt.z), CONFIG.POND_WATER_LEVEL) + 0.1;
    for (let i = 0; i < SN; i++) {
        puffs.push({ ox: (seedR() * 2 - 1) * 0.8, oz: (seedR() * 2 - 1) * 0.8, speed: 0.14 + seedR() * 0.16, phase: seedR(), sway: 0.6 + seedR() * 0.9 });
        spos[i * 3 + 1] = -1000;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(spos, 3));
    const mat = new THREE.PointsMaterial({
        color: 0xf2f0ec, size: 1.1, transparent: true, opacity: 0.4,
        map: makeHazeSprite(), blending: THREE.NormalBlending, depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    state.scene.add(pts);
    state.lavaSteam = pts;
    state.lavaSteamData = { puffs, baseY };
    state.lavaSteamTex = mat.map;
}

/* ------------------------------------------------------------
   Per-frame update — flow scroll, emissive pulse, embers, haze,
   steam, and the push-back hazard. Called from the game loop.
   ------------------------------------------------------------ */
export function updateLava(dt, elapsed) {
    if (!state.lavaRiver && !LAVA.course.length) return;
    const low = state.qualityLevel === 'low';

    // molten glow pulse (two beating sines read as a slow flowing shimmer)
    const glowPulse = 1.7 + Math.sin(elapsed * 1.4) * 0.35 + Math.sin(elapsed * 0.7 + 1.1) * 0.2;
    if (state.lavaRiver) {
        state.lavaRiver.material.emissiveIntensity = glowPulse;
    }

    // item 232: traveling brightness wave across the crust instances — the
    // closest thing to a scrolling-UV "flow" look available without a shared
    // lava texture (each voxel is a solid instance color, not UV-mapped).
    if (state.lavaRiver && lavaCells.length) {
        const mesh = state.lavaRiver;
        for (let i = 0; i < lavaCells.length; i++) {
            const c = lavaCells[i];
            const phase = c.flowU !== null ? c.flowU * 0.55 - elapsed * 2.0 : c.radial * 1.2 - elapsed * 1.6;
            const wave = 0.82 + 0.18 * (Math.sin(phase) * 0.5 + 0.5);
            _flowColor.setRGB((0.20 + c.jit) * wave, (0.06 + c.jit * 0.4) * wave, 0.03 * wave);
            mesh.setColorAt(i, _flowColor);
        }
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    // items 233/239: rare popping-bubble bursts at the crust surface (skipped
    // on 'low' — matches the file's existing low-tier "fewer particles" rule)
    if (!low && !state.isPaused && lavaCells.length && Math.random() < 0.035) {
        const c = lavaCells[(Math.random() * lavaCells.length) | 0];
        spawnParticleBurst(c.x, c.y + 0.12, c.z, 0xffb35a, 2 + ((Math.random() * 2) | 0));
    }

    // item 231: bounce lights stay live-gated to the CURRENT tier (not just the
    // build-time softwareRenderer check) so an FPS-driven step-down to 'low'
    // also turns these off.
    if (state.lavaBounceLights && state.lavaBounceLights.length) {
        const on = state.qualityLevel !== 'low';
        for (const lgt of state.lavaBounceLights) lgt.visible = on;
    }

    // item 241: molten reflection patch on the adjacent water, pulsing with
    // the same glow beat as the crust itself
    if (state.lavaGlowReflection) {
        state.lavaGlowReflection.material.opacity = 0.22 + (glowPulse - 1.35) * 0.22;
    }

    // embers
    if (state.lavaEmbers && state.lavaEmberData) {
        state.lavaEmbers.visible = true;
        const n = low ? Math.floor(state.lavaEmberData.length * 0.4) : state.lavaEmberData.length;
        const arr = state.lavaEmbers.geometry.attributes.position.array;
        const embers = state.lavaEmberData;
        for (let i = 0; i < embers.length; i++) {
            if (i >= n) { arr[i * 3 + 1] = -1000; continue; }
            const e = embers[i];
            const t = (elapsed * e.speed + e.phase) % 1;
            arr[i * 3] = e.bx + Math.sin(elapsed * 0.9 + e.phase * 17) * e.sway * t;
            arr[i * 3 + 1] = e.baseY + t * 2.4;
            arr[i * 3 + 2] = e.bz + Math.cos(elapsed * 0.8 + e.phase * 23) * e.sway * t;
        }
        state.lavaEmbers.geometry.attributes.position.needsUpdate = true;
        state.lavaEmbers.material.opacity = 0.55 + Math.sin(elapsed * 3.5) * 0.25;
    }

    // heat shimmer (hidden on low)
    if (state.lavaHaze && state.lavaHazeData) {
        state.lavaHaze.visible = !low;
        if (!low) {
            const arr = state.lavaHaze.geometry.attributes.position.array;
            const haze = state.lavaHazeData;
            for (let i = 0; i < haze.length; i++) {
                const e = haze[i];
                const t = (elapsed * e.speed + e.phase) % 1;
                arr[i * 3] = e.bx + Math.sin(elapsed * 1.3 + e.phase * 12) * 0.5 * (0.4 + t);
                arr[i * 3 + 1] = e.baseY + t * 3.0;
                arr[i * 3 + 2] = e.bz + Math.cos(elapsed * 1.1 + e.phase * 9) * 0.5 * (0.4 + t);
            }
            state.lavaHaze.geometry.attributes.position.needsUpdate = true;
        }
    }

    // steam column (hidden on low; occasional white burst too)
    if (state.lavaSteam && state.lavaSteamData) {
        state.lavaSteam.visible = !low;
        if (!low) {
            // item 238: heavier steam while rain actually hits the hot flow —
            // ties precipitation state to the steam column's density/opacity.
            const wc = weatherCur(), wn = weatherNext();
            const raining = wc === 'rain' || wc === 'thunderstorm' || wn === 'rain' || wn === 'thunderstorm';
            const rainBoost = raining ? 1.7 : 1.0;
            const arr = state.lavaSteam.geometry.attributes.position.array;
            const { puffs, baseY } = state.lavaSteamData;
            const sx = LAVA.steam.x, sz = LAVA.steam.z;
            for (let i = 0; i < puffs.length; i++) {
                const e = puffs[i];
                const t = (elapsed * e.speed + e.phase) % 1;
                arr[i * 3] = sx + e.ox + Math.sin(elapsed * 0.6 + e.phase * 15) * e.sway * t;
                arr[i * 3 + 1] = baseY + t * 4.2;
                arr[i * 3 + 2] = sz + e.oz + Math.cos(elapsed * 0.5 + e.phase * 11) * e.sway * t;
            }
            state.lavaSteam.geometry.attributes.position.needsUpdate = true;
            state.lavaSteam.material.opacity = Math.min(0.62, (0.32 + Math.sin(elapsed * 2.1) * 0.12) * rainBoost);
            if (!state.isPaused && Math.random() < 0.04 * rainBoost) {
                spawnParticleBurst(sx + (Math.random() - 0.5), baseY + 0.2, sz + (Math.random() - 0.5), 0xf0f0ea, 2);
            }
        }
    }

    // item 240: ash-fall drift, visible only while the local weather sits in
    // 'overcast' (falls DOWN toward the ground, unlike the rising ember/haze)
    if (state.lavaAsh && state.lavaAshData) {
        const overcastish = weatherCur() === 'overcast' || weatherNext() === 'overcast';
        state.lavaAsh.visible = !low && overcastish;
        if (!low && overcastish) {
            const arr = state.lavaAsh.geometry.attributes.position.array;
            const { motes, cx, cz } = state.lavaAshData;
            for (let i = 0; i < motes.length; i++) {
                const m = motes[i];
                const t = (elapsed * m.speed + m.phase) % 1; // 0 at top -> 1 at ground
                arr[i * 3] = cx + m.ox + Math.sin(elapsed * 0.5 + m.phase * 13) * m.sway;
                arr[i * 3 + 1] = m.topY - t * 5.5;
                arr[i * 3 + 2] = cz + m.oz + Math.cos(elapsed * 0.45 + m.phase * 11) * m.sway;
            }
            state.lavaAsh.geometry.attributes.position.needsUpdate = true;
        }
    }

    // push-back hazard along the whole course (scenic; no health)
    if (state.controls && state.player.velocity) {
        const p = state.controls.getObject().position;
        const lv = lavaAt(p.x, p.z);
        if (lv && lv.lat < lv.hw + 0.7) {
            const push = (lv.hw + 0.7 - lv.lat) * 26 * dt;
            let dx = p.x - lv.projX, dz = p.z - lv.projZ;
            const dl = Math.hypot(dx, dz) || 0.001;
            state.player.velocity.x += (dx / dl) * push * 10;
            state.player.velocity.z += (dz / dl) * push * 10;
        }
    }
}

/* ------------------------------------------------------------
   Teardown
   ------------------------------------------------------------ */
function disposeObj(o) {
    if (!o) return;
    if (state.scene) state.scene.remove(o);
    if (o.geometry) { try { o.geometry.dispose(); } catch (e) {} }
    if (o.material) { try { o.material.dispose(); } catch (e) {} }
}

export function disposeLava() {
    disposeObj(state.lavaRiver); state.lavaRiver = null;
    disposeObj(state.lavaEmbers); state.lavaEmbers = null;
    disposeObj(state.lavaHaze); state.lavaHaze = null;
    disposeObj(state.lavaSteam); state.lavaSteam = null;
    disposeObj(state.lavaAsh); state.lavaAsh = null;
    disposeObj(state.lavaGlowReflection); state.lavaGlowReflection = null;
    if (state.lavaBounceLights) { for (const l of state.lavaBounceLights) disposeObj(l); state.lavaBounceLights = null; }
    state.lavaEmberData = null; state.lavaHazeData = null; state.lavaSteamData = null; state.lavaAshData = null;
    if (state.lavaHazeTex) { try { state.lavaHazeTex.dispose(); } catch (e) {} state.lavaHazeTex = null; }
    if (state.lavaSteamTex) { try { state.lavaSteamTex.dispose(); } catch (e) {} state.lavaSteamTex = null; }
    if (state.lavaAshTex) { try { state.lavaAshTex.dispose(); } catch (e) {} state.lavaAshTex = null; }
    lavaCells = [];
    LAVA.course = []; LAVA.pool = null; LAVA.steam = null;
}
