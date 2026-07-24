/* ============================================================
   Atmosphere
   ------------------------------------------------------------
   Clouds, ambient life (fireflies, falling leaves, birds),
   points of interest, and the per-frame environment animation
   (wind sway, water flow, drifting clouds).
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { mulberry32 } from './random.js';
import { getTerrainHeight, findDryLand, sampleCave } from './heightfield.js';
import { chunkSetMatrix, chunkFlushDirty } from './culling.js';
import { spawnWaterRipple } from './particles.js';
import { buildCloudShadows, updateCloudShadows, buildGroundDecals, updateGroundDecals, buildPoiDetails, updatePoiDetails } from './atmosphere-fx.js';
import { musicBeatPhase } from './music.js';

// Cave interiors get no outdoor ambience (snow/pollen indoors reads wrong);
// the caves module owns its own drip motes.
function inCaveFootprint(x, z) {
    const cf = sampleCave(x, z);
    return !!cf && cf.lat < cf.hw + 1.1;
}
import { zoneAt } from './zones/zones.js';

// Voxel-style clouds: two flat semi-transparent layers drifting at different
// speeds for cheap parallax. Low clouds catch a faint sunset blush.
export function buildClouds() {
    const V_STEP = CONFIG.VOXEL_SIZE;
    const geo = state.sharedBoxGeo;
    const r = mulberry32(CONFIG.WORLD_SEED ^ 0xc10d);
    const low = state.qualityLevel === 'low';
    // item 400: seed-driven cloud-pattern PERSONALITY, beyond density — shifts
    // the item-438 profile THRESHOLD (below) rather than the roll itself, so
    // the per-cluster `r` draws stay the same shape of distribution but some
    // seeds trend heavily streaky and others heavily puffy/round. Independent
    // stream (own salt) so it never perturbs the `r` sequence above/below.
    const streakRng = mulberry32((CONFIG.WORLD_SEED ^ 0x51c0a1) >>> 0);
    const streakThreshold = Math.max(0.12, Math.min(0.65,
        0.35 + (streakRng() * 2 - 1) * CONFIG.CLOUD_STREAK_BIAS_STRENGTH));
    state.cloudStreakThreshold = streakThreshold; // ?probe-visible confirmation this differs per seed

    const layers = [
        { count: low ? 6 : 12, yMin: 30, ySpan: 8, spread: 70, block: 2.5, color: 0xfff7ea, opacity: 0.68, driftSpeed: 0.05, driftAmp: 6 },
        { count: low ? 3 : 7,  yMin: 42, ySpan: 8, spread: 95, block: 3.4, color: 0xffffff, opacity: 0.42, driftSpeed: 0.03, driftAmp: 10 },
    ];

    state.cloudLayers = [];
    const dummy = new THREE.Object3D();
    // item 8/442: track the biggest clusters' centroids so a handful can cast
    // soft shadow blobs onto the terrain below (see atmosphere-fx.js).
    const shadowCentroids = [];
    let layerIdx = 0;
    for (const layer of layers) {
        const cloudInstances = [];
        for (let i = 0; i < layer.count; i++) {
            const cx = (r() * 2 - 1) * layer.spread;
            const cz = (r() * 2 - 1) * layer.spread;
            const cy = layer.yMin + r() * layer.ySpan;
            // item 438: a few cluster "shapes" beyond one repeated puff — a
            // wider/flatter streaky profile and a taller layered-stack profile,
            // alongside the original round puff, picked per cluster.
            const profile = r();
            const w = profile < streakThreshold ? 7 + Math.floor(r() * 5) : 5 + Math.floor(r() * 6);
            const d = profile < streakThreshold ? 2 + Math.floor(r() * 2) : 3 + Math.floor(r() * 4);
            const stacked = profile > 0.8;
            for (let x = 0; x < w; x++) {
                for (let z = 0; z < d; z++) {
                    if (r() < 0.72) {
                        cloudInstances.push({
                            x: cx + x * V_STEP * layer.block, y: cy + (r() < 0.25 || stacked ? 0.5 : 0), z: cz + z * V_STEP * layer.block,
                            sx: layer.block, sy: stacked ? 0.85 : 0.5, sz: layer.block
                        });
                    }
                }
            }
            if (layerIdx === 0) shadowCentroids.push({ x: cx + (w * V_STEP * layer.block) / 2, z: cz + (d * V_STEP * layer.block) / 2, layer: layerIdx });
        }
        // Unlit material: clouds read as bright sunlit puffs from any angle
        // (a lit material shows its dark underside against the bright sky)
        const cloudMat = new THREE.MeshBasicMaterial({
            color: layer.color, transparent: true, opacity: layer.opacity,
            depthWrite: false, fog: true
        });
        const cloudMesh = new THREE.InstancedMesh(geo, cloudMat, cloudInstances.length);
        cloudMesh.castShadow = false;
        cloudMesh.receiveShadow = false;
        for (let i = 0; i < cloudInstances.length; i++) {
            const c = cloudInstances[i];
            dummy.position.set(c.x, c.y, c.z);
            dummy.scale.set(c.sx, c.sy, c.sz);
            dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix();
            cloudMesh.setMatrixAt(i, dummy.matrix);
        }
        cloudMesh.instanceMatrix.needsUpdate = true;
        state.scene.add(cloudMesh);
        // baseColor/baseOpacity captured once — updateEnvironmentAnim retints
        // toward the current fog colour + darkens under stormy weather (items
        // 11/200/208/439/444) without ever mutating this original recipe.
        state.cloudLayers.push({
            mesh: cloudMesh, driftSpeed: layer.driftSpeed, driftAmp: layer.driftAmp, phase: r() * Math.PI * 2,
            baseColor: new THREE.Color(layer.color), baseOpacity: layer.opacity,
        });
        layerIdx++;
    }
    buildCloudShadows(shadowCentroids);
}

// Small radial-gradient sprite so firefly points render as soft glow dots
// (untextured GL points draw as hard squares).
function makeGlowSprite() {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    state.glowSpriteTex = tex; // tracked for disposal
    return tex;
}

// Ambient life: drifting firefly/pollen motes, falling leaves under the
// canopies, and distant birds circling the arena — all seeded & closed-form
// animated (no per-frame physics state).
export function buildAmbientLife() {
    const r = mulberry32(CONFIG.WORLD_SEED ^ 0xf1f1);
    const half = CONFIG.ARENA_SIZE / 2;

    // --- Fireflies / sunlit pollen motes (additive points; bloom catches them)
    // item 459: the last HOTSPOT_COUNT are clustered tightly around one fixed
    // spot instead of scattered arena-wide — a small collectible-feeling
    // "firefly-swarm" point of interest rather than more uniform ambiance.
    const FLY_COUNT = 80;
    const HOTSPOT_COUNT = 10;
    const hotspotAng = r() * Math.PI * 2, hotspotR = (half - 8) * 0.55;
    const hotspotX = Math.cos(hotspotAng) * hotspotR, hotspotZ = Math.sin(hotspotAng) * hotspotR;
    const flyBase = new Float32Array(FLY_COUNT * 3);
    const flyPhase = new Float32Array(FLY_COUNT);
    const flyPos = new Float32Array(FLY_COUNT * 3);
    for (let i = 0; i < FLY_COUNT; i++) {
        let x = 0, z = 0, d = 0, tries = 0;
        if (i >= FLY_COUNT - HOTSPOT_COUNT) {
            x = hotspotX + (r() * 2 - 1) * 1.6;
            z = hotspotZ + (r() * 2 - 1) * 1.6;
        } else {
            do {
                x = (r() * 2 - 1) * (half - 3);
                z = (r() * 2 - 1) * (half - 3);
                d = Math.sqrt(x * x + z * z);
                tries++;
            } while ((d < CONFIG.POND_RADIUS + 1 || inCaveFootprint(x, z)) && tries < 40);
        }
        // clamp above the water line — inside the pond bowl the terrain height is
        // negative and motes would otherwise sit ON the water as glowing squares
        const h = Math.max(getTerrainHeight(x, z), CONFIG.POND_WATER_LEVEL + 0.3);
        flyBase[i * 3] = x;
        flyBase[i * 3 + 1] = h + 0.4 + r() * 1.8;
        flyBase[i * 3 + 2] = z;
        flyPhase[i] = r() * Math.PI * 2;
        flyPos[i * 3] = x; flyPos[i * 3 + 1] = flyBase[i * 3 + 1]; flyPos[i * 3 + 2] = z;
    }
    const flyGeo = new THREE.BufferGeometry();
    flyGeo.setAttribute('position', new THREE.BufferAttribute(flyPos, 3));
    const flyMat = new THREE.PointsMaterial({
        color: 0xffdf8a, size: 0.11, transparent: true, opacity: 0.85,
        map: makeGlowSprite(), // soft round glow instead of a hard GL point square
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    flyMat.addEventListener('dispose', () => {
        if (state.glowSpriteTex) { try { state.glowSpriteTex.dispose(); } catch (e) {} state.glowSpriteTex = null; }
    });
    const fireflies = new THREE.Points(flyGeo, flyMat);
    fireflies.frustumCulled = false; // positions churn every frame
    state.scene.add(fireflies);
    state.fireflies = fireflies;
    state.fireflyData = { base: flyBase, phase: flyPhase, count: FLY_COUNT };

    // --- Falling leaves spiraling down beneath the tree canopies
    const LEAF_COUNT = 36;
    const leafMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0 });
    const leafMesh = new THREE.InstancedMesh(state.sharedBoxGeo, leafMat, LEAF_COUNT);
    leafMesh.castShadow = false;
    leafMesh.receiveShadow = false;
    leafMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    leafMesh.frustumCulled = false;
    const leafColors = [0xd84315, 0xf57c00, 0xfbc02d, 0x7cb342, 0x9ccc65];
    const tmpColor = new THREE.Color();
    const fallers = [];
    const trees = state.treeList || [{ x: 0, z: -5 }];
    for (let i = 0; i < LEAF_COUNT; i++) {
        const t = trees[Math.floor(r() * trees.length)];
        const topY = getTerrainHeight(t.x, t.z) + 3.2 + r() * 1.5;
        fallers.push({
            ax: t.x + (r() - 0.5) * 3, az: t.z + (r() - 0.5) * 3,
            topY, range: 3 + r() * 2.5,
            speed: 0.09 + r() * 0.08, // cycles per second
            phase: r(), swirl: 0.4 + r() * 0.5,
        });
        tmpColor.setHex(leafColors[Math.floor(r() * leafColors.length)]);
        leafMesh.setColorAt(i, tmpColor);
    }
    if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
    state.scene.add(leafMesh);
    state.fallingLeaves = leafMesh;
    state.fallingLeafData = fallers;

    // --- Distant birds circling high over the valley, plus a couple that
    // cross the sky in a straight line instead of looping (item 441) — reads
    // as a flock passing through rather than every bird patrolling forever.
    const BIRD_COUNT = 5;
    const FLOCK_COUNT = 2;
    const total = BIRD_COUNT + FLOCK_COUNT;
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x3a4150, fog: true }); // soft slate silhouettes
    const birdMesh = new THREE.InstancedMesh(state.sharedBoxGeo, birdMat, total);
    birdMesh.castShadow = false;
    birdMesh.receiveShadow = false;
    birdMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    birdMesh.frustumCulled = false;
    const birds = [];
    for (let i = 0; i < BIRD_COUNT; i++) {
        birds.push({
            radius: 38 + r() * 18,
            height: 26 + r() * 8,
            speed: (0.05 + r() * 0.05) * (r() < 0.5 ? 1 : -1),
            phase: r() * Math.PI * 2,
        });
    }
    for (let i = 0; i < FLOCK_COUNT; i++) {
        const ang = r() * Math.PI * 2;
        birds.push({
            flock: true, crossSpan: half + 25, height: 24 + r() * 10,
            dirX: Math.cos(ang), dirZ: Math.sin(ang), perp: r() * 40 - 20,
            speed: 4 + r() * 2.5, period: 30 + r() * 20, phase: r(),
        });
    }
    state.scene.add(birdMesh);
    state.birdMesh = birdMesh;
    state.birdData = birds;
    state.birdScatterT = 0; // item 451: rare flock-scatter burst, advanced in updateEnvironmentAnim
}

/* ------------------------------------------------------------
   Per-zone ambient particles. Each zone descriptor names a
   particle set (ember / spore / pollen / sparkle = additive glow;
   snow / leaf / mist / dust = soft alpha). Motes are scattered
   across the valley, each keyed to the zone under it, and packed
   into just TWO Points draws (one additive, one soft). Density is
   zone-weighted; the low tier gets far fewer. Closed-form animated
   in updateZoneAmbient (no per-frame physics state).
   ------------------------------------------------------------ */
