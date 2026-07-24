/* ============================================================
   Terrain & Environment (High Fidelity Voxel)
   ============================================================ */

import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { mulberry32, worldNoise } from './random.js';
import { getTerrainHeight, isWaterAt, MOUNTAINS, VENT, CAVES, sampleCave } from './heightfield.js';
import { SUN_DIRECTION } from './engine.js';
import { zoneBlendAt } from './zones/zones.js';
import { buildFlora } from './flora/flora.js';
import { buildClouds, buildAmbientLife, buildPointsOfInterest, buildZoneAmbient } from './atmosphere.js';
import { buildMountainFeatures } from './mountain/mountain.js';
import { buildLava } from './lava.js';
import { buildCaves } from './caves/caves.js';
import { buildChunkedInstances, primeOcclusion } from './culling.js';

// Snow line per mountain (set from each massif's actual peak height in
// buildTerrain so every seed keeps a proportioned cap). Index-aligned to
// MOUNTAINS; the surface-cap colourer picks the massif the column sits on.
let mountSnow = [];

/* ------------------------------------------------------------
   Per-column zone colors. zoneBlendAt gives the primary zone,
   the neighbour it borders and a cross-fade weight, so palettes
   melt across the soft dithered borders. Zone palette hexes are
   authored in the same near-linear space the rest of voxelColor
   writes with setRGB, so they are unpacked byte-wise (no sRGB
   decode) to stay consistent. `m` (biome noise) picks each
   zone's shadow->sunny surface variant. Reuses module temps —
   no per-column allocation.
   ------------------------------------------------------------ */
const _zc = { sr: 0, sg: 0, sb: 0, dr: 0, dg: 0, db: 0, pr: 0, pg: 0, pb: 0 };
const _lr = (h) => ((h >> 16) & 255) / 255;
const _lg = (h) => ((h >> 8) & 255) / 255;
const _lb = (h) => (h & 255) / 255;
const _mix = (a, b, t) => a + (b - a) * t;
function computeZoneColors(cx, cz, m) {
    const zb = zoneBlendAt(cx, cz);
    const A = zb.a, B = zb.b, t = zb.t;
    // surface: blend each zone's shadow(surf0)->sunny(surf1) by m, then A->B by t
    let sr = _mix(_lr(A.surf0), _lr(A.surf1), m);
    let sg = _mix(_lg(A.surf0), _lg(A.surf1), m);
    let sb = _mix(_lb(A.surf0), _lb(A.surf1), m);
    let dr = _lr(A.dirt), dg = _lg(A.dirt), db = _lb(A.dirt);
    let pr = _lr(A.rock), pg = _lg(A.rock), pb = _lb(A.rock);
    if (t > 0) {
        sr = _mix(sr, _mix(_lr(B.surf0), _lr(B.surf1), m), t);
        sg = _mix(sg, _mix(_lg(B.surf0), _lg(B.surf1), m), t);
        sb = _mix(sb, _mix(_lb(B.surf0), _lb(B.surf1), m), t);
        dr = _mix(dr, _lr(B.dirt), t); dg = _mix(dg, _lg(B.dirt), t); db = _mix(db, _lb(B.dirt), t);
        pr = _mix(pr, _lr(B.rock), t); pg = _mix(pg, _lg(B.rock), t); pb = _mix(pb, _lb(B.rock), t);
    }
    _zc.sr = sr; _zc.sg = sg; _zc.sb = sb;
    _zc.dr = dr; _zc.dg = dg; _zc.db = db;
    _zc.pr = pr; _zc.pg = pg; _zc.pb = pb;
    return _zc;
}

