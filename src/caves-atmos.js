/* ============================================================
   Cave ATMOSPHERE — Phase 2h (items 28, 31, 32, 34, 93, 94)
   ------------------------------------------------------------
   The half of "make caves FEEL like caves" that is air, depth and
   the player's EYE rather than light sources (those live in
   caves-light.js). Everything here engages only when the player is
   near/inside a cave — it rides the Phase 2e cull layer (rec.aux)
   or is gated on state.caveFx.inside — so open-world frames pay
   nothing.

     - EYE-ADAPTATION + GENUINELY DARK deep chambers (34, 28):
       maintains state.caveFx = { ambientMul, exposureMul, fogK,
       fogDensity, fogColor, inside, depth }. Weather READS this each
       frame (applyEnvironment) so the outdoor look is untouched:
       ambientMul/exposureMul are EXACTLY 1 and fogK EXACTLY 0 when
       settled outside, so exposure returns precisely to the
       weather-driven value. Inside, hemi/sky-fill fall off with
       depth (dark) while exposure lifts on a slow lag (the eye
       adjusting) — dark but readable, and stepping back into daylight
       is briefly over-bright, then settles. The lantern + glow carry
       the interior (see caves-light.js). Darkness floor is HIGHER on
       low tier so it never goes pitch black.
     - localized cave HAZE (32): a denser, cooler fog target the
       weather module blends toward by fogK — no change to the global
       outdoor FogExp2, restored on exit.
     - backlit DUST motes (31): a slow drifting mote field around the
       camera, faded in with `inside` (additive → reads backlit in the
       light shafts). Skipped on low.
     - cool-threshold / DRAFT streams (93, 94): per-cave wisps flowing
       along each mouth axis — cool air at the threshold on approach
       from outside AND air-current wayfinding inward.
     - firefly motes near glow mushrooms + wet-wall glints — small
       per-cave sparkle systems in the culled layer.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { mulberry32 } from './random.js';
import { CAVES, caveAt, getGroundY } from './heightfield.js';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Depth (units past the nearest mouth) at which the interior is fully "deep":
// darkness + haze + exposure lift reach their maximum here. Near a mouth the
// scene stays near-outdoor so the transition is seamless.
const DEPTH_FULL = 8.5;

// Cave haze target (the weather module lerps the outdoor fog toward this by
// fogK). Denser + cooler than the golden-hour haze so depth reads.
const CAVE_FOG_DENSITY = 0.045;
const CAVE_FOG_COLOR = 0x0b1016;

// Per-tier darkness floor + exposure lift (item 28/34). Low stays visibly lit.
function tierAtmos(q) {
    if (q === 'low') return { darkFloor: 0.56, bright: 1.09, dust: 0 };
    if (q === 'medium') return { darkFloor: 0.40, bright: 1.14, dust: 90 };
    return { darkFloor: 0.30, bright: 1.18, dust: 150 };
}

// smoothed mixes (module state; eased toward the target each frame)
let ambMix = 0;    // fast → drives darkness + haze
let expMix = 0;    // slow → drives exposure (the eye lag = adaptation transient)
let insideSmooth = 0; // dust / draft activation

/* ------------------------------------------------------------
   Sprite helpers (soft round falloff — one texture per kind).
   ------------------------------------------------------------ */
function radialTex(inner) {
    const s = 32;
    const cv = document.createElement('canvas'); cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(inner, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
}

/* ------------------------------------------------------------
   Build — per-cave atmos into the culled rec.aux layer + a single
   global dust field. Called at the tail of buildCaves (state.caveRender
   is populated; cave._decor exists from the theme packs).
   ------------------------------------------------------------ */
export function buildCaveAtmos() {
    // identity so the outdoor look is exact until the player nears a cave
    state.caveFx = { ambientMul: 1, exposureMul: 1, fogK: 0, fogDensity: CAVE_FOG_DENSITY, fogColor: CAVE_FOG_COLOR, inside: 0, depth: 0 };
    ambMix = 0; expMix = 0; insideSmooth = 0;
    if (!CAVES.length || !state.caveRender) return;

    const tier = tierAtmos(state.qualityLevel);
    state.caveAtmosTex = radialTex(0.5);
    state.caveAtmos = [];

    // shared dust field (skipped on low)
    if (tier.dust > 0) buildDust(tier.dust);
    else { state.caveDust = null; state.caveDustData = null; }

    const rng = mulberry32((CONFIG.WORLD_SEED ^ 0x0a71) >>> 0);
    for (let ci = 0; ci < CAVES.length; ci++) {
        const c = CAVES[ci];
        const rec = state.caveRender[ci];
        const entry = { drafts: null, draftData: null, flies: null, flyData: null, glints: null, glintData: null };
        buildDrafts(c, rec, entry, rng);
        if (state.qualityLevel !== 'low') buildFireflies(c, rec, entry, rng);
        if (c.wet && c.pool) buildGlints(c, rec, entry, rng);
        state.caveAtmos.push(entry);
    }
}

function makePoints(rec, count, color, size, opacity, additive) {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) pos[i * 3 + 1] = -1000;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
        color, size, transparent: true, opacity, map: state.caveAtmosTex,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    state.scene.add(pts);
    (rec.aux = rec.aux || []).push(pts); // culled + disposed with the cave
    return { pts, arr: pos };
}

