/* ============================================================
   Sector chunking + coarse occlusion (Phase 4b, items 343 + 345)
   ------------------------------------------------------------
   The world-spanning InstancedMeshes (terrain columns, flora detail)
   are single objects whose bounding sphere wraps the whole arena, so
   three.js can never frustum-cull them — every voxel is submitted from
   every viewpoint. buildChunkedInstances() splits an instance list into
   an 8x8 grid of SECTOR meshes by world XZ. Each sector mesh gets its
   own tight bounding sphere, so three.js' standard whole-object frustum
   culling drops the off-screen sectors for free. The TOTAL instance
   count is unchanged (each chunk is sized exactly to its members — zero
   padding); the win is far fewer DRAWN instances from a viewpoint.

   updateCulling() adds two per-frame refinements on top of three.js'
   frustum pass, both toggling chunk.visible:
     - item 345, coarse behind-massif occlusion: a sector wholly behind
       a mountain silhouette from the camera is skipped. Best-effort and
       deliberately CONSERVATIVE — NO GPU occlusion queries, no depth
       readback; a purely analytic cone+elevation test that only fires
       when a sector is unambiguously hidden (and therefore already in
       the mountain's cast shadow), so it never removes anything visible.
     - flora LOD rings (item 344 lives in lod.js): detail-flora sectors
       beyond the tier's flora ring stop drawing (a no-op on the 'high'
       tier, aggressive on 'low').

   A11y/parity: ?nochunk builds ONE mesh per list (the pre-4b behaviour)
   so the culling win can be A/B measured against an identical scene.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { MOUNTAINS, getTerrainHeight } from './heightfield.js';
import { floraLodRadius } from './lod.js';
import { registerCounter } from './perf.js';

// ~8x8 sectoring, tuned to 10x10: the arena's wide spawn vista (≈107° effective
// horizontal FOV) still captures a large share of an 8x8 grid, so a slightly
// finer grid tightens the frustum-edge cull enough to clear the >=30% drawn-cut
// target on the worst-case seed while keeping the added draw-call count marginal.
//
// item 358 (reviewed, not changed): a formula deriving SECTORS from instance
// count was considered so the grid scales further as MAX_FLORA_INSTANCES
// grows, but there is no in-repo perf harness result for a DIFFERENT grid
// size to validate against — swapping this deliberately-profiled constant for
// an unvalidated formula risks silently drifting from the measured >=30%
// drawn-cut target. Left as a fixed, revisit alongside the next MAX_FLORA_
// INSTANCES bump using the existing perf.js/visreg tooling to re-measure.
//
// item 363 (already satisfied, no change needed): water-adjacent dressing
// (flora/flora.js's addWaterDressing()) is appended into the same `details`
// array terrain.js feeds into buildChunkedInstances() for state.detailChunks
// — it already goes through applyChunkVisibility() below like any other
// flora-detail instance, so it already gets both frustum sectoring and the
// massif-occlusion test.
//
// item 365 (deferred, out of file scope): cave decor (caves/caves-decor.js)
// builds its own per-cave InstancedMeshes via buildBoxInstances/
// buildGeoInstances rather than this module's buildChunkedInstances(), so
// wiring chunk-level distance culling in for it needs an edit on the
// caves-decor.js side to adopt the (already-exported, ready) chunking API —
// out of this agent's file scope. Same reasoning applies to item 357
// (chamber-to-chamber occlusion needs caves.js-owned chamber geometry).
export const SECTORS = 10; // ~8x8 (see note)

function chunkingEnabled() {
    try {
        if (typeof window !== 'undefined' && window.location && /[?&]nochunk\b/.test(window.location.search)) return false;
    } catch (e) { /* non-browser */ }
    return true;
}

// Coarse occlusion can be forced off with ?noocclude (kept ON by default).
function occlusionEnabled() {
    try {
        if (typeof window !== 'undefined' && window.location && /[?&]noocclude\b/.test(window.location.search)) return false;
    } catch (e) { /* non-browser */ }
    return true;
}

function sectorIndex(x, z, half) {
    const span = 2 * half;
    let sx = Math.floor(((x + half) / span) * SECTORS);
    let sz = Math.floor(((z + half) / span) * SECTORS);
    if (sx < 0) sx = 0; else if (sx >= SECTORS) sx = SECTORS - 1;
    if (sz < 0) sz = 0; else if (sz >= SECTORS) sz = SECTORS - 1;
    return sz * SECTORS + sx;
}