// Zone-aware voxel color picker:
//   - per-zone terrain palette (12 zones), cross-faded across soft borders,
//     via the precomputed per-column zc (computeZoneColors)
//   - sandy shore ring fading into grass around the pond
//   - riverbed/riverbank, outer cliff wall, landmark mountain rock+snow,
//     scorched magma ring — all structural overrides layered ON TOP of the zone
//   - per-voxel jitter so no two blocks read identical
function voxelColor(x, z, y, surfaceY, zc, outColor) {
    const depth = surfaceY - y;
    const d = Math.sqrt(x * x + z * z);
    const half = CONFIG.ARENA_SIZE / 2;
    // per-voxel color jitter (hashed noise, deterministic)
    const v = worldNoise(x * 2.7 + y * 1.3, z * 2.7 - y * 0.7, 2, 2.0, 0.5) * 0.05;

    if (depth < 0.5) {
        // ---- surface cap: zone palette (already m-blended + border-crossfaded) ----
        let r = zc.sr + v;
        let g = zc.sg + v * 0.7;
        let b = zc.sb + v * 0.5;
        // sandy shore ring around the pond
        if (d < CONFIG.POND_RADIUS + 1.7) {
            const t = THREE.MathUtils.smoothstep(d, CONFIG.POND_RADIUS, CONFIG.POND_RADIUS + 1.7);
            r = THREE.MathUtils.lerp(0.85 + v, r, t);
            g = THREE.MathUtils.lerp(0.76 + v, g, t);
            b = THREE.MathUtils.lerp(0.55 + v, b, t);
        }
        // riverbed & riverbanks: submerged caps turn to depth-tinted sand,
        // low dry banks fade from sand back into grass
        if (surfaceY < 0.42 && d >= CONFIG.POND_RADIUS) {
            const wet = Math.min(1, Math.max(0, (0.42 - surfaceY) / 0.6)); // 0 dry bank -> 1 deep bed
            const deep = Math.min(1, Math.max(0, -surfaceY / 0.9));
            const sr = THREE.MathUtils.lerp(0.85, 0.52, deep) + v;
            const sg = THREE.MathUtils.lerp(0.76, 0.5, deep) + v;
            const sb = THREE.MathUtils.lerp(0.55, 0.38, deep) + v * 0.8;
            r = THREE.MathUtils.lerp(r, sr, 0.35 + wet * 0.65);
            g = THREE.MathUtils.lerp(g, sg, 0.35 + wet * 0.65);
            b = THREE.MathUtils.lerp(b, sb, 0.35 + wet * 0.65);
        }
        // outer cliff band: grass gives way to weathered rocky top (kept subtle so
        // the mid-distance ring stays green rather than drab gray)
        if (d > half - 4) {
            const t = Math.min(1, (d - (half - 4)) / 3.5);
            r = THREE.MathUtils.lerp(r, 0.50 + v, t * 0.65);
            g = THREE.MathUtils.lerp(g, 0.48 + v, t * 0.65);
            b = THREE.MathUtils.lerp(b, 0.42 + v, t * 0.65);
        }
        // landmark mountains: banded rock above the grass line, snow at each cap
        for (let mi = 0; mi < MOUNTAINS.length; mi++) {
            const mt = MOUNTAINS[mi];
            const mdx = x - mt.x, mdz = z - mt.z;
            if (mdx * mdx + mdz * mdz >= (mt.r + 1.5) * (mt.r + 1.5) || surfaceY <= 2.6) continue;
            const band = Math.sin(y * 2.1 + worldNoise(x * 0.2, z * 0.2, 2, 2.0, 0.5) * 2.5) * 0.5 + 0.5;
            const rockK = THREE.MathUtils.smoothstep(surfaceY, 2.6, 4.6);
            r = THREE.MathUtils.lerp(r, THREE.MathUtils.lerp(0.42, 0.56, band) + v, rockK);
            g = THREE.MathUtils.lerp(g, THREE.MathUtils.lerp(0.40, 0.53, band) + v, rockK);
            b = THREE.MathUtils.lerp(b, THREE.MathUtils.lerp(0.41, 0.53, band) + v * 0.8, rockK);
            const sl = mountSnow[mi] !== undefined ? mountSnow[mi] : 99;
            const snowK = THREE.MathUtils.smoothstep(surfaceY, sl, sl + 1.8);
            if (snowK > 0) {
                r = THREE.MathUtils.lerp(r, 0.93 + v, snowK);
                g = THREE.MathUtils.lerp(g, 0.95 + v, snowK);
                b = THREE.MathUtils.lerp(b, 0.99 + v * 0.5, snowK);
            }
            break; // massifs don't overlap — at most one owns this column
        }
        // scorched basalt ring around the magma vent, veined with hot cracks
        const vdx = x - VENT.x, vdz = z - VENT.z;
        const dvt = Math.sqrt(vdx * vdx + vdz * vdz);
        if (dvt < VENT.r + 2.4) {
            const burn = 1 - THREE.MathUtils.smoothstep(dvt, VENT.r, VENT.r + 2.4);
            r = THREE.MathUtils.lerp(r, 0.16 + v * 0.5, burn * 0.9);
            g = THREE.MathUtils.lerp(g, 0.13 + v * 0.4, burn * 0.9);
            b = THREE.MathUtils.lerp(b, 0.12 + v * 0.4, burn * 0.9);
            if (burn > 0.55 && v > 0.024) { r = 0.78; g = 0.3; b = 0.07; } // glowing veins
        }
        outColor.setRGB(r, g, b);
    } else if (depth < 2.0) {
        // ---- rich brown dirt, slightly darker & moist near the pond ----
        // (mountain flanks read as rock instead of soil)
        let onMountain = false;
        for (let mi = 0; mi < MOUNTAINS.length; mi++) {
            const mt = MOUNTAINS[mi], mdx = x - mt.x, mdz = z - mt.z;
            if (mdx * mdx + mdz * mdz < (mt.r + 1.5) * (mt.r + 1.5) && surfaceY > 3.2) { onMountain = true; break; }
        }
        if (onMountain) {
            const band = Math.sin(y * 3.2 + worldNoise(x * 0.14, z * 0.14, 2, 2.0, 0.5) * 2.2) * 0.5 + 0.5;
            outColor.setRGB(
                THREE.MathUtils.lerp(0.36, 0.48, band) + v,
                THREE.MathUtils.lerp(0.35, 0.45, band) + v,
                THREE.MathUtils.lerp(0.36, 0.45, band) + v * 0.8
            );
            return outColor;
        }
        const moist = d < CONFIG.POND_RADIUS + 3 ? 0.06 : 0.0;
        outColor.setRGB(zc.dr + v - moist, zc.dg + v - moist * 0.7, zc.db + v * 0.6);
    } else {
        // ---- deep stone with horizontal strata banding, tinted per zone ----
        const band = Math.sin(y * 3.2 + worldNoise(x * 0.14, z * 0.14, 2, 2.0, 0.5) * 2.2) * 0.5 + 0.5;
        const k = 0.82 + band * 0.34; // strata light/dark around the zone rock tone
        outColor.setRGB(zc.pr * k + v, zc.pg * k + v, zc.pb * k + v * 0.8);
    }
    return outColor;
}