const ZONE_GLOW_KINDS = { ember: 1, spore: 1, pollen: 1, sparkle: 1 };

function makeSoftSprite() {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    state.zoneSpriteTex = tex; // tracked for disposal
    return tex;
}

export function buildZoneAmbient() {
    const half = CONFIG.ARENA_SIZE / 2;
    const low = state.qualityLevel === 'low';
    const TARGET = low ? 90 : 280;
    const r = mulberry32(CONFIG.WORLD_SEED ^ 0x20e5a1);

    const glow = [];  // additive
    const soft = [];  // alpha
    let placed = 0, attempts = 0;
    const maxAtt = TARGET * 40;
    while (placed < TARGET && attempts < maxAtt) {
        attempts++;
        const x = (r() * 2 - 1) * (half - 2);
        const z = (r() * 2 - 1) * (half - 2);
        if (Math.hypot(x, z) < CONFIG.POND_RADIUS + 1) continue;
        if (inCaveFootprint(x, z)) continue;
        const zone = zoneAt(x, z);
        const spec = zone.particle;
        if (r() > Math.min(1, spec.density / 1.4)) continue; // density-weighted acceptance
        const h = Math.max(getTerrainHeight(x, z), CONFIG.POND_WATER_LEVEL);
        const col = new THREE.Color(spec.color);
        const e = {
            bx: x, bz: z, phase: r(), speed: 0.12 + r() * 0.3, amp: 0.4 + r() * 0.9,
            kind: spec.kind, cr: col.r, cg: col.g, cb: col.b, baseY: h,
        };
        if (spec.kind === 'ember') { e.baseY = h + 0.2; e.rise = 3.0; }
        else if (spec.kind === 'spore') { e.baseY = h + 0.25; e.rise = 2.2; }
        else if (spec.kind === 'snow' || spec.kind === 'leaf') { e.topY = h + 5 + r() * 3.5; e.fall = 5 + r() * 3.5; }
        else e.baseY = h + 0.5 + r() * 1.6; // pollen / sparkle / mist / dust float band
        // item 203: desert dust motes shimmer harder — a cheap heat-haze stand-in
        if (spec.kind === 'dust' && zone.id === 'desert') e.hot = true;
        (ZONE_GLOW_KINDS[spec.kind] ? glow : soft).push(e);
        placed++;
    }

    // item 210: a handful of dedicated "steaming ground" motes over the
    // volcanic zone, reusing the 'mist' animation — opacity keyed to
    // state.weatherWetness so they only show as post-rain ground actually dries.
    let steamPlaced = 0, steamAttempts = 0;
    while (steamPlaced < 8 && steamAttempts < 400) {
        steamAttempts++;
        const x = (r() * 2 - 1) * (half - 2), z = (r() * 2 - 1) * (half - 2);
        if (Math.hypot(x, z) < CONFIG.POND_RADIUS + 1 || inCaveFootprint(x, z)) continue;
        const zone = zoneAt(x, z);
        if (zone.id !== 'volcanic') continue;
        const h = getTerrainHeight(x, z);
        const col = new THREE.Color(0xcdbfae);
        soft.push({ bx: x, bz: z, phase: r(), speed: 0.1 + r() * 0.2, amp: 0.5 + r() * 0.6, kind: 'mist', cr: col.r, cg: col.g, cb: col.b, baseY: h + 0.3, steam: true });
        steamPlaced++;
    }
    // item 456: a few sun-catching glint sparkles over the pond surface
    for (let i = 0; i < 10; i++) {
        const a = r() * Math.PI * 2, rr = r() * (CONFIG.POND_RADIUS - 1);
        const col = new THREE.Color(0xdff3ff);
        glow.push({ bx: Math.cos(a) * rr, bz: Math.sin(a) * rr, phase: r(), speed: 0.2 + r() * 0.3, amp: 0.3 + r() * 0.4, kind: 'sparkle', cr: col.r, cg: col.g, cb: col.b, baseY: CONFIG.POND_WATER_LEVEL + 0.08, pondGlint: true });
    }

    // one shared round sprite for both groups (kept off the firefly texture)
    const sprite = makeSoftSprite();
    state.zoneGlowData = buildParticleGroup(glow, true, sprite);
    state.zoneSoftData = buildParticleGroup(soft, false, sprite);
    buildGroundDecals(); // items 201/209: puddle + snow-drift decals (atmosphere-fx.js)
}

