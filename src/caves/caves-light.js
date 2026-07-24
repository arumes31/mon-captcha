/* ============================================================
   Cave LIGHTING — Phase 2h (items 25, 26, 27, 29, 30, 33, 35,
   37, 38, 92, 95)
   ------------------------------------------------------------
   The light-emitting half of "make caves FEEL like caves"
   (atmosphere/haze/eye lives in caves-atmos.js). Everything here
   rides the Phase 2e cull layer so open-world frames pay nothing:
   per-cave props go into rec.aux and per-cave lights into rec.lights
   (both culled + flickered by the core updateCaves). The one always-
   present object is the PLAYER LANTERN, which is a single light that
   only turns on inside a cave.

     - player LANTERN (29): a warm point light that follows the camera
       and fades in with state.caveFx.inside, plus a small held glow
       orb near the viewmodel hand. Guarantees a dark cave is always
       playable (targeting/capture readable).
     - ceiling GOD-RAY shafts (25): faded additive crossed-quad shafts
       from ceiling cracks to a bright pool on the floor (NOT real
       volumetrics). Subtle flicker (27). Fewer on medium, none on low.
     - bioluminescent AMBIENT fill (26): a soft cave-hued fill light per
       cave, its strength scaled by that cave's crystal/glow density.
       Uses cave._glow so each chamber reads as a colour landmark (95).
     - colour MIXING (30): warm lantern + teal/theme fill + accent lights
       naturally blend on the walls.
     - entrance daylight HALO (92, 35): an additive daylight bloom at
       each mouth — visible looking back from deep inside (over-exposed
       with the eye-adaptation lift) and a soft glow on approach.
     - distant LURING glow (38): a lone enticing glow orb at the deepest
       dead-end, faintly lit, gently pulsing.
     - lava HEAT-SHIMMER (37): a warm rising shimmer on walls of any cave
       that sits close to the lava course.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state, reuse } from '../state.js';
import { mulberry32 } from '../random.js';
import { CAVES, getGroundY, caveCeilingAt } from '../heightfield.js';
import { inLavaFootprint } from '../lava.js';

const LANTERN_BASE = 6.5;    // warm point-light intensity inside (decay 2) — a POOL
                             // of near light that falls off fast, so deep chambers
                             // stay dark/moody and the theme fill colour still reads

/* ------------------------------------------------------------
   Textures (baked once).
   ------------------------------------------------------------ */
function shaftTexture() {
    const w = 48, h = 128;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
        // brightest just under the ceiling crack, fading toward the floor; soft top/bottom
        const vy = y / (h - 1);
        const vFade = Math.min(1, vy / 0.12) * (1 - Math.max(0, (vy - 0.5)) / 0.5 * 0.55);
        for (let x = 0; x < w; x++) {
            const hx = (x / (w - 1)) * 2 - 1;
            const hFall = Math.max(0, 1 - hx * hx);   // parabolic centre-bright band
            const a = Math.pow(hFall, 1.6) * vFade;
            const idx = (y * w + x) * 4;
            img.data[idx] = 255; img.data[idx + 1] = 240; img.data[idx + 2] = 200;
            img.data[idx + 3] = Math.round(a * 255);
        }
    }
    g.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(cv);
}