// A box with its top (+y) face stripped — for a column voxel buried under
// another voxel of the SAME column, whose top face sits flush against the
// one above (identical x/z, exactly one V_STEP up) and is therefore always
// hidden, no neighbor-dependent exceptions needed (unlike the bottom face,
// which can occasionally be seen from inside a cave or a cliff edge, so it
// stays intact). BoxGeometry's face groups (no segment subdivisions) run
// +x,-x,+y,-y,+z,-z at 6 indices each — the +y/top face is exactly indices
// 12-17 (verified against the pinned three@0.160.0 source).
function buildInteriorVoxelGeo(size) {
    const box = new THREE.BoxGeometry(size, size, size);
    const srcIndex = box.getIndex();
    const kept = [];
    for (let i = 0; i < srcIndex.count; i++) {
        if (i >= 12 && i < 18) continue; // +y (top) face
        kept.push(srcIndex.getX(i));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', box.getAttribute('position'));
    geo.setAttribute('normal', box.getAttribute('normal'));
    geo.setAttribute('uv', box.getAttribute('uv'));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(kept), 1));
    return geo;
}

export function buildTerrain() {
    const V_STEP = CONFIG.VOXEL_SIZE;
    const geo = new THREE.BoxGeometry(V_STEP, V_STEP, V_STEP);
    state.sharedBoxGeo = geo;
    const interiorGeo = buildInteriorVoxelGeo(V_STEP);
    state.sharedInteriorGeo = interiorGeo;
    const half = CONFIG.ARENA_SIZE / 2;
    const dummy = new THREE.Object3D();
    const tmpColor = new THREE.Color();

    // proportion each massif's snow cap to its actual peak height
    mountSnow = MOUNTAINS.map(mt => getTerrainHeight(mt.x, mt.z) - 4.0);

    // 1. Water — three/addons Water covering the WHOLE arena at the shared
    //    waterline. The dry-land floor in heightfield.js guarantees terrain
    //    only dips below it inside the pond bowl and the river channel, so
    //    one reflective plane serves the entire water network.
    const waterGeo = new THREE.PlaneGeometry(CONFIG.ARENA_SIZE + 2, CONFIG.ARENA_SIZE + 2, 32, 32);
    const water = new Water(waterGeo, {
        textureWidth: 1024,
        textureHeight: 1024,
        waterNormals: makeWaterNormals(),
        sunDirection: SUN_DIRECTION.clone(),
        sunColor: 0xffd6a0,
        waterColor: 0x1f7d8c,
        distortionScale: 1.0,
        fog: state.scene.fog !== undefined,
        alpha: 0.84,
    });
    water.rotation.x = -Math.PI / 2;
    water.position.y = CONFIG.POND_WATER_LEVEL;
    state.scene.add(water);
    state.water = water;

    // 1a. Foam ring hugging the shoreline (procedural radial streak texture)
    const foamGeo = new THREE.RingGeometry(CONFIG.POND_RADIUS - 0.55, CONFIG.POND_RADIUS + 0.1, 96, 1);
    const foamMat = new THREE.MeshBasicMaterial({
        map: makeFoamTexture(),
        color: 0xffffff,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
    });
    const foamRing = new THREE.Mesh(foamGeo, foamMat);
    foamRing.rotation.x = -Math.PI / 2;
    foamRing.position.y = CONFIG.POND_WATER_LEVEL + 0.025;
    foamRing.renderOrder = 1; // draw after the (transparent) water plane
    state.scene.add(foamRing);
    state.foamRing = foamRing;

    // 1b. Sandy pond bowl following the terrain depression + submerged aquatic plants
    //     (grid-aligned with the terrain columns so shore seams stay closed)
    const pondInstances = [];
    for (let x = -half; x < half; x += V_STEP) {
        for (let z = -half; z < half; z += V_STEP) {
            const cx = x + V_STEP / 2, cz = z + V_STEP / 2;
            const d = Math.sqrt(cx * cx + cz * cz);
            if (d >= CONFIG.POND_RADIUS) continue;
            const bowlY = getTerrainHeight(cx, cz); // negative inside the bowl
            // sandy bottom block with depth-tinted color (deeper = darker, cooler)
            const sandV = worldNoise(cx * 0.3, cz * 0.3, 2, 2.0, 0.5) * 0.06;
            const deep = Math.min(1, -bowlY / 1.8);
            const sandColor = new THREE.Color(0xd9c89a)
                .lerp(new THREE.Color(0x8a835e), deep * 0.55)
                .offsetHSL(0, 0, sandV).getHex();
            pondInstances.push({ x: cx, y: bowlY - V_STEP / 2, z: cz, sx: 1, sy: 1, sz: 1, color: sandColor, kind: 'sand' });
        }
    }
    // submerged aquatic plants (blocky green tufts rooted on the bowl floor,
    // height clamped so they always stay below the water surface)
    const plantRand = mulberry32(CONFIG.WORLD_SEED ^ 0x51ed);
    for (let i = 0; i < 40; i++) {
        const ang = plantRand() * Math.PI * 2;
        const rad = plantRand() * (CONFIG.POND_RADIUS - 1.5);
        const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
        const bowlY = getTerrainHeight(x, z);
        const maxPh = (CONFIG.POND_WATER_LEVEL - 0.08 - bowlY) / V_STEP; // stay submerged
        const ph = Math.min(0.75 + plantRand() * 1.75, Math.max(0.3, maxPh));
        pondInstances.push({ x, y: bowlY + ph * V_STEP / 2, z, sx: 0.18, sy: ph, sz: 0.18, color: 0x2f7d4f, kind: 'plant' });
    }
    // NOTE: per-instance colors come from setColorAt (instanceColor); the shared box
    // geometry has no 'color' vertex attribute, so vertexColors must stay OFF or the
    // missing attribute reads as (0,0,0) and everything multiplies to black.
    const pondMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.0 });
    const pondMesh = new THREE.InstancedMesh(geo, pondMat, pondInstances.length);
    pondMesh.castShadow = false;
    pondMesh.receiveShadow = true;
    for (let i = 0; i < pondInstances.length; i++) {
        const d = pondInstances[i];
        dummy.position.set(d.x, d.y, d.z);
        dummy.scale.set(d.sx, d.sy, d.sz);
        dummy.updateMatrix();
        pondMesh.setMatrixAt(i, dummy.matrix);
        tmpColor.setHex(d.color);
        pondMesh.setColorAt(i, tmpColor);
    }
    pondMesh.instanceMatrix.needsUpdate = true;
    if (pondMesh.instanceColor) pondMesh.instanceColor.needsUpdate = true;
    state.scene.add(pondMesh);
    state.pondMesh = pondMesh;

    // 2. Organic terrain columns (InstancedMesh, vertex colors, biome strata)
    //    Hidden-voxel culling: each column only stacks deep enough to cover its
    //    exposed flank (lowest neighbor + margin) — buried voxels are never built.
    //    Cheap baked AO: crevice darkening from towering neighbors + depth shade.
    //    Within a retained column, only the TOPMOST voxel needs its top face —
    //    every voxel below it has that face buried against the one above, so
    //    those go in terrainInteriorInstances (side-band geometry, no top face).
    const terrainInstances = [];
    const terrainInteriorInstances = [];
    for (let x = -half; x < half; x += V_STEP) {
        for (let z = -half; z < half; z += V_STEP) {
            const cx = x + V_STEP / 2, cz = z + V_STEP / 2;
            const d = Math.sqrt(cx * cx + cz * cz);
            if (d < CONFIG.POND_RADIUS) continue; // pond is open water
            const surfaceY = getTerrainHeight(cx, cz);
            const hN = getTerrainHeight(cx, cz - V_STEP);
            const hS = getTerrainHeight(cx, cz + V_STEP);
            const hW = getTerrainHeight(cx - V_STEP, cz);
            const hE = getTerrainHeight(cx + V_STEP, cz);
            const floorY = Math.max(-2.0, Math.min(surfaceY, hN, hS, hW, hE) - 0.45);
            // concavity: neighbors rising above this column occlude ambient light
            const occl = Math.max(0, hN - surfaceY) + Math.max(0, hS - surfaceY)
                       + Math.max(0, hW - surfaceY) + Math.max(0, hE - surfaceY);
            const creviceAO = 1 - Math.min(0.30, occl * 0.22);
            // zone palette for this whole column (one blend lookup, reused per voxel)
            const m = worldNoise(cx * 0.055 + 37, cz * 0.055 - 11, 3, 2.0, 0.5) * 0.5 + 0.5;
            const zc = computeZoneColors(cx, cz, m);
            // cave floor: columns inside a tunnel passage drop to dark rock (the
            // shell shades them further, but the palette must read moody on its own)
            let caveK = 0;
            if (CAVES.length) {
                const cf = sampleCave(cx, cz);
                if (cf) caveK = 1 - THREE.MathUtils.smoothstep(cf.lat, cf.hw - 0.5, cf.hw + 0.85);
            }
            for (let y = floorY + V_STEP / 2; y <= surfaceY; y += V_STEP) {
                voxelColor(cx, cz, y, surfaceY, zc, tmpColor);
                // depth-based AO: flanks darken the further below the cap they sit
                const depth = surfaceY - y;
                let shade = creviceAO * (1 - Math.min(0.35, Math.max(0, depth - 0.2) * 0.13));
                if (caveK > 0) {
                    // cave floor: pull the zone palette toward cool dark stone,
                    // then sink it — reads as rock underfoot, not shaded lawn
                    tmpColor.r = THREE.MathUtils.lerp(tmpColor.r, 0.10, caveK * 0.85);
                    tmpColor.g = THREE.MathUtils.lerp(tmpColor.g, 0.095, caveK * 0.85);
                    tmpColor.b = THREE.MathUtils.lerp(tmpColor.b, 0.12, caveK * 0.85);
                    shade *= 1 - caveK * 0.45;
                }
                tmpColor.multiplyScalar(shade);
                // bake the shaded color into the instance descriptor so the
                // chunker (culling.js) can distribute it across sector meshes
                const inst = { x: cx, y, z: cz, r: tmpColor.r, g: tmpColor.g, b: tmpColor.b };
                // last iteration of this column's loop (next y would exceed
                // surfaceY) => the one voxel whose top face is actually exposed
                const isTop = y + V_STEP > surfaceY + 1e-6;
                (isTop ? terrainInstances : terrainInteriorInstances).push(inst);
            }
        }
    }
    const terrainMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.0 }); // instance colors via setColorAt
    const applyTerrainInstance = (inst, dm, col) => {
        dm.position.set(inst.x, inst.y, inst.z);
        dm.scale.set(1, 1, 1);
        dm.rotation.set(0, 0, 0);
        col.setRGB(inst.r, inst.g, inst.b);
        return true;
    };
    // Phase 4b (item 343): split the world-spanning terrain into 8x8 sector
    // chunks so three.js frustum culling drops the off-screen sectors. Total
    // instance count is identical (each chunk sized exactly to its members).
    state.terrainChunks = buildChunkedInstances({
        geo, material: terrainMat, instances: terrainInstances, half,
        castShadow: true, receiveShadow: true, name: 'terrain',
        apply: applyTerrainInstance,
    });
    // Buried (non-topmost) column voxels — same material/positions/colors,
    // just the top-face-stripped geometry (see buildInteriorVoxelGeo above).
    state.terrainInteriorChunks = buildChunkedInstances({
        geo: interiorGeo, material: terrainMat, instances: terrainInteriorInstances, half,
        castShadow: true, receiveShadow: true, name: 'terrain-interior',
        apply: applyTerrainInstance,
    });

    // 3. Perimeter stone walls (InstancedMesh, vertex colors)
    const wallInstances = [];
    const addWallVoxel = (x, z) => {
        const h = getTerrainHeight(x, z);
        for (let y = h + V_STEP / 2; y <= h + 2.0; y += V_STEP) {
            wallInstances.push({ x, y, z });
        }
    };
    for (let x = -half; x < half; x += V_STEP) {
        addWallVoxel(x + V_STEP / 2, -half + V_STEP / 2);
        addWallVoxel(x + V_STEP / 2, half - V_STEP / 2);
    }
    for (let z = -half + V_STEP; z < half - V_STEP; z += V_STEP) {
        addWallVoxel(-half + V_STEP / 2, z + V_STEP / 2);
        addWallVoxel(half - V_STEP / 2, z + V_STEP / 2);
    }
    const wallMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0 }); // instance colors via setColorAt
    // Phase 4b: the perimeter wall rings the whole arena, so as one mesh its
    // bounding sphere never frustum-culls — chunk it too, so the ~3 wall runs
    // behind/beside the viewer drop out (the biggest single non-terrain diluter
    // of the drawn-instance cut).
    state.wallChunks = buildChunkedInstances({
        geo, material: wallMat, instances: wallInstances, half,
        castShadow: true, receiveShadow: true, name: 'wall',
        apply: (inst, dm, col) => {
            dm.position.set(inst.x, inst.y, inst.z);
            dm.scale.set(1, 1, 1);
            dm.rotation.set(0, 0, 0);
            // banded stone strata matching the cliff coloring, warmed by sun-facing tint
            const v = worldNoise(inst.x * 2.1 + inst.y * 1.7, inst.z * 2.1, 2, 2.0, 0.5) * 0.05;
            const band = Math.sin(inst.y * 3.2 + worldNoise(inst.x * 0.14, inst.z * 0.14, 2, 2.0, 0.5) * 2.2) * 0.5 + 0.5;
            col.setRGB(
                THREE.MathUtils.lerp(0.40, 0.52, band) + v,
                THREE.MathUtils.lerp(0.38, 0.48, band) + v,
                THREE.MathUtils.lerp(0.38, 0.46, band) + v * 0.8
            );
            return true;
        },
    });

    // 4. Flora & environment details (Phase 4b item 343: sector-chunked so the
    //    world-spanning detail set frustum-culls per sector; DynamicDrawUsage
    //    because the wind sway rewrites animated instances per frame).
    const details = buildFlora(half, V_STEP);
    const detailMat = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.0 }); // instance colors via setColorAt
    state.detailChunks = buildChunkedInstances({
        geo, material: detailMat, instances: details, half, dynamic: true,
        castShadow: true, receiveShadow: true, name: 'flora',
        apply: (d, dm, col) => {
            dm.position.set(d.x, d.y, d.z);
            dm.scale.set(d.sx, d.sy, d.sz);
            dm.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
            col.setHex(d.color);
            return true;
        },
    });
    state.detailInstances = details; // keep for wind animation (global indices)

    // 4b. Precompute wind-animated instance index lists once, so the per-frame
    //     loop never scans static instances (rocks, trunks, pebbles, ...)
    state.windLight = [];   // grass / reeds / cattails / lily pads — always animated
    state.windLeaves = [];  // canopy leaves — skipped on the low quality tier
    for (let i = 0; i < details.length; i++) {
        const k = details[i].kind;
        if (k === 'grass' || k === 'reed' || k === 'cattail' || k === 'lily' || k === 'lilyflower') {
            state.windLight.push(i);
        } else if (k === 'leaf') {
            state.windLeaves.push(i);
        }
    }

    // 5. Voxel clouds (two drifting semi-transparent layers near the horizon)
    buildClouds();

    // 5b. Mountain dressing: waterfall + spring basin pool + magma vent
    buildMountainFeatures();

    // 5c. Lava river winding out of the volcanic vent (+ head pool, embers,
    //     heat shimmer, steam where it meets water)
    buildLava();

    // 6. Points of interest: humanoid statue + distant house roof
    buildPointsOfInterest();

    // 7. Ambient life: fireflies/pollen, falling leaves, distant circling birds
    buildAmbientLife();

    // 7b. Per-zone ambient particles (embers, snow, spores, mist, dust, …)
    buildZoneAmbient();

    // 8. Shared geometry for expanding water-splash ripple rings
    state.rippleGeo = new THREE.RingGeometry(0.6, 0.78, 32);
    state.ripples = [];

    // Obstacle collision radii mapping
    state.obstacles = [];
    for (const t of state.treeList || []) {
        state.obstacles.push({ x: t.x, z: t.z, r: t.r || 0.9 });
    }
    for (const d of details) {
        if (d.kind === 'rock' && d.sx > 0.6) {
            state.obstacles.push({ x: d.x, z: d.z, r: d.sx * 0.8 });
        }
    }

    // 9. Caves — rock shell, dressing, lights & drips. LAST so the wall voxels
    //    it registers as collision obstacles survive the reset above.
    buildCaves();

    // Phase 4b: cache massif silhouette heights for the per-frame occlusion pass.
    primeOcclusion();
}