function buildParticleGroup(list, additive, sprite) {
    if (!list.length) return null;
    const n = list.length;
    const pos = new Float32Array(n * 3);
    const colArr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const e = list[i];
        pos[i * 3] = e.bx; pos[i * 3 + 1] = e.baseY != null ? e.baseY : e.topY; pos[i * 3 + 2] = e.bz;
        colArr[i * 3] = e.cr; colArr[i * 3 + 1] = e.cg; colArr[i * 3 + 2] = e.cb;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    const mat = new THREE.PointsMaterial({
        size: additive ? 0.16 : 0.2,
        vertexColors: true,
        map: sprite,
        transparent: true,
        opacity: additive ? 0.9 : 0.6,
        depthWrite: false,
        sizeAttenuation: true,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    state.scene.add(points);
    const mesh = additive ? (state.zoneGlow = points) : (state.zoneSoft = points);
    return { mesh, list, count: n };
}

function updateParticleGroup(data, elapsed, updateColor) {
    if (!data || !data.mesh.visible) return;
    const pos = data.mesh.geometry.attributes.position.array;
    const col = updateColor ? data.mesh.geometry.attributes.color.array : null;
    const list = data.list;
    for (let i = 0; i < data.count; i++) {
        const e = list[i];
        let x = e.bx, y = e.baseY, z = e.bz, fade = 1;
        switch (e.kind) {
            case 'ember':
            case 'spore': {
                const t = (elapsed * e.speed + e.phase) % 1;
                y = e.baseY + t * e.rise;
                x = e.bx + Math.sin(elapsed * 0.8 + e.phase * 20) * e.amp * (0.3 + t);
                z = e.bz + Math.cos(elapsed * 0.7 + e.phase * 13) * e.amp * (0.3 + t);
                fade = Math.sin(Math.PI * t);
                break;
            }
            case 'pollen': {
                y = e.baseY + Math.sin(elapsed * 0.9 + e.phase * 6) * 0.4;
                x = e.bx + Math.sin(elapsed * 0.45 + e.phase * 10) * 0.8;
                z = e.bz + Math.cos(elapsed * 0.4 + e.phase * 7) * 0.8;
                fade = 0.6 + 0.4 * Math.sin(elapsed * 1.5 + e.phase * 6);
                break;
            }
            case 'sparkle': {
                y = e.baseY + Math.sin(elapsed * 1.1 + e.phase * 8) * 0.3;
                x = e.bx + Math.sin(elapsed * 0.6 + e.phase * 12) * 0.5;
                z = e.bz + Math.cos(elapsed * 0.5 + e.phase * 9) * 0.5;
                const s = 0.5 + 0.5 * Math.sin(elapsed * 3 + e.phase * 20);
                fade = s * s;
                // item 456: pond glints only really pop while it's sunny (state.weatherMood)
                if (e.pondGlint) fade *= 0.15 + 0.85 * (state.weatherMood != null ? state.weatherMood : 1);
                break;
            }
            case 'snow': {
                const t = (elapsed * e.speed * 0.3 + e.phase) % 1;
                y = e.topY - t * e.fall;
                x = e.bx + Math.sin(elapsed * 0.6 + e.phase * 17) * e.amp;
                z = e.bz + Math.cos(elapsed * 0.5 + e.phase * 11) * e.amp;
                break;
            }
            case 'leaf': {
                const t = (elapsed * e.speed * 0.22 + e.phase) % 1;
                y = e.topY - t * e.fall;
                x = e.bx + Math.sin(elapsed * 1.4 + e.phase * 17) * (e.amp + 0.6);
                z = e.bz + Math.cos(elapsed * 1.2 + e.phase * 11) * (e.amp + 0.6);
                break;
            }
            case 'mist': {
                y = e.baseY + Math.sin(elapsed * 0.3 + e.phase * 4) * 0.3;
                x = e.bx + Math.sin(elapsed * 0.15 + e.phase * 5) * 2.0;
                z = e.bz + Math.cos(elapsed * 0.12 + e.phase * 3) * 2.0;
                // item 210: "steaming ground" — rises gently and only shows while
                // the volcanic ground is actually wet-from-rain and drying out
                if (e.steam) {
                    const wet = state.weatherWetness || 0;
                    y += ((elapsed * 0.15 + e.phase) % 1) * 1.6;
                    fade = wet;
                }
                break;
            }
            default: { // dust
                // item 203: desert dust motes shimmer faster/wider — a cheap
                // heat-haze stand-in, hidden automatically while it's actively
                // raining/snowing (state.rain/state.snow visibility)
                const hazy = e.hot && !(state.rain && state.rain.visible) && !(state.snow && state.snow.visible);
                const freq = hazy ? 1.8 : 0.5, amp = hazy ? 1.2 : 0.5;
                y = e.baseY + Math.sin(elapsed * freq + e.phase * 8) * amp * (hazy ? 0.35 : 1);
                x = e.bx + Math.sin(elapsed * (hazy ? 1.1 : 0.3) + e.phase * 9) * 1.2;
                z = e.bz + Math.cos(elapsed * (hazy ? 0.9 : 0.25) + e.phase * 6) * 1.2;
                if (hazy) fade = 0.5 + 0.5 * Math.sin(elapsed * 4 + e.phase * 30);
            }
        }
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        if (col) {
            let f = Math.max(0, fade);
            // item 212: dust/mist cool toward the fog colour under overcast/storm
            // moods, echoing the sky/fog tint instead of a fixed particle hue
            if ((e.kind === 'dust' || e.kind === 'mist') && !e.steam) {
                const mood = state.weatherMood != null ? state.weatherMood : 1;
                const cool = 1 - 0.35 * (1 - mood);
                col[i * 3] = e.cr * f * cool; col[i * 3 + 1] = e.cg * f * (cool + 0.02); col[i * 3 + 2] = e.cb * f;
            } else {
                col[i * 3] = e.cr * f; col[i * 3 + 1] = e.cg * f; col[i * 3 + 2] = e.cb * f;
            }
        }
    }
    data.mesh.geometry.attributes.position.needsUpdate = true;
    if (col) data.mesh.geometry.attributes.color.needsUpdate = true;
}

// Points of interest: stone humanoid statue + distant house roof
export function buildPointsOfInterest() {
    const V_STEP = CONFIG.VOXEL_SIZE;
    const geo = state.sharedBoxGeo;
    const dummy = new THREE.Object3D();
    const tmpColor = new THREE.Color();

    // Humanoid statue on far grassy bank center-right beneath a green tree, facing
    // water (nudged aside on seeds that run the river through its spot)
    const statueSpot = findDryLand(9, -11, 1.2);
    const statueX = statueSpot.x, statueZ = statueSpot.z;
    const groundH = getTerrainHeight(statueX, statueZ);
    const statueParts = [
        { x: 0, y: 0.25, z: 0, sx: 0.5, sy: 0.5, sz: 0.3 }, // legs
        { x: 0, y: 0.85, z: 0, sx: 0.45, sy: 0.7, sz: 0.25 }, // torso
        { x: 0, y: 1.45, z: 0, sx: 0.35, sy: 0.35, sz: 0.35 }, // head
        { x: -0.35, y: 0.9, z: 0.05, sx: 0.15, sy: 0.6, sz: 0.15 }, // arm L
        { x: 0.35, y: 0.9, z: 0.05, sx: 0.15, sy: 0.6, sz: 0.15 }, // arm R
    ];
    const statueMat = new THREE.MeshStandardMaterial({ color: 0xcfd3d6, roughness: 0.65, metalness: 0.1 });
    const statueMesh = new THREE.InstancedMesh(geo, statueMat, statueParts.length);
    statueMesh.castShadow = true;
    statueMesh.receiveShadow = true;
    for (let i = 0; i < statueParts.length; i++) {
        const p = statueParts[i];
        dummy.position.set(statueX + p.x, groundH + p.y, statueZ + p.z);
        dummy.scale.set(p.sx, p.sy, p.sz);
        dummy.rotation.set(0, Math.PI, 0); // face the water (toward -z)
        dummy.updateMatrix();
        statueMesh.setMatrixAt(i, dummy.matrix);
    }
    statueMesh.instanceMatrix.needsUpdate = true;
    state.scene.add(statueMesh);
    state.statueMesh = statueMesh;

    // Distant blocky brown house roof peeking over the cliff rim, slightly left of
    // center. Scales are in multiples of the 0.4-unit shared box: each tier is a
    // solid 0.6-unit-thick slab stacked contiguously (no floating air gaps), and
    // the base sits low enough that the rim grounds it against the sky.
    // position derives from ARENA_SIZE so the roof stays BEYOND the rim on any
    // arena, and its height rides the ACTUAL rim terrain at that spot: the base
    // slab tucks below the perimeter wall top (terrain+2.0) so the void beyond
    // the arena never shows under it — only the upper tiers peek over the rim.
    const roofX = -6, roofZ = -(CONFIG.ARENA_SIZE / 2 + 3);
    const rimH = getTerrainHeight(roofX, -(CONFIG.ARENA_SIZE / 2) + 0.4);
    const roofY = rimH + 1.1;
    const roofParts = [
        { x: 0, y: 0, z: 0, sx: 9, sy: 1.5, sz: 6.5 },
        { x: 0, y: 0.6, z: 0, sx: 7.4, sy: 1.5, sz: 5.4 },
        { x: 0, y: 1.2, z: 0, sx: 5.8, sy: 1.5, sz: 4.3 },
    ];
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x8a5a38, roughness: 0.85, metalness: 0.0 });
    const roofMesh = new THREE.InstancedMesh(geo, roofMat, roofParts.length);
    roofMesh.castShadow = false;
    roofMesh.receiveShadow = false;
    for (let i = 0; i < roofParts.length; i++) {
        const p = roofParts[i];
        dummy.position.set(roofX + p.x, roofY + p.y, roofZ + p.z);
        dummy.scale.set(p.sx, p.sy, p.sz);
        dummy.updateMatrix();
        roofMesh.setMatrixAt(i, dummy.matrix);
    }
    roofMesh.instanceMatrix.needsUpdate = true;
    state.scene.add(roofMesh);
    state.roofMesh = roofMesh;

    buildPoiDetails(); // item 449: cairn + campfire vignettes (atmosphere-fx.js)
}

