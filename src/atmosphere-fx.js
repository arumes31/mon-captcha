/* ============================================================
   Atmosphere FX — extra ambient/weather-reactive visuals split out
   of atmosphere.js to keep that file under the project's soft line
   cap (same split-by-concern pattern as weather/daynight.js).
   ------------------------------------------------------------
   Everything exported here is called FROM atmosphere.js's own
   already-wired build/update functions (buildClouds/buildZoneAmbient/
   buildPointsOfInterest/updateEnvironmentAnim) — nothing here is a
   new call site into game.js/terrain.js, so no other file needs
   touching to use it.

   Dispose note: the 3 small InstancedMeshes built here (cloud-shadow
   blobs — items 8/442, ground decals: puddles/snow-drift — items
   201/209, POI detail props — item 449) all reuse state.sharedBoxGeo
   (already disposed in game.js's teardown) and each owns exactly one
   small material. game.js's destroy() disposes atmosphere.js's
   objects by name and isn't in this agent's file scope to extend, so
   a destroy()/init() cycle (not exercised by the standard test
   suite, only the one-off tests/leak.mjs audit) would leak those 3
   materials + 2 point lights. Flagged here for whoever next edits
   game.js's teardown list.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { getTerrainHeight, findDryLand } from './heightfield.js';
import { spawnParticleBurst } from './particles.js';

const _dummy = new THREE.Object3D();
const _tmpColor = new THREE.Color();

/* ------------------------------------------------------------
   Cloud shadow blobs (items 8/442): soft dark patches drifting
   over the terrain in lockstep with a handful of the biggest cloud
   clusters, so clouds read as physically there.
   ------------------------------------------------------------ */
export function buildCloudShadows(centroids) {
    if (state.qualityLevel === 'low' || !centroids || !centroids.length) return;
    const n = Math.min(CONFIG.CLOUD_SHADOW_COUNT, centroids.length);
    const picked = centroids.slice(0, n);
    const mat = new THREE.MeshBasicMaterial({ color: 0x14181c, transparent: true, opacity: 0.16, depthWrite: false });
    const mesh = new THREE.InstancedMesh(state.sharedBoxGeo, mat, n);
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    state.scene.add(mesh);
    state.cloudShadowMesh = mesh;
    state.cloudShadowData = picked;
}

export function updateCloudShadows() {
    const mesh = state.cloudShadowMesh, data = state.cloudShadowData, layers = state.cloudLayers;
    if (!mesh || !data || !layers || !layers.length) return;
    for (let i = 0; i < data.length; i++) {
        const c = data[i];
        const layer = layers[c.layer] || layers[0];
        const wx = c.x + layer.mesh.position.x, wz = c.z + layer.mesh.position.z;
        const h = getTerrainHeight(wx, wz) + 0.04;
        _dummy.position.set(wx, h, wz);
        _dummy.scale.set(7, 0.06, 5.4);
        _dummy.rotation.set(0, 0, 0);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
}

/* ------------------------------------------------------------
   Ground decals — puddles that fill in with rain (item 201) and
   snow-drift mounds at a few tree bases (item 209). Combined into
   ONE instanced mesh; per-instance "reveal" is faked with a scale
   tween (0 = hidden) since InstancedMesh has no cheap per-instance
   opacity — a common, cheap trick.
   ------------------------------------------------------------ */
export function buildGroundDecals() {
    const half = CONFIG.ARENA_SIZE / 2;
    const entries = [];
    for (let i = 0; i < CONFIG.PUDDLE_COUNT; i++) {
        let x, z, tries = 0;
        do { x = (Math.random() * 2 - 1) * (half - 4); z = (Math.random() * 2 - 1) * (half - 4); tries++; }
        while (Math.hypot(x, z) < CONFIG.POND_RADIUS + 2 && tries < 20);
        const h = getTerrainHeight(x, z);
        entries.push({ x, z, y: h + 0.02, kind: 'puddle', revealAt: 0.15 + Math.random() * 0.55, color: 0x4c6270, sx: 0.9 + Math.random() * 0.6, sz: 0.7 + Math.random() * 0.5, scale: 0 });
    }
    const trees = state.treeList || [];
    const n = Math.min(CONFIG.SNOW_DRIFT_COUNT, trees.length);
    for (let i = 0; i < n; i++) {
        const t = trees[Math.floor(Math.random() * trees.length)];
        const h = getTerrainHeight(t.x, t.z);
        const a = Math.random() * Math.PI * 2, d = 0.6 + Math.random() * 0.4;
        entries.push({ x: t.x + Math.cos(a) * d, z: t.z + Math.sin(a) * d, y: h + 0.05, kind: 'snow', revealAt: 0, color: 0xf3f6fa, sx: 0.7 + Math.random() * 0.3, sz: 0.6 + Math.random() * 0.3, scale: 0 });
    }
    if (!entries.length) return;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.05 });
    const mesh = new THREE.InstancedMesh(state.sharedBoxGeo, mat, entries.length);
    mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < entries.length; i++) {
        _tmpColor.setHex(entries[i].color);
        mesh.setColorAt(i, _tmpColor);
        _dummy.position.set(entries[i].x, entries[i].y, entries[i].z);
        _dummy.scale.set(0.0001, 0.0001, 0.0001);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    state.scene.add(mesh);
    state.groundDecalMesh = mesh;
    state.groundDecalData = entries;
}