// Generate a tileable water normals texture procedurally (no external asset).
// Builds a multi-octave ripple height field first, then derives true normals
// from its gradients — far smoother than treating raw noise as normal axes.
function makeWaterNormals() {
    const size = 256;
    // 1) tileable-ish height field: broad swell + fine directional ripples
    const heights = new Float32Array(size * size);
    const TAU = Math.PI * 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            // sample noise on a torus so the texture wraps seamlessly
            const ang1 = (x / size) * TAU, ang2 = (y / size) * TAU;
            const nx = Math.cos(ang1) * 3.2, ny = Math.sin(ang1) * 3.2;
            const nz = Math.cos(ang2) * 3.2, nw = Math.sin(ang2) * 3.2;
            let h = worldNoise(nx + nz, ny + nw, 4, 2.0, 0.55) * 0.7;
            h += worldNoise(nx * 2.6 - nw * 2.6 + 13, ny * 2.6 + nz * 2.6 - 7, 3, 2.0, 0.5) * 0.3;
            // fine wind-driven ripple streaks
            h += Math.sin(ang1 * 6 + ang2 * 2 + worldNoise(nx, nw, 2, 2.0, 0.5) * 4) * 0.08;
            heights[y * size + x] = h;
        }
    }
    // 2) derive normals from height gradients (central differences, wrapped)
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const strength = 1.7; // gentler ripple normals — calm glints, not muddy swirl
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const xm = (x - 1 + size) % size, xp = (x + 1) % size;
            const ym = (y - 1 + size) % size, yp = (y + 1) % size;
            const dx = (heights[y * size + xp] - heights[y * size + xm]) * strength;
            const dy = (heights[yp * size + x] - heights[ym * size + x]) * strength;
            const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
            const i = (y * size + x) * 4;
            img.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
            img.data[i + 1] = (-dy * inv * 0.5 + 0.5) * 255;
            img.data[i + 2] = (inv * 0.5 + 0.5) * 255;
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    state.waterNormalTex = tex; // tracked for disposal
    return tex;
}