// Backlit dust — a slow warm mote field kept in a box around the camera.
function buildDust(count) {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) pos[i * 3 + 1] = -1000;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
        color: 0xffe9c8, size: 0.055, transparent: true, opacity: 0.0, map: radialTex(0.4),
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.visible = false;
    state.scene.add(pts);
    state.caveDust = pts;
    state.caveDustTex = mat.map;
    const motes = [];
    for (let i = 0; i < count; i++) motes.push({ x: 0, y: -1000, z: 0, drift: 0.05 + Math.random() * 0.08, phase: Math.random() * 6.28, amp: 0.15 + Math.random() * 0.25 });
    state.caveDustData = { motes, arr: pos, seeded: false };
}

// Cool-air draft streams flowing inward along each mouth axis.
function buildDrafts(cave, rec, entry, rng) {
    const perMouth = state.qualityLevel === 'low' ? 5 : 9;
    const total = cave.entrances.length * perMouth;
    const { pts, arr } = makePoints(rec, total, 0xbfe0f0, 0.5, 0.0, false);
    const streams = [];
    for (const e of cave.entrances) {
        for (let i = 0; i < perMouth; i++) {
            streams.push({
                ex: e.x, ez: e.z, ix: -e.dx, iz: -e.dz, nx: -e.dz, nz: e.dx, // inward + lateral
                phase: rng(), speed: 0.11 + rng() * 0.09, lat: (rng() - 0.5) * (e.hw || 1) * 1.1,
                bob: rng() * 6.28, len: 5 + rng() * 3,
            });
        }
    }
    entry.drafts = pts; entry.draftData = { streams, arr };
    pts.userData.baseOpacity = 0.32;
}

// Warm firefly motes hovering near the cave's glow mushrooms / chamber.
function buildFireflies(cave, rec, entry, rng) {
    const anchors = [];
    const dec = cave._decor;
    if (dec && dec.mushrooms) for (const m of dec.mushrooms) anchors.push({ x: m.x, y: m.y, z: m.z });
    // fungal / flooded caves get extra motes at chamber centres even without decor
    if ((cave.theme === 'fungal' || cave.theme === 'flooded')) for (const ch of cave.chambers) anchors.push({ x: ch.x, y: getGroundY(ch.x, ch.z) + 0.6, z: ch.z });
    if (!anchors.length) { entry.flies = null; return; }
    const count = Math.min(16, anchors.length * 2 + 2);
    const { pts, arr } = makePoints(rec, count, 0xfff0a8, 0.09, 0.0, true);
    const flies = [];
    for (let i = 0; i < count; i++) {
        const a = anchors[Math.floor(rng() * anchors.length)];
        flies.push({ ax: a.x, ay: a.y + 0.3, az: a.z, r: 0.5 + rng() * 0.9, sp: 0.5 + rng() * 0.7, ph: rng() * 6.28, vph: rng() * 6.28 });
    }
    entry.flies = pts; entry.flyData = { flies, arr };
    pts.userData.baseOpacity = 0.9;
}