function glowTexture(inner) {
    const s = 48;
    const cv = document.createElement('canvas'); cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(inner, 'rgba(255,255,255,0.5)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
}

/* ------------------------------------------------------------
   Build — the lantern (once) + per-cave lighting into the culled layer.
   ------------------------------------------------------------ */
export function buildCaveLight() {
    buildLantern();
    if (!CAVES.length || !state.caveRender) return;

    state.caveShaftTex = shaftTexture();
    state.caveGlowTex = glowTexture(0.45);
    state.caveLight = [];

    const shaftsPerCave = state.qualityLevel === 'low' ? 0 : (state.qualityLevel === 'medium' ? 1 : 2);
    const rng = mulberry32((CONFIG.WORLD_SEED ^ 0x1177) >>> 0);

    for (let ci = 0; ci < CAVES.length; ci++) {
        const c = CAVES[ci];
        const rec = state.caveRender[ci];
        const entry = { rays: [], lure: null, shimmer: null };
        buildGodRays(c, rec, entry, shaftsPerCave, rng);
        buildFillLight(c, rec, rng);
        buildEntranceHalos(c, rec);
        buildLuringGlow(c, rec, entry, rng);
        buildHeatShimmer(c, rec, entry, rng);
        state.caveLight.push(entry);
    }
}

// The player lantern: one warm light + a held glow orb near the hand.
function buildLantern() {
    const l = new THREE.PointLight(0xffb673, 0, 13, 2);
    l.castShadow = false;
    l.visible = false;
    state.scene.add(l);
    state.lantern = l;

    // small held orb near the viewmodel hand (view-space child of the camera)
    const orbTex = glowTexture(0.4);
    const orbMat = new THREE.SpriteMaterial({ map: orbTex, color: 0xffca7a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    const orb = new THREE.Sprite(orbMat);
    orb.scale.setScalar(0.16);
    orb.position.set(0.34, -0.28, -0.7);
    orb.visible = false;
    if (state.camera) state.camera.add(orb);
    state.caveLanternOrb = orb;
    state.caveLanternOrbTex = orbTex;
}

// Faded additive god-ray shafts from ceiling cracks to a floor pool.
function buildGodRays(cave, rec, entry, count, rng) {
    if (count <= 0) return;
    // anchor spots: chambers first, then random mid nodes
    const spots = [];
    for (const ch of cave.chambers) spots.push({ x: ch.x, z: ch.z });
    const main = cave.paths[0];
    for (let i = 2; i < main.length - 2; i += 3) spots.push({ x: main[i].x, z: main[i].z });
    if (!spots.length) return;

    for (let s = 0; s < count && spots.length; s++) {
        const idx = Math.floor(rng() * spots.length);
        const sp = spots.splice(idx, 1)[0];
        const floorY = getGroundY(sp.x, sp.z);
        let ceilY = caveCeilingAt(sp.x, sp.z);
        if (!isFinite(ceilY)) ceilY = floorY + 4.2;
        const height = Math.max(2.4, ceilY - floorY - 0.1);
        const width = 1.1 + rng() * 0.6;

        // crossed additive quads — a slight shared slant reads as raked daylight.
        // Each plane is its own aux entry so the core culls + frees it cleanly.
        const mat = new THREE.MeshBasicMaterial({
            map: state.caveShaftTex, color: 0xffe6b0, transparent: true, opacity: 0.075,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
        });
        const geo = new THREE.PlaneGeometry(width, height);
        const tiltX = (rng() - 0.5) * 0.14, tiltZ = (rng() - 0.5) * 0.18;
        for (let q = 0; q < 2; q++) {
            const pl = new THREE.Mesh(geo, mat);
            pl.rotation.set(tiltX, q * Math.PI / 2, tiltZ);
            pl.position.set(sp.x, floorY + height / 2, sp.z);
            state.scene.add(pl);
            (rec.aux = rec.aux || []).push(pl);
        }

        // bright pool where the shaft meets the floor
        const poolMat = new THREE.MeshBasicMaterial({
            map: state.caveGlowTex, color: 0xffe0a4, transparent: true, opacity: 0.1,
            blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        });
        const pool = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.6, width * 1.6), poolMat);
        pool.rotation.x = -Math.PI / 2;
        pool.position.set(sp.x, floorY + 0.04, sp.z);
        state.scene.add(pool);
        (rec.aux = rec.aux || []).push(pool);

        entry.rays.push({ mat, poolMat, base: 0.075, poolBase: 0.1, ph: rng() * 6.28, x: sp.x, z: sp.z, floorY, height });
    }
}

// Bioluminescent ambient fill — cave-hued, scaled by that cave's glow density.
function buildFillLight(cave, rec, rng) {
    const glowCount = rec.glowMesh ? rec.glowMesh.count : 0;
    // aux emissive detail (crystals/mats/veins) also drives the "how luminous is
    // this cave" read — approximate via aux mesh instance counts.
    let auxEmis = 0;
    if (rec.aux) for (const m of rec.aux) if (m.isInstancedMesh && m.material && m.material.emissive) auxEmis += m.count;
    const density = glowCount + auxEmis * 0.5;
    const base = Math.min(3.8, 1.1 + density * 0.055);
    // seat it at a chamber (or the mid node) up toward the vault
    const ch = cave.chambers[0] || cave.paths[0][Math.floor(cave.paths[0].length / 2)];
    const y = getGroundY(ch.x, ch.z) + 1.6;
    const fill = new THREE.PointLight(cave._glow, base, rec.radius + 9, 2);
    fill.position.set(ch.x, y, ch.z); fill.castShadow = false;
    state.scene.add(fill);
    rec.lights.push({ light: fill, base, flick: 0.4 + rng() * 0.5 });
}

// Additive daylight halo at each mouth — the entrance read (looking back / on approach).
function buildEntranceHalos(cave, rec) {
    for (const e of cave.entrances) {
        const mat = new THREE.SpriteMaterial({ map: state.caveGlowTex, color: 0xffedc6, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
        const halo = new THREE.Sprite(mat);
        const sc = (e.hw + 1.0) * 2.0;
        halo.scale.set(sc, sc, sc);
        halo.position.set(e.x, getGroundY(e.x, e.z) + 1.5, e.z);
        state.scene.add(halo);
        (rec.aux = rec.aux || []).push(halo);
    }
}

// A single enticing glow orb at the deepest dead-end (unreachable-feeling lure).
function buildLuringGlow(cave, rec, entry, rng) {
    // deepest node = the cap / node furthest from any entrance
    let best = null, bd = -1;
    for (const path of cave.paths) for (const n of path) {
        let md = Infinity;
        for (const e of cave.entrances) { const d = Math.hypot(n.x - e.x, n.z - e.z); if (d < md) md = d; }
        if (md > bd) { bd = md; best = n; }
    }
    if (!best || bd < 4) return;
    const hue = new THREE.Color(cave._glow).offsetHSL(0.04, 0.1, 0.12).getHex();
    const mat = new THREE.SpriteMaterial({ map: state.caveGlowTex, color: hue, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
    const orb = new THREE.Sprite(mat);
    orb.scale.setScalar(0.7);
    const y = getGroundY(best.x, best.z) + 0.9 + best.ceilH * 0.25;
    orb.position.set(best.x, y, best.z);
    state.scene.add(orb);
    (rec.aux = rec.aux || []).push(orb);
    entry.lure = { orb, x: best.x, y, z: best.z, ph: rng() * 6.28 };
    if (state.qualityLevel === 'high') {
        const pl = new THREE.PointLight(hue, 1.3, 6, 2);
        pl.position.set(best.x, y, best.z); pl.castShadow = false;
        state.scene.add(pl);
        rec.lights.push({ light: pl, base: 1.3, flick: 1.9 + rng() });
    }
}

// Warm rising heat-shimmer on the wall of a cave that hugs the lava course.
function buildHeatShimmer(cave, rec, entry, rng) {
    if (state.qualityLevel === 'low') return;
    // is any node within reach of the lava footprint?
    let hot = null;
    for (const path of cave.paths) for (const n of path) {
        if (inLavaFootprint(n.x, n.z, 9)) { hot = n; break; }
        if (hot) break;
    }
    if (!hot) return;
    const N = 16;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) pos[i * 3 + 1] = -1000;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xff8a4a, size: 1.1, transparent: true, opacity: 0.1, map: state.caveGlowTex, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    state.scene.add(pts);
    (rec.aux = rec.aux || []).push(pts);
    const motes = [];
    for (let i = 0; i < N; i++) motes.push({ x: hot.x + (rng() - 0.5) * 2.2, z: hot.z + (rng() - 0.5) * 2.2, baseY: getGroundY(hot.x, hot.z) + 0.2, sp: 0.25 + rng() * 0.3, ph: rng() });
    entry.shimmer = { pts, arr: pos, motes };
}

/* ------------------------------------------------------------
   Per-frame — lantern follow/fade + per-cave light animation for
   observed caves (band !== far). Reads state.caveFx (set by
   updateCaveAtmos, which runs first in the loop).
   ------------------------------------------------------------ */
export function updateCaveLight(dt, elapsed) {
    const fx = state.caveFx;
    const mix = fx ? fx.inside : 0;

    // ---- lantern ----
    const l = state.lantern;
    if (l && state.camera) {
        if (mix > 0.01) {
            l.visible = true;
            const cam = state.camera.position;
            state.camera.getWorldDirection(reuse.playerForward);
            const fwdx = reuse.playerForward.x, fwdz = reuse.playerForward.z;
            l.position.set(cam.x + fwdx * 0.6, cam.y - 0.2, cam.z + fwdz * 0.6);
            const flick = 0.9 + 0.06 * Math.sin(elapsed * 6.7) + 0.04 * Math.sin(elapsed * 11.3 + 1.1);
            l.intensity = LANTERN_BASE * mix * flick;
        } else if (l.visible) {
            l.visible = false; l.intensity = 0;
        }
    }
    const orb = state.caveLanternOrb;
    if (orb) {
        orb.visible = mix > 0.02;
        if (orb.visible) orb.material.opacity = 0.55 * mix * (0.9 + 0.1 * Math.sin(elapsed * 6.7));
    }

    // ---- per-cave light animation (only observed caves) ----
    if (!state.caveLight || !state.caveRender) return;
    for (let ci = 0; ci < state.caveLight.length; ci++) {
        const rec = state.caveRender[ci];
        if (!rec || rec.band === 'far') continue;
        const e = state.caveLight[ci];
        for (const r of e.rays) {
            const f = 0.78 + 0.22 * Math.sin(elapsed * 0.9 + r.ph) + 0.05 * Math.sin(elapsed * 3.3 + r.ph);
            r.mat.opacity = r.base * f;
            r.poolMat.opacity = r.poolBase * f;
        }
        if (e.lure) {
            const p = 0.42 + 0.28 * (0.5 + 0.5 * Math.sin(elapsed * 0.8 + e.lure.ph));
            e.lure.orb.material.opacity = p;
            e.lure.orb.position.y = e.lure.y + Math.sin(elapsed * 0.6 + e.lure.ph) * 0.12;
        }
        if (e.shimmer) animateShimmer(e.shimmer, elapsed);
    }
}

function animateShimmer(sh, elapsed) {
    const arr = sh.arr;
    for (let i = 0; i < sh.motes.length; i++) {
        const m = sh.motes[i];
        const t = (elapsed * m.sp + m.ph) % 1;
        arr[i * 3] = m.x + Math.sin(elapsed * 2 + m.ph * 6.28) * 0.14;
        arr[i * 3 + 1] = m.baseY + t * 2.6;
        arr[i * 3 + 2] = m.z + Math.cos(elapsed * 1.7 + m.ph * 6.28) * 0.14;
    }
    sh.pts.material.opacity = 0.1 * (0.7 + 0.3 * Math.sin(elapsed * 3));
    sh.pts.geometry.attributes.position.needsUpdate = true;
}

/* ------------------------------------------------------------
   Teardown — per-cave props/lights live in rec.aux / rec.lights and
   are freed by the core cave teardown; here only the globals.
   ------------------------------------------------------------ */
export function disposeCaveLight() {
    if (state.lantern) { if (state.scene) state.scene.remove(state.lantern); state.lantern = null; }
    if (state.caveLanternOrb) {
        if (state.camera) state.camera.remove(state.caveLanternOrb);
        try { state.caveLanternOrb.material.dispose(); } catch (e) {}
        state.caveLanternOrb = null;
    }
    if (state.caveLanternOrbTex) { try { state.caveLanternOrbTex.dispose(); } catch (e) {} state.caveLanternOrbTex = null; }
    if (state.caveShaftTex) { try { state.caveShaftTex.dispose(); } catch (e) {} state.caveShaftTex = null; }
    if (state.caveGlowTex) { try { state.caveGlowTex.dispose(); } catch (e) {} state.caveGlowTex = null; }
    state.caveLight = null;
}