// Soft foam texture for the shore ring. RingGeometry uses planar UVs, so the
// foam is painted radially in the unit square: noisy white lace, brightest at
// the outer (shore-touching) edge, fading toward open water.
function makeFoamTexture() {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const innerFrac = (CONFIG.POND_RADIUS - 0.55) / (CONFIG.POND_RADIUS + 0.1); // ring inner/outer ratio
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x / size - 0.5, dy = y / size - 0.5;
            const rr = Math.sqrt(dx * dx + dy * dy) * 2; // 1.0 at the ring's outer edge
            const ang = Math.atan2(dy, dx);
            // seamless angular streaks: sample noise around a circle
            const streak = worldNoise(Math.cos(ang) * 7 + rr * 8, Math.sin(ang) * 7 + 90, 3, 2.0, 0.5) * 0.5 + 0.5;
            // 0 at inner edge -> 1 at outer edge of the ring band
            const t = Math.max(0, Math.min(1, (rr - innerFrac) / (1 - innerFrac)));
            const a = Math.max(0, Math.min(1, Math.pow(t, 1.7) * (0.30 + streak * 0.80)));
            const i = (y * size + x) * 4;
            img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
            img.data[i + 3] = a * 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    state.foamTex = tex; // tracked for disposal
    return tex;
}