// Reusable transform for environment animation (never allocated per frame)
const envDummy = new THREE.Object3D();

// Wind sway on one precomputed detail instance (index into detailInstances).
// items 206/213: the phase is offset along the current wind direction so a
// gust reads as a wave TRAVELING across the field rather than every blade
// oscillating in unison, and a small constant lean (not just back-and-forth
// oscillation) biases toward the wind direction, strongest during gusts.
function swayInstance(details, i, elapsed, amp) {
    const d = details[i];
    const wind = state.weatherWind || 0;
    const wdir = state.weatherWindDir || { x: 1, z: 0 };
    const travel = (d.x * wdir.x + d.z * wdir.z) * 0.22;
    const phase = (d.x + d.z) * 0.5;
    const lean = wind * 0.1;
    envDummy.position.set(d.x, d.y, d.z);
    envDummy.scale.set(d.sx, d.sy, d.sz);
    envDummy.rotation.set(
        (d.rx || 0) + Math.sin(elapsed * 1.5 + phase - travel) * amp + lean * wdir.x,
        d.ry || 0,
        (d.rz || 0) + Math.cos(elapsed * 1.3 + phase - travel) * amp + lean * wdir.z
    );
    envDummy.updateMatrix();
    // Phase 4b: the detail set is sector-chunked — route the write to the
    // owning chunk (identity map when ?nochunk builds a single mesh).
    chunkSetMatrix(state.detailChunks, i, envDummy.matrix);
}