export function updateGroundDecals() {
    const mesh = state.groundDecalMesh, data = state.groundDecalData;
    if (!mesh || !data) return;
    const wetness = state.weatherWetness || 0;
    const snowOn = !!(state.snow && state.snow.visible && state.snow.material.opacity > 0.15);
    let touched = false;
    for (let i = 0; i < data.length; i++) {
        const e = data[i];
        const target = e.kind === 'puddle'
            ? Math.max(0, Math.min(1, (wetness - e.revealAt) / (1 - e.revealAt + 0.001)))
            : (snowOn ? 1 : 0);
        const prev = e.scale;
        e.scale += (target - e.scale) * 0.04; // slow reveal, not an instant pop
        if (Math.abs(e.scale - prev) < 0.0002 && e.scale < 0.005 && target < 0.005) continue;
        touched = true;
        const s = Math.max(0.0001, e.scale);
        _dummy.position.set(e.x, e.y, e.z);
        _dummy.scale.set(e.sx * s, 0.04 * s, e.sz * s);
        _dummy.rotation.set(0, 0, 0);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
    }
    if (touched) mesh.instanceMatrix.needsUpdate = true;
}

/* ------------------------------------------------------------
   Extra points-of-interest detail (item 449): a stone cairn +
   a campfire ring, beyond the existing statue/roof landmarks.
   The campfire's PointLight emphasises it (item 453), flickers as
   a cheap "life sign" (item 460, visual-only), and reacts to
   weather/time — dim in the rain, brighter at night (item 455).
   First-approach sparkle (item 454) tracked in poiDiscoverList,
   reset each buildPoiDetails() call (i.e. once per init()).
   ------------------------------------------------------------ */
const poiDiscoverList = [];

export function buildPoiDetails() {
    const parts = [];
    const cairnSpot = findDryLand(-16, 6, 1.0);
    const ch = getTerrainHeight(cairnSpot.x, cairnSpot.z);
    const cairnSizes = [0.62, 0.5, 0.4, 0.3];
    let cy = ch;
    for (let i = 0; i < cairnSizes.length; i++) {
        const s = cairnSizes[i];
        cy += s * 0.5 + (i ? cairnSizes[i - 1] * 0.06 : 0);
        parts.push({ x: cairnSpot.x + (Math.random() * 0.1 - 0.05), y: cy, z: cairnSpot.z + (Math.random() * 0.1 - 0.05), sx: s, sy: s * 0.55, sz: s, color: 0x8f9296 });
        cy += s * 0.25;
    }

    const fireSpot = findDryLand(15, 9, 1.3);
    const fh = getTerrainHeight(fireSpot.x, fireSpot.z);
    const ringN = 7;
    for (let i = 0; i < ringN; i++) {
        const a = (i / ringN) * Math.PI * 2;
        parts.push({ x: fireSpot.x + Math.cos(a) * 0.9, y: fh + 0.14, z: fireSpot.z + Math.sin(a) * 0.9, sx: 0.26, sy: 0.26, sz: 0.26, color: 0x5c5a54 });
    }
    parts.push({ x: fireSpot.x, y: fh + 0.16, z: fireSpot.z, sx: 0.55, sy: 0.28, sz: 0.22, color: 0x8a5230 });

    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
    const mesh = new THREE.InstancedMesh(state.sharedBoxGeo, mat, parts.length);
    mesh.castShadow = true; mesh.receiveShadow = true;
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        _dummy.position.set(p.x, p.y, p.z);
        _dummy.scale.set(p.sx, p.sy, p.sz);
        _dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        _tmpColor.setHex(p.color);
        mesh.setColorAt(i, _tmpColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    state.scene.add(mesh);
    state.poiDetailMesh = mesh;

    let fireLight = null;
    if (state.qualityLevel !== 'low') {
        fireLight = new THREE.PointLight(0xffa04a, 0, 6.5, 2.0);
        fireLight.position.set(fireSpot.x, fh + 0.5, fireSpot.z);
        fireLight.castShadow = false;
        state.scene.add(fireLight);
    }
    state.poiFireLight = fireLight;

    poiDiscoverList.length = 0;
    poiDiscoverList.push({ x: cairnSpot.x, y: ch + 1.2, z: cairnSpot.z, seen: false });
    poiDiscoverList.push({ x: fireSpot.x, y: fh + 1.0, z: fireSpot.z, seen: false });
}

export function updatePoiDetails(elapsed) {
    const cam = state.camera;
    if (!cam) return;
    if (state.poiFireLight) {
        const base = state.rain && state.rain.visible ? 0.15 : 0.55;
        const nightBoost = 1 + (state.nightAmt || 0) * 1.4;
        const flicker = 0.75 + 0.25 * Math.sin(elapsed * 9.3) + 0.15 * Math.sin(elapsed * 23.1 + 1.7);
        state.poiFireLight.intensity = base * nightBoost * Math.max(0.2, flicker);
    }
    for (const p of poiDiscoverList) {
        if (p.seen) continue;
        const dx = cam.position.x - p.x, dz = cam.position.z - p.z;
        if (dx * dx + dz * dz < CONFIG.POI_DISCOVER_RADIUS * CONFIG.POI_DISCOVER_RADIUS) {
            p.seen = true;
            spawnParticleBurst(p.x, p.y, p.z, 0xffe9a8, 18);
        }
    }
}
