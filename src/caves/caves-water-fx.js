/* ============================================================
   Cave WATER extras — items 81, 82, 87, 89, 90, 91
   ------------------------------------------------------------
   A second, smaller module alongside caves-water.js so that file
   stays focused on the DATA/FIELD/RENDER core; everything here is
   purely additive VISUAL/interactive polish for the one flooded
   (wet) cave, built once in buildCaves right after buildCaveWater
   and animated per-frame in updateCaves right after updateCaveWater
   — same cull/LOD lifecycle (rec.aux, band !== 'far').
     81 — slow icicle growth (ice-kind pools) over SESSION time.
     82 — a themed light shaft filtering down from the ceiling onto
          the primary pool (distinct from the daylight god-rays).
     87 — a rare bioluminescent-algae patch, emissive-only (no new
          light) so it stays within the point-light budget.
     89 — pool-edge ripple response to player footsteps + thrown
          balls passing near the rim.
     90 — a soft caustic-like dapple dancing on the ceiling above
          the lit primary pool.
     91 — a pool-edge foam/dirt ring so pools don't read unnaturally
          clean CG water.
   ============================================================ */

import * as THREE from 'three';
import { state } from '../state.js';
import { caveCeilingAt } from '../heightfield.js';
import { spawnWaterRipple } from '../particles.js';
import { pushAux, buildBoxInstances, matteMaterial } from './caves-decor.js';

const ICICLE_GROW_SECONDS = 240; // items grow to full length over ~4 minutes of session time

function texList() { return (state.caveWaterFxTex = state.caveWaterFxTex || []); }

function causticTex() {
    const s = 64;
    const cv = document.createElement('canvas'); cv.width = cv.height = s;
    const g = cv.getContext('2d');
    for (let i = 0; i < 14; i++) {
        const x = Math.random() * s, y = Math.random() * s, r = 4 + Math.random() * 10;
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, 'rgba(255,255,255,0.9)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping;
    texList().push(t); return t;
}

function shaftGradTex() {
    const s = 48;
    const cv = document.createElement('canvas'); cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, s);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    const t = new THREE.CanvasTexture(cv);
    texList().push(t); return t;
}

/* ---- 81: icicle growth over session time in ice-kind pool chambers ---- */
function buildIcicles(cave, rec, rng) {
    const icePools = (cave.pools || []).filter(p => p.kind === 'ice');
    if (!icePools.length) return null;
    const growState = [];
    const N = icePools.reduce((s, p) => s + 3 + Math.floor(rng() * 3), 0);
    const geo = new THREE.ConeGeometry(0.09, 1, 6);
    geo.translate(0, -0.5, 0); // pivot at the (wide) top so growth stretches DOWNWARD
    const mat = new THREE.MeshStandardMaterial({ color: 0xcfeaf5, roughness: 0.12, metalness: 0.15, transparent: true, opacity: 0.88 });
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.castShadow = false; mesh.receiveShadow = false;
    let idx = 0;
    for (const p of icePools) {
        const n = 3 + Math.floor(rng() * 3);
        for (let i = 0; i < n && idx < N; i++) {
            const a = rng() * Math.PI * 2, rr = rng() * p.r * 0.8;
            const x = p.x + Math.cos(a) * rr, z = p.z + Math.sin(a) * rr;
            const ceil = caveCeilingAt(x, z);
            const topY = isFinite(ceil) ? ceil - 0.05 : p.level + 3;
            growState.push({ x, z, topY, fullLen: 0.4 + rng() * 0.7, idx });
            idx++;
        }
    }
    if (!growState.length) { mesh.geometry.dispose(); mat.dispose(); return null; }
    pushAux(rec, mesh);
    return { mesh, growState, lastGrow: -1 };
}
function updateIcicles(fx, elapsed) {
    if (!fx) return;
    const grow = Math.min(1, elapsed / ICICLE_GROW_SECONDS);
    if (Math.abs(grow - fx.lastGrow) < 0.004) return; // fully grown -> stop rebuilding matrices
    fx.lastGrow = grow;
    const dummy = new THREE.Object3D();
    for (const gs of fx.growState) {
        const len = 0.04 + gs.fullLen * grow;
        dummy.position.set(gs.x, gs.topY, gs.z);
        dummy.scale.set(0.07 + 0.05 * grow, len, 0.07 + 0.05 * grow);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        fx.mesh.setMatrixAt(gs.idx, dummy.matrix);
    }
    fx.mesh.instanceMatrix.needsUpdate = true;
}