// Wet-wall / pool glints — tiny bright specks catching light at the waterline.
function buildGlints(cave, rec, entry, rng) {
    const p = cave.pool;
    const count = state.qualityLevel === 'low' ? 6 : 14;
    const { pts, arr } = makePoints(rec, count, 0xdff6ff, 0.07, 0.0, true);
    const glints = [];
    for (let i = 0; i < count; i++) {
        const a = rng() * Math.PI * 2, rr = p.r * (0.7 + rng() * 0.7);
        const x = p.x + Math.cos(a) * rr, z = p.z + Math.sin(a) * rr;
        glints.push({ x, y: p.level + 0.05 + rng() * 0.5, z, tw: 0.6 + rng() * 1.8, ph: rng() * 6.28 });
    }
    entry.glints = pts; entry.glintData = { glints, arr };
    pts.userData.baseOpacity = 0.95;
}

/* ------------------------------------------------------------
   Per-frame update — eye-adaptation + darkness + haze (always), and
   per-cave atmos animation only for observed caves (band !== far).
   ------------------------------------------------------------ */
export function updateCaveAtmos(dt, elapsed) {
    const fx = state.caveFx;
    if (!fx) return;
    const cam = state.camera && state.camera.position;
    const inCave = !!(state.player && state.player.inCave) && !!cam;

    // ---- depth of the player into the occupied cave (0 at a mouth) ----
    let depth01 = 0;
    if (inCave) {
        const c = caveAt(cam.x, cam.z) || nearestCave(cam.x, cam.z);
        if (c) {
            let md = Infinity;
            for (const e of c.entrances) { const d = Math.hypot(cam.x - e.x, cam.z - e.z); if (d < md) md = d; }
            depth01 = clamp01(md / DEPTH_FULL);
        }
    }

    // ---- eased mixes: ambient fast (darkness), exposure slow (eye lag) ----
    const target = inCave ? depth01 : 0;
    ambMix += (target - ambMix) * Math.min(1, dt * 4.0);
    expMix += (target - expMix) * Math.min(1, dt * 1.4);
    insideSmooth += ((inCave ? 1 : 0) - insideSmooth) * Math.min(1, dt * 3.5);

    const tier = tierAtmos(state.qualityLevel);
    fx.ambientMul = lerp(1, tier.darkFloor, ambMix);
    fx.exposureMul = lerp(1, tier.bright, expMix);
    fx.fogK = ambMix;
    fx.inside = insideSmooth;
    fx.depth = depth01;
    // snap to EXACT identity when settled outside so the outdoor exposure/fog
    // returned to weather are byte-for-byte the weather-driven values.
    if (!inCave && ambMix < 0.0025 && expMix < 0.0025 && insideSmooth < 0.0025) {
        ambMix = 0; expMix = 0; insideSmooth = 0;
        fx.ambientMul = 1; fx.exposureMul = 1; fx.fogK = 0; fx.inside = 0; fx.depth = 0;
    }

    // ---- dust motes (kept in a box around the camera; faded by inside) ----
    updateDust(dt, elapsed, cam);

    // ---- per-cave atmos only for observed caves ----
    if (!state.caveAtmos || !state.caveRender) return;
    for (let ci = 0; ci < state.caveAtmos.length; ci++) {
        const rec = state.caveRender[ci];
        if (!rec || rec.band === 'far') continue;
        const a = state.caveAtmos[ci];
        animateDrafts(a, elapsed);
        animateFireflies(a, elapsed);
        animateGlints(a, elapsed);
    }
}

function nearestCave(x, z) {
    let best = null, bd = Infinity;
    for (const c of CAVES) { const d = Math.hypot(x - (c.minX + c.maxX) / 2, z - (c.minZ + c.maxZ) / 2); if (d < bd) { bd = d; best = c; } }
    return best;
}

function updateDust(dt, elapsed, cam) {
    const dust = state.caveDust, data = state.caveDustData;
    if (!dust || !data || !cam) return;
    const op = state.caveFx.inside * 0.5;
    if (op < 0.01) { if (dust.visible) { dust.visible = false; dust.material.opacity = 0; } return; }
    dust.visible = true;
    dust.material.opacity = op;
    const R = 7, TOP = 5, BOT = 3;
    const motes = data.motes, arr = data.arr;
    for (let i = 0; i < motes.length; i++) {
        const m = motes[i];
        if (!data.seeded || m.y < cam.y - BOT - 1 || m.y > cam.y + TOP + 1 || Math.abs(m.x - cam.x) > R + 1 || Math.abs(m.z - cam.z) > R + 1) {
            m.x = cam.x + (Math.random() * 2 - 1) * R;
            m.z = cam.z + (Math.random() * 2 - 1) * R;
            m.y = cam.y - BOT + Math.random() * (TOP + BOT);
        }
        m.y += m.drift * dt; // rise slowly like fine dust
        arr[i * 3] = m.x + Math.sin(elapsed * 0.4 + m.phase) * m.amp;
        arr[i * 3 + 1] = m.y;
        arr[i * 3 + 2] = m.z + Math.cos(elapsed * 0.33 + m.phase) * m.amp;
    }
    data.seeded = true;
    dust.geometry.attributes.position.needsUpdate = true;
}