// Reusable colour scratch for the cloud weather-tint below (never allocated per frame)
const _cloudTint = new THREE.Color();
const _cA_FLASH = new THREE.Color(0xf5f7ff);
let _lastAnimElapsed = 0; // used to derive a cheap per-call dt for the FX below
let _fishRippleAcc = 0;   // item 450: ambient pond-ripple timer

// Wind sway + water flow + ambient life animation.
// Wind touches only the precomputed animated index lists — static instances
// (rocks, trunks, pebbles, ...) are never revisited per frame.
export function updateEnvironmentAnim(elapsed) {
    const dt = _lastAnimElapsed ? Math.max(0, Math.min(0.25, elapsed - _lastAnimElapsed)) : 0.016;
    _lastAnimElapsed = elapsed;

    if (state.water) {
        state.water.material.uniforms['time'].value += 1.0 / 60.0;
    }

    // Shoreline foam: slow rotation + gentle strength pulse
    if (state.foamRing) {
        state.foamRing.rotation.z = elapsed * 0.012;
        state.foamRing.material.opacity = 0.42 + Math.sin(elapsed * 0.8) * 0.1;
    }

    // Multi-layer clouds drifting at different speeds for parallax, retinted
    // toward the current fog colour and darkened under stormy weather (items
    // 11/200/208/439/444) — the darkening/lightning-flash lead the weather
    // transition itself (state.weatherCloudDark/state.weatherFlash), so a
    // storm reads as "clouds building" rather than an instant swap.
    if (state.cloudLayers) {
        const dark = state.weatherCloudDark || 0;
        const flash = state.weatherFlash || 0;
        // item 461: a small nudge toward the active music mood's own
        // pad-breathing rate, so slow cloud drift reads as loosely "in time"
        // with the ambient score — the drift itself (position) is untouched;
        // only the opacity gets the subtle pulse, kept well under the
        // dark/flash terms below so it never reads as a hard strobe.
        const beat = musicBeatPhase() * CONFIG.MUSIC_BEAT_VISUAL_MIX * 0.4;
        for (const layer of state.cloudLayers) {
            layer.mesh.position.x = Math.sin(elapsed * layer.driftSpeed + layer.phase) * layer.driftAmp;
            layer.mesh.position.z = Math.cos(elapsed * layer.driftSpeed * 0.7 + layer.phase) * layer.driftAmp * 0.4;
            _cloudTint.copy(layer.baseColor);
            if (state.scene.fog) _cloudTint.lerp(state.scene.fog.color, Math.min(0.7, dark * 0.8));
            if (flash > 0.05) _cloudTint.lerp(_cA_FLASH, Math.min(0.5, flash));
            layer.mesh.material.color.copy(_cloudTint);
            layer.mesh.material.opacity = layer.baseOpacity * (1 - dark * 0.25) * (1 + beat);
        }
        updateCloudShadows();
    }

    // Wind sway via precomputed instance lists. Weather gusts stiffen the sway
    // (state.weatherWind, published by weather.js) so storms visibly rough up
    // the canopy and grass.
    if (state.detailChunks && state.detailInstances) {
        const details = state.detailInstances;
        const gust = 1 + (state.weatherWind || 0) * 1.6; // calm ~1.0, storm ~2.5x
        let touched = false;
        if (state.windLight && state.windLight.length) {
            for (let n = 0; n < state.windLight.length; n++) {
                swayInstance(details, state.windLight[n], elapsed, 0.08 * gust);
            }
            touched = true;
        }
        // canopy leaves are the bulk of the animated set — skip them on low tier
        if (state.windLeaves && state.windLeaves.length && state.qualityLevel !== 'low') {
            for (let n = 0; n < state.windLeaves.length; n++) {
                swayInstance(details, state.windLeaves[n], elapsed, 0.06 * gust);
            }
            touched = true;
        }
        // upload only the sector chunks touched by the sway this frame
        if (touched) chunkFlushDirty(state.detailChunks);
    }

    // Fireflies / pollen motes drifting on closed-form sine paths
    if (state.fireflies && state.fireflies.visible && state.fireflyData) {
        const fd = state.fireflyData;
        const pos = state.fireflies.geometry.attributes.position.array;
        for (let i = 0; i < fd.count; i++) {
            const ph = fd.phase[i];
            pos[i * 3] = fd.base[i * 3] + Math.sin(elapsed * 0.45 + ph) * 0.8;
            pos[i * 3 + 1] = fd.base[i * 3 + 1] + Math.sin(elapsed * 0.9 + ph * 1.7) * 0.35;
            pos[i * 3 + 2] = fd.base[i * 3 + 2] + Math.cos(elapsed * 0.38 + ph) * 0.8;
        }
        state.fireflies.geometry.attributes.position.needsUpdate = true;
        state.fireflies.material.opacity = 0.6 + Math.sin(elapsed * 2.3) * 0.25; // twinkle
    }

    // Falling leaves: looping spiral descent beneath the canopies
    if (state.fallingLeaves && state.fallingLeaves.visible && state.fallingLeafData) {
        const fallers = state.fallingLeafData;
        for (let i = 0; i < fallers.length; i++) {
            const L = fallers[i];
            const t = (elapsed * L.speed + L.phase) % 1; // normalized fall cycle
            const swirlR = 0.35 + t * L.swirl;
            envDummy.position.set(
                L.ax + Math.cos(elapsed * 1.8 + L.phase * 17) * swirlR,
                L.topY - t * L.range,
                L.az + Math.sin(elapsed * 1.6 + L.phase * 17) * swirlR
            );
            envDummy.scale.set(0.28, 0.05, 0.28);
            envDummy.rotation.set(t * 5, L.phase * 6 + elapsed * 1.5, t * 3);
            envDummy.updateMatrix();
            state.fallingLeaves.setMatrixAt(i, envDummy.matrix);
        }
        state.fallingLeaves.instanceMatrix.needsUpdate = true;
    }

    // Per-zone ambient motes (embers rise, snow falls, mist drifts, …)
    updateParticleGroup(state.zoneGlowData, elapsed, true);
    updateParticleGroup(state.zoneSoftData, elapsed, false);

    // Distant birds circling high over the valley, wings flapping, plus a
    // couple crossing straight through (item 441) and a rare all-flock
    // "scatter" burst — quicker + higher for a few seconds (item 451).
    if (state.birdMesh && state.birdData) {
        const birds = state.birdData;
        if (state.birdScatterT > 0) state.birdScatterT = Math.max(0, state.birdScatterT - dt);
        else if (Math.random() < 0.0006) state.birdScatterT = 3 + Math.random() * 2;
        const scatterK = state.birdScatterT > 0 ? Math.min(1, state.birdScatterT / 1.2) : 0;
        for (let i = 0; i < birds.length; i++) {
            const B = birds[i];
            if (B.flock) {
                const t = ((elapsed * B.speed + B.phase * B.period) % B.period) / B.period;
                const travel = (t - 0.5) * 2 * B.crossSpan;
                const px = -B.dirZ, pz = B.dirX; // perpendicular unit vector
                envDummy.position.set(B.dirX * travel + px * B.perp, B.height + scatterK * 3, B.dirZ * travel + pz * B.perp);
                envDummy.scale.set(1.2, 0.08, 0.36);
                envDummy.rotation.set(0, -Math.atan2(B.dirX, B.dirZ), Math.sin(elapsed * 8 + i * 1.7) * 0.4);
            } else {
                const spd = B.speed * (1 + scatterK * 1.6);
                const a = elapsed * spd + B.phase;
                envDummy.position.set(
                    Math.cos(a) * B.radius,
                    B.height + scatterK * 4 + Math.sin(elapsed * 0.7 + B.phase) * 1.5,
                    Math.sin(a) * B.radius
                );
                envDummy.scale.set(1.35, 0.09, 0.4); // small — distant silhouettes, not floating planks
                envDummy.rotation.set(0, -a, Math.sin(elapsed * 7 + i * 1.3) * 0.45); // flap
            }
            envDummy.updateMatrix();
            state.birdMesh.setMatrixAt(i, envDummy.matrix);
        }
        state.birdMesh.instanceMatrix.needsUpdate = true;
    }

    // items 201/209: puddle fill-in / snow-drift reveal (atmosphere-fx.js)
    updateGroundDecals();
    // items 449/453/454/455/460: cairn+campfire vignette (atmosphere-fx.js)
    updatePoiDetails(elapsed);

    // item 450: occasional ambient ripple on the pond, independent of rain —
    // reads as a fish surfacing, purely decorative (reuses the existing
    // ripple-pool system already disposed by game.js's destroy()).
    _fishRippleAcc += dt;
    if (_fishRippleAcc > 3.2 + Math.sin(elapsed * 0.037) * 1.2 && !state.isPaused) {
        _fishRippleAcc = 0;
        if (Math.random() < 0.5) {
            const a = Math.random() * Math.PI * 2, rr = Math.random() * (CONFIG.POND_RADIUS - 1.5);
            spawnWaterRipple(Math.cos(a) * rr, Math.sin(a) * rr);
        }
    }
}