/* ---- 82: themed light shaft filtering down onto the primary pool ---- */
function buildPoolShaft(cave, rec, rng) {
    const p = cave.pool; if (!p) return null;
    const ceil = caveCeilingAt(p.x, p.z);
    if (!isFinite(ceil)) return null;
    const height = Math.max(1.4, ceil - 0.2 - p.level);
    const tex = shaftGradTex();
    const color = cave._glow || 0x3fe0d0;
    const mat = new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const geo = new THREE.PlaneGeometry(p.r * 1.1, height);
    const meshes = [];
    for (let q = 0; q < 2; q++) {
        const m = new THREE.Mesh(geo, mat);
        m.rotation.y = (q * Math.PI) / 2;
        m.position.set(p.x, p.level + height / 2, p.z);
        pushAux(rec, m);
        meshes.push(m);
    }
    return { mat, base: 0.1, ph: rng() * 6.283 };
}

/* ---- 87: a rare bioluminescent-algae patch — emissive-only, no new light ---- */
function buildAlgaePatch(cave, rec, rng, getGroundY) {
    if (rng() > 0.3) return;
    const pools = (cave.pools || []).filter(p => p.kind !== 'ice');
    if (!pools.length) return;
    const p = pools[Math.floor(rng() * pools.length)];
    const color = cave._glow || 0x3fe0d0;
    const items = [];
    const patches = 3 + Math.floor(rng() * 4);
    for (let i = 0; i < patches; i++) {
        const a = rng() * Math.PI * 2, rr = rng() * p.r * 0.8;
        const x = p.x + Math.cos(a) * rr, z = p.z + Math.sin(a) * rr;
        items.push({ x, y: p.level + 0.02, z, sx: 0.3 + rng() * 0.35, sy: 0.03, sz: 0.3 + rng() * 0.35, color, rx: 0, ry: rng() * Math.PI, rz: 0 });
    }
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.4, transparent: true, opacity: 0.7 });
    const mesh = buildBoxInstances(items, mat, false);
    if (mesh) pushAux(rec, mesh);
}

/* ---- 90: soft caustic-like dapple dancing on the ceiling above the pool ---- */
function buildPoolCaustics(cave, rec, rng) {
    const p = cave.pool; if (!p) return null;
    const ceil = caveCeilingAt(p.x, p.z);
    if (!isFinite(ceil)) return null;
    const tex = causticTex();
    const color = cave._glow || 0x3fe0d0;
    const mat = new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(p.r * 1.5, 24), mat);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(p.x, ceil - 0.04, p.z);
    pushAux(rec, mesh);
    return { mesh, mat, tex, base: 0.16, ph: rng() * 6.283 };
}

/* ---- 91: pool-edge foam/dirt ring so pools don't read as unnaturally clean ---- */
function buildPoolEdgeDetail(cave, rec, rng, getGroundY) {
    const pools = (cave.pools || []).filter(p => p.kind !== 'ice');
    if (!pools.length) return;
    const items = [];
    for (const p of pools) {
        const n = 9 + Math.floor(rng() * 7);
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + rng() * 0.25, rr = p.r + 0.05 + rng() * 0.28;
            const x = p.x + Math.cos(a) * rr, z = p.z + Math.sin(a) * rr;
            items.push({
                x, y: getGroundY(x, z) + 0.02, z, sx: 0.14 + rng() * 0.14, sy: 0.045, sz: 0.14 + rng() * 0.14,
                color: rng() < 0.5 ? 0x241f19 : 0xd6cdb6, rx: 0, ry: rng() * Math.PI, rz: 0,
            });
        }
    }
    const mesh = buildBoxInstances(items, matteMaterial(), true);
    if (mesh) pushAux(rec, mesh);
}