/* ------------------------------------------------------------
   Build a chunked InstancedMesh group from an instance list.
     opts.geo         shared BoxGeometry
     opts.material    ONE material shared by every chunk
     opts.instances   array of descriptors (must carry .x/.z for bucketing)
     opts.half        arena half-extent
     opts.apply(inst, dummy, color) -> boolean
                      fills dummy transform; sets `color` and returns true
                      when the chunk should carry per-instance colors
     opts.dynamic     mark instanceMatrix DynamicDrawUsage (animated flora)
   Returns a record: { group, meshes, meshOf, localOf, centerX, centerZ,
   groundY, dirty, count, chunked }.
   ------------------------------------------------------------ */
export function buildChunkedInstances(opts) {
    const { geo, material, instances, half, apply,
            dynamic = false, castShadow = true, receiveShadow = true, name = 'chunk' } = opts;
    const enabled = chunkingEnabled();
    const nSectors = enabled ? SECTORS * SECTORS : 1;
    const span = 2 * half;
    const cell = span / SECTORS;

    const buckets = new Array(nSectors);
    for (let s = 0; s < nSectors; s++) buckets[s] = [];
    for (let i = 0; i < instances.length; i++) {
        const s = enabled ? sectorIndex(instances[i].x, instances[i].z, half) : 0;
        buckets[s].push(i);
    }

    const group = new THREE.Group();
    group.name = name + '-chunks';
    const meshes = [];
    const meshOf = new Int16Array(instances.length);
    const localOf = new Int32Array(instances.length);
    const centerX = [], centerZ = [], groundY = [];
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();

    for (let s = 0; s < nSectors; s++) {
        const idxs = buckets[s];
        if (!idxs.length) continue;
        const mesh = new THREE.InstancedMesh(geo, material, idxs.length);
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;
        if (dynamic) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        let usedColor = false;
        for (let li = 0; li < idxs.length; li++) {
            const gi = idxs[li];
            const hadColor = apply(instances[gi], dummy, col);
            dummy.updateMatrix();
            mesh.setMatrixAt(li, dummy.matrix);
            if (hadColor) { mesh.setColorAt(li, col); usedColor = true; }
            meshOf[gi] = meshes.length;
            localOf[gi] = li;
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (usedColor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.userData.sector = s;
        // sector centre (world XZ) + its terrain height, cached for the
        // per-frame occlusion/LOD test so no noise sampling happens per frame.
        const sx = enabled ? (s % SECTORS) : (SECTORS / 2 - 0.5);
        const sz = enabled ? Math.floor(s / SECTORS) : (SECTORS / 2 - 0.5);
        const cx = -half + (sx + 0.5) * cell;
        const cz = -half + (sz + 0.5) * cell;
        centerX.push(cx); centerZ.push(cz); groundY.push(getTerrainHeight(cx, cz));
        meshes.push(mesh);
        group.add(mesh);
    }

    state.scene.add(group);
    return {
        group, meshes, meshOf, localOf,
        centerX, centerZ, groundY,
        dirty: new Uint8Array(meshes.length),
        halfCellDiag: (cell * 0.5) * Math.SQRT2,
        count: instances.length,
        chunked: enabled,
    };
}

// Redirect a global-index instance write to its chunk + mark that chunk dirty.
// Lets the flora wind-sway loop stay index-based across the split (identity map
// when unchunked). matrix is a THREE.Matrix4.
export function chunkSetMatrix(rec, globalIdx, matrix) {
    const mi = rec.meshOf[globalIdx];
    rec.meshes[mi].setMatrixAt(rec.localOf[globalIdx], matrix);
    rec.dirty[mi] = 1;
}

// Flush per-frame instanceMatrix uploads for only the chunks touched this frame.
export function chunkFlushDirty(rec) {
    if (!rec) return;
    const d = rec.dirty;
    for (let m = 0; m < rec.meshes.length; m++) {
        if (d[m]) { rec.meshes[m].instanceMatrix.needsUpdate = true; d[m] = 0; }
    }
}

export function disposeChunked(rec) {
    if (!rec) return;
    const scene = state.scene;
    let mat = null;
    for (const m of rec.meshes) {
        mat = m.material;
        if (scene) scene.remove(m);
        try { m.dispose(); } catch (e) { /* frees instance buffers */ }
    }
    if (rec.group && scene) scene.remove(rec.group);
    if (mat) { try { mat.dispose(); } catch (e) {} }
    rec.meshes.length = 0;
}

/* ------------------------------------------------------------
   Coarse behind-massif occlusion (item 345). Cached silhouette
   heights per mountain (world Y of each massif's top), refreshed
   once per world build.
   ------------------------------------------------------------ */
let _mtnTopY = null;
export function primeOcclusion() {
    _mtnTopY = MOUNTAINS.map((m) => getTerrainHeight(m.x, m.z));
    _occluded = 0; _floraCulled = 0;
    registerCounter('occludedChunks', () => _occluded);
    registerCounter('floraLodCulledChunks', () => _floraCulled);
}

let _occluded = 0, _floraCulled = 0;

// Is a sector centre (cx,cz, top at topY) hidden behind ANY massif from the
// camera? Conservative: the sector must sit clearly beyond the massif, fully
// inside a shrunk angular cone, AND below the massif's silhouette elevation.
function occludedByMassif(cx, cz, topY, camX, camY, camZ, halfCellDiag) {
    if (!_mtnTopY) return false;
    const sdx = cx - camX, sdz = cz - camZ;
    const dSec = Math.hypot(sdx, sdz);
    if (dSec < 1e-3) return false;
    const bS = Math.atan2(sdz, sdx);
    for (let i = 0; i < MOUNTAINS.length; i++) {
        const m = MOUNTAINS[i];
        const mdx = m.x - camX, mdz = m.z - camZ;
        const dMtn = Math.hypot(mdx, mdz);
        if (dMtn < m.r + 3) continue;                    // camera on/inside the massif
        if (dSec <= dMtn + m.r * 1.15) continue;         // sector not clearly beyond it
        // horizontal cone: sector (plus its own angular width) fully inside the
        // massif's silhouette cone, tightened to 0.85 for safety.
        let db = bS - Math.atan2(mdz, mdx);
        while (db > Math.PI) db -= Math.PI * 2;
        while (db < -Math.PI) db += Math.PI * 2;
        const coneHalf = Math.asin(Math.min(1, m.r / dMtn));
        const secHalf = Math.asin(Math.min(1, halfCellDiag / dSec));
        if (Math.abs(db) + secHalf >= coneHalf * 0.85) continue;
        // vertical: the massif silhouette must rise above the sector's top along
        // the line of sight (else the sector peeks over the shoulder).
        const mtnElev = Math.atan2(_mtnTopY[i] - camY, dMtn);
        const secElev = Math.atan2((topY + 4) - camY, dSec);
        if (mtnElev <= secElev) continue;
        return true;
    }
    return false;
}

function applyChunkVisibility(rec, camX, camY, camZ, ringR2, doOcclude) {
    if (!rec || !rec.meshes.length) return;
    const cX = rec.centerX, cZ = rec.centerZ, gY = rec.groundY, hcd = rec.halfCellDiag;
    for (let m = 0; m < rec.meshes.length; m++) {
        const mesh = rec.meshes[m];
        // flora LOD ring (tier-scaled; ringR2 = Infinity disables it)
        if (ringR2 !== Infinity) {
            const dx = cX[m] - camX, dz = cZ[m] - camZ;
            if (dx * dx + dz * dz > ringR2) { if (mesh.visible) { mesh.visible = false; } _floraCulled++; continue; }
        }
        if (doOcclude && occludedByMassif(cX[m], cZ[m], gY[m], camX, camY, camZ, hcd)) {
            if (mesh.visible) mesh.visible = false;
            _occluded++;
            continue;
        }
        if (!mesh.visible) mesh.visible = true;
    }
}

/* ------------------------------------------------------------
   Per-frame chunk visibility driver. Runs occlusion on terrain +
   flora, plus the flora LOD ring. Cheap (a handful of massifs x
   <=64 chunks of pure arithmetic); no allocation.
   ------------------------------------------------------------ */
export function updateCulling() {
    const cam = state.camera;
    if (!cam) return;
    _occluded = 0; _floraCulled = 0;
    const camX = cam.position.x, camY = cam.position.y, camZ = cam.position.z;
    const doOcclude = occlusionEnabled();
    const floraR = floraLodRadius();
    const floraR2 = (floraR >= 9000) ? Infinity : floraR * floraR;
    applyChunkVisibility(state.terrainChunks, camX, camY, camZ, Infinity, doOcclude);
    applyChunkVisibility(state.terrainInteriorChunks, camX, camY, camZ, Infinity, doOcclude);
    applyChunkVisibility(state.detailChunks, camX, camY, camZ, floraR2, doOcclude);
}