function animateDrafts(a, elapsed) {
    if (!a.drafts) return;
    a.drafts.material.opacity = a.drafts.userData.baseOpacity;
    const S = a.draftData.streams, arr = a.draftData.arr;
    for (let i = 0; i < S.length; i++) {
        const s = S[i];
        const t = (elapsed * s.speed + s.phase) % 1;      // 0 (outside mouth) -> 1 (inward)
        const along = -1.2 + t * s.len;                    // start just outside the arch
        const lat = s.lat + Math.sin(elapsed * 0.6 + s.bob) * 0.35;
        arr[i * 3] = s.ex + s.ix * along + s.nx * lat;
        arr[i * 3 + 1] = getGroundY(s.ex + s.ix * along, s.ez + s.iz * along) + 0.7 + Math.sin(elapsed * 0.5 + s.bob) * 0.35;
        arr[i * 3 + 2] = s.ez + s.iz * along + s.nz * lat;
    }
    a.drafts.geometry.attributes.position.needsUpdate = true;
}

function animateFireflies(a, elapsed) {
    if (!a.flies) return;
    a.flies.material.opacity = a.flyData ? (0.55 + 0.45 * Math.abs(Math.sin(elapsed * 1.7))) * 0.9 : 0.9;
    const F = a.flyData.flies, arr = a.flyData.arr;
    for (let i = 0; i < F.length; i++) {
        const f = F[i];
        arr[i * 3] = f.ax + Math.cos(elapsed * f.sp + f.ph) * f.r;
        arr[i * 3 + 1] = f.ay + Math.sin(elapsed * f.sp * 0.8 + f.vph) * 0.35;
        arr[i * 3 + 2] = f.az + Math.sin(elapsed * f.sp + f.ph) * f.r;
    }
    a.flies.geometry.attributes.position.needsUpdate = true;
}

function animateGlints(a, elapsed) {
    if (!a.glints) return;
    const G = a.glintData.glints, arr = a.glintData.arr;
    let anyOn = false;
    for (let i = 0; i < G.length; i++) {
        const g = G[i];
        const tw = 0.5 + 0.5 * Math.sin(elapsed * g.tw + g.ph);
        if (tw > 0.5) anyOn = true;
        // park a glint far below when it's twinkled off (cheap flicker)
        arr[i * 3] = g.x; arr[i * 3 + 1] = tw > 0.35 ? g.y : -1000; arr[i * 3 + 2] = g.z;
    }
    a.glints.material.opacity = a.glints.userData.baseOpacity * (anyOn ? 1 : 0.4);
    a.glints.geometry.attributes.position.needsUpdate = true;
}

/* ------------------------------------------------------------
   Teardown — the per-cave Points live in rec.aux and are disposed by
   the core cave teardown; here we only drop the globals + textures and
   restore the caveFx identity so a re-init starts clean.
   ------------------------------------------------------------ */
export function disposeCaveAtmos() {
    if (state.caveDust) {
        if (state.scene) state.scene.remove(state.caveDust);
        try { state.caveDust.geometry.dispose(); } catch (e) {}
        try { state.caveDust.material.dispose(); } catch (e) {}
        state.caveDust = null; state.caveDustData = null;
    }
    if (state.caveDustTex) { try { state.caveDustTex.dispose(); } catch (e) {} state.caveDustTex = null; }
    if (state.caveAtmosTex) { try { state.caveAtmosTex.dispose(); } catch (e) {} state.caveAtmosTex = null; }
    state.caveAtmos = null;
    state.caveFx = { ambientMul: 1, exposureMul: 1, fogK: 0, fogDensity: CAVE_FOG_DENSITY, fogColor: CAVE_FOG_COLOR, inside: 0, depth: 0 };
}