/* ------------------------------------------------------------
   Build — called from caves.buildCaves right after buildCaveWater,
   for the wet cave only.
   ------------------------------------------------------------ */
export function buildCaveWaterFx(cave, rec, rng, getGroundY) {
    const icicles = buildIcicles(cave, rec, rng);           // 81
    const shaft = buildPoolShaft(cave, rec, rng);            // 82
    buildAlgaePatch(cave, rec, rng, getGroundY);             // 87
    const caustics = buildPoolCaustics(cave, rec, rng);      // 90
    buildPoolEdgeDetail(cave, rec, rng, getGroundY);         // 91
    cave._waterFx = { icicles, shaft, caustics, footAcc: 0 };
}

/* ------------------------------------------------------------
   Per-frame — only while the cave is observed (band !== far),
   called from caves.updateCaves right after updateCaveWater.
   ------------------------------------------------------------ */
export function updateCaveWaterFx(cave, rec, dt, elapsed, band) {
    const fx = cave._waterFx;
    if (!fx) return;
    if (fx.icicles) updateIcicles(fx.icicles, elapsed);
    if (fx.shaft) fx.shaft.mat.opacity = fx.shaft.base * (0.75 + 0.25 * Math.sin(elapsed * 0.7 + fx.shaft.ph));
    if (fx.caustics) {
        fx.caustics.tex.offset.x = (elapsed * 0.03) % 1;
        fx.caustics.tex.offset.y = (elapsed * 0.021) % 1;
        fx.caustics.mat.opacity = fx.caustics.base * (0.7 + 0.3 * Math.sin(elapsed * 0.65 + fx.caustics.ph));
    }
    if (band === 'near' && !state.isPaused) updateRippleResponse(cave, fx, dt); // item 89
}

/* ---- 89: pool-edge ripple response to footsteps + thrown balls ---- */
function updateRippleResponse(cave, fx, dt) {
    const pools = (cave.pools || []).filter(p => p.kind !== 'ice');
    if (!pools.length) return;
    const p = state.player, cam = state.camera && state.camera.position;
    if (p && p.grounded && p.velocity && cam && p.velocity.length() > 0.6) {
        for (const pool of pools) {
            const d = Math.hypot(cam.x - pool.x, cam.z - pool.z);
            if (d > pool.r - 0.25 && d < pool.r + 1.1) {
                fx.footAcc += dt;
                if (fx.footAcc > 0.32) { fx.footAcc = 0; spawnWaterRipple(cam.x, cam.z, pool.level + 0.02); }
                break;
            }
        }
    }
    const projectiles = state.projectiles;
    if (projectiles && projectiles.length) {
        for (const proj of projectiles) {
            if (!proj.active) continue;
            let inAny = false;
            for (const pool of pools) {
                const d = Math.hypot(proj.pos.x - pool.x, proj.pos.z - pool.z);
                if (d < pool.r + 0.3 && Math.abs(proj.pos.y - pool.level) < 0.5) {
                    inAny = true;
                    if (proj._caveRipplePool !== pool) { spawnWaterRipple(proj.pos.x, proj.pos.z, pool.level + 0.02); proj._caveRipplePool = pool; }
                    break;
                }
            }
            if (!inAny) proj._caveRipplePool = null;
        }
    }
}

/* ------------------------------------------------------------
   Teardown — meshes/instancedmeshes live in rec.aux (freed by the
   core cave teardown); here we only drop the shared textures.
   ------------------------------------------------------------ */
export function disposeCaveWaterFx() {
    if (state.caveWaterFxTex) { for (const t of state.caveWaterFxTex) { try { t.dispose(); } catch (e) {} } state.caveWaterFxTex = null; }
}
