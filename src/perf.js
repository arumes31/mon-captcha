/* ============================================================
   Perf monitor (Phase 4b, item 357)
   ------------------------------------------------------------
   The program's accounting instrument. Reads renderer.info plus
   a faithful software model of three.js frustum/visibility culling
   to report, on demand:

     - TOTAL instances    : every InstancedMesh.count in the scene
                             (matches the 4a rig's scene-walk exactly).
     - DRAWN instances     : the subset the renderer would actually
                             submit this frame from the current camera
                             (respects object.visible up the ancestry,
                             the frustumCulled flag, and the per-object
                             bounding sphere — the same test WebGLRenderer
                             runs). This is how a viewpoint's real cost
                             is quoted, and what the 4b culling win is
                             measured against.
     - DRAW CALLS / tris   : straight off renderer.info.render.
     - GEOMETRIES/TEXTURES : straight off renderer.info.memory.
     - custom counters      : any subsystem can registerCounter(name, fn)
                             (e.g. culling exposes occluded-chunk counts).

   DEV-ONLY surface: exposed on ?probe (window.__probe.perf) and read by
   the 4a test rig + the future 4r dev overlay. Nothing here runs per
   frame unless something samples it, so it costs nothing in normal play.
   ============================================================ */

import * as THREE from 'three';
import { state } from './state.js';

const _frustum = new THREE.Frustum();
const _viewProj = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

// Subsystem-registered counters (name -> () => number). culling.js registers
// its occlusion/flora-LOD tallies here so one sample surfaces everything.
const counters = new Map();
export function registerCounter(name, fn) { counters.set(name, fn); }
export function unregisterCounter(name) { counters.delete(name); }
export function clearCounters() { counters.clear(); }

function buildFrustum(camera) {
    camera.updateMatrixWorld();
    _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_viewProj);
}

// Ancestry visibility — the renderer skips an object if it OR any parent is
// hidden. Mirrors WebGLRenderer.projectObject's `object.visible === false` gate.
function visibleInTree(o) {
    let n = o;
    while (n) { if (n.visible === false) return false; n = n.parent; }
    return true;
}

// Faithful copy of THREE.Frustum.intersectsObject: prefer the object's own
// bounding sphere (InstancedMesh computes one spanning all instances), else the
// geometry's — exactly what the renderer culls against.
function inFrustum(o) {
    if (o.frustumCulled === false) return true;
    if (o.boundingSphere !== undefined) {
        if (o.boundingSphere === null) o.computeBoundingSphere();
        _sphere.copy(o.boundingSphere).applyMatrix4(o.matrixWorld);
    } else {
        const g = o.geometry;
        if (!g) return true;
        if (g.boundingSphere === null) g.computeBoundingSphere();
        _sphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
    }
    return _frustum.intersectsSphere(_sphere);
}

/* ------------------------------------------------------------
   Full sample from a camera (defaults to the live game camera).
   Returns null before the world exists.
   ------------------------------------------------------------ */
export function perfSample(camera) {
    const scene = state.scene;
    const cam = camera || state.camera;
    if (!scene || !cam) return null;
    buildFrustum(cam);

    let totalInstances = 0, drawnInstances = 0, totalMeshes = 0, drawnMeshes = 0;
    // chunkTotal/chunkDrawn isolate the sector-chunked terrain+flora (parent
    // group named "*-chunks") so a budget note can quote the un-chunked baseline
    // (chunkTotal, always fully drawn) vs the chunked draw (chunkDrawn) from one
    // load — no separate ?nochunk pass needed.
    let chunkTotal = 0, chunkDrawn = 0;
    scene.traverse((o) => {
        if (!o.isInstancedMesh) return;
        const c = o.count || 0;
        totalInstances += c;
        totalMeshes++;
        const isChunk = o.parent && typeof o.parent.name === 'string' && o.parent.name.endsWith('-chunks');
        if (isChunk) chunkTotal += c;
        if (visibleInTree(o) && inFrustum(o)) {
            drawnInstances += c;
            drawnMeshes++;
            if (isChunk) chunkDrawn += c;
        }
    });
    // un-chunked baseline: the chunked terrain+flora would be single arena-
    // spanning meshes, always fully in-frustum, so "drawn before" = every chunk
    // instance + the (unchanged) non-chunk drawn instances.
    const baselineDrawn = chunkTotal + (drawnInstances - chunkDrawn);

    const r = state.renderer;
    const info = (r && r.info) ? {
        calls: r.info.render.calls,
        triangles: r.info.render.triangles,
        points: r.info.render.points,
        geometries: r.info.memory.geometries,
        textures: r.info.memory.textures,
        programs: r.info.programs ? r.info.programs.length : null,
    } : null;

    const custom = {};
    for (const [k, fn] of counters) { try { custom[k] = fn(); } catch (e) { custom[k] = null; } }

    return {
        totalInstances,
        drawnInstances,
        culledInstances: totalInstances - drawnInstances,
        totalMeshes,
        drawnMeshes,
        chunkTotal,
        chunkDrawn,
        baselineDrawn,          // "drawn before" the 4b chunking, same viewpoint
        drawnFraction: totalInstances ? drawnInstances / totalInstances : 0,
        cutFraction: totalInstances ? 1 - drawnInstances / totalInstances : 0,
        // headline: cut in DRAWN instances vs the un-chunked baseline
        drawCut: baselineDrawn ? 1 - drawnInstances / baselineDrawn : 0,
        info,
        counters: custom,
    };
}

/* ------------------------------------------------------------
   Cheap total-only reader. Byte-for-byte the number the 4a rig's
   readInstanceTotal() computes by walking the scene graph, so the
   rig can read it straight off ?probe instead of re-walking.
   ------------------------------------------------------------ */
export function perfInstanceTotal() {
    const scene = state.scene;
    if (!scene) return 0;
    let total = 0, meshes = 0;
    scene.traverse((o) => { if (o.isInstancedMesh) { total += (o.count || 0); meshes++; } });
    return { total, meshes };
}

// Per-frame drawn-instance count from the live camera (the number budget notes
// and the 4r overlay quote). Convenience wrapper around perfSample.
export function perfDrawnInstances(camera) {
    const s = perfSample(camera);
    return s ? s.drawnInstances : null;
}
