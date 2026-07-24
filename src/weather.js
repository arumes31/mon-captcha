/* ============================================================
   Weather — seeded, zone-biased procedural weather
   ------------------------------------------------------------
   Phase 2c. Drives clear / overcast / rain / thunderstorm /
   snowfall / fog / windy over the golden-hour baseline. Holds a
   state ~1-3 min, then BLENDS smoothly (~18s) to a seeded next
   state weighted by the zone the player stands in (weather-data).

   Hooks:
     - sky dome (turbidity/rayleigh), FogExp2 (density + colour),
       sun / hemi / sky-fill intensity, tone-mapping exposure —
       all lerped from the engine's captured baseline
     - rain streaks (wind-slanted LineSegments) + splash rings on
       water; snowfall (drifting Points); both follow the camera
     - lightning flash (exposure/hemi spike, multi-flicker) with a
       delayed one-shot synth thunder (audio.js)
     - a wind-gust level published to state.weatherWind (+ dir) so
       the flora sway and drifting motes stiffen during gusts
   Quality: low tier stays clear / minimal (no precip, no flash).
   Gesture-independent (visual), but thunder respects the audio
   gate. forceWeather()/weatherState() are ?probe hooks.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { mulberry32 } from './random.js';
import { isWaterAt } from './heightfield.js';
import { zoneAt } from './zones.js';
import { spawnWaterRipple } from './particles.js';
import { playThunder } from './audio.js';
import { WEATHER_STATES, WEATHER_BIAS, WEATHER_DEFAULT_BIAS } from './weather-data.js';

const RAIN_MAX = 1200;
const SNOW_MAX = 1500;
const BLEND_DUR = 18;                 // seconds to cross-fade between states
const HOLD_MIN = 60, HOLD_SPAN = 120; // 1-3 minutes between transitions

const W = {
    rng: null,
    base: null,        // captured baseline (fog/sun/hemi/skyFill/exposure/turbidity/rayleigh)
    cur: 'clear', nxt: 'clear', t: 1,  // blend factor cur->nxt
    time: 0, nextAt: HOLD_MIN,
    forced: false,
    windDir: { x: 1, z: 0 },
    flashK: 0, flashFlicker: 0,
    splashAcc: 0, strikeCd: 0,
};

const lerp = (a, b, t) => a + (b - a) * t;
const _cA = new THREE.Color(), _cB = new THREE.Color(), _cC = new THREE.Color(), _cCave = new THREE.Color();
// Phase 2h: identity cave overrides so weather is byte-identical outdoors when
// caves-atmos hasn't set state.caveFx yet (or the player is out in the open).
const CAVE_FX_ID = { ambientMul: 1, exposureMul: 1, fogK: 0, fogDensity: 0, fogColor: 0x0b1016 };

/* ------------------------------------------------------------
   Init — capture baseline, seed, build precipitation pools.
   ------------------------------------------------------------ */
export function initWeather() {
    W.rng = mulberry32((CONFIG.WORLD_SEED ^ 0x3a17e2) >>> 0);
    W.cur = 'clear'; W.nxt = 'clear'; W.t = 1; W.forced = false;
    W.time = 0; W.nextAt = HOLD_MIN + W.rng() * HOLD_SPAN;
    W.flashK = 0; W.splashAcc = 0; W.strikeCd = 0;
    const ang = W.rng() * Math.PI * 2;
    W.windDir = { x: Math.cos(ang), z: Math.sin(ang) };

    const scene = state.scene, sun = state.sun, hemi = state.hemi, skyFill = state.skyFill;
    W.base = {
        fog: scene && scene.fog ? scene.fog.density : 0.0036,
        fogColor: (scene && scene.fog ? scene.fog.color.getHex() : 0xf2dcb3),
        sun: sun ? sun.intensity : 3.6,
        hemi: hemi ? hemi.intensity : 1.5,
        skyFill: skyFill ? skyFill.intensity : 0.65,
        exposure: state.renderer ? state.renderer.toneMappingExposure : 1.08,
        turbidity: 2.4, rayleigh: 2.0,
    };

    buildPrecip();
    state.weatherWind = 0.15;
    state.weatherWindDir = W.windDir;
}

function buildPrecip() {
    // rain: wind-slanted streaks as LineSegments (2 verts each)
    const rpos = new Float32Array(RAIN_MAX * 2 * 3);
    for (let i = 0; i < RAIN_MAX * 2; i++) rpos[i * 3 + 1] = -1000;
    const rgeo = new THREE.BufferGeometry();
    rgeo.setAttribute('position', new THREE.BufferAttribute(rpos, 3));
    const rmat = new THREE.LineBasicMaterial({ color: 0xaebccc, transparent: true, opacity: 0.0, depthWrite: false });
    const rain = new THREE.LineSegments(rgeo, rmat);
    rain.frustumCulled = false;
    state.scene.add(rain);
    state.rain = rain;
    const rdrops = [];
    for (let i = 0; i < RAIN_MAX; i++) rdrops.push({ x: 0, y: -1000, z: 0, len: 1.7 + Math.random() * 1.5, sp: 36 + Math.random() * 16 });
    state.rainDrops = rdrops;

    // snow: drifting soft points
    const spos = new Float32Array(SNOW_MAX * 3);
    for (let i = 0; i < SNOW_MAX; i++) spos[i * 3 + 1] = -1000;
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.BufferAttribute(spos, 3));
    const smat = new THREE.PointsMaterial({
        color: 0xffffff, size: 0.24, transparent: true, opacity: 0.0,
        map: makeFlakeSprite(), depthWrite: false, sizeAttenuation: true,
    });
    const snow = new THREE.Points(sgeo, smat);
    snow.frustumCulled = false;
    state.scene.add(snow);
    state.snow = snow;
    state.snowTex = smat.map;
    const flakes = [];
    for (let i = 0; i < SNOW_MAX; i++) flakes.push({ x: 0, y: -1000, z: 0, sp: 1.4 + Math.random() * 1.2, phase: Math.random() * 6.28, amp: 0.4 + Math.random() * 0.8 });
    state.snowFlakes = flakes;
}

function makeFlakeSprite() {
    const s = 16;
    const cv = document.createElement('canvas'); cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.7)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
}

/* ------------------------------------------------------------
   Zone-biased next-state roll.
   ------------------------------------------------------------ */
function rollNext() {
    let table = WEATHER_DEFAULT_BIAS;
    try {
        if (state.camera) {
            const z = zoneAt(state.camera.position.x, state.camera.position.z);
            if (z && WEATHER_BIAS[z.id]) table = WEATHER_BIAS[z.id];
        }
    } catch (e) {}
    let total = 0;
    for (const [, w] of table) total += w;
    let roll = W.rng() * total;
    for (const [s, w] of table) { roll -= w; if (roll <= 0) return s; }
    return table[0][0];
}

/* ------------------------------------------------------------
   Probe hooks: force a state (holds it), read current.
   ------------------------------------------------------------ */
export function forceWeather(name) {
    if (!WEATHER_STATES[name]) return false;
    W.cur = name; W.nxt = name; W.t = 1; W.forced = true;
    return true;
}
export function weatherState() {
    return { cur: W.cur, next: W.nxt, t: +W.t.toFixed(3), forced: W.forced, wind: +(state.weatherWind || 0).toFixed(2) };
}
// Fire a lightning flash on demand (test rig — catch a flash frame in a shot).
export function forceLightning() { W.flashK = 1.0; W.strikeCd = 3; }

/* ------------------------------------------------------------
   Per-frame update.
   ------------------------------------------------------------ */
export function updateWeather(dt, elapsed) {
    if (!W.base || !state.scene) return;
    const low = state.qualityLevel === 'low';

    // ---- schedule / advance the blend (paused while forced, low, or unlocked-pause) ----
    if (!W.forced && !low) {
        W.time += dt;
        if (W.t < 1) {
            W.t = Math.min(1, W.t + dt / BLEND_DUR);
            if (W.t >= 1) { W.cur = W.nxt; W.nextAt = W.time + HOLD_MIN + W.rng() * HOLD_SPAN; }
        } else if (W.time >= W.nextAt) {
            let n = rollNext();
            if (n === W.cur) n = rollNext();
            W.nxt = n; W.t = 0;
        }
    }

    // ---- blended parameters ----
    const A = WEATHER_STATES[W.cur] || WEATHER_STATES.clear;
    const B = WEATHER_STATES[W.nxt] || A;
    const t = low ? 0 : W.t;              // low tier holds clear
    const Aw = low ? WEATHER_STATES.clear : A;
    const Bw = low ? WEATHER_STATES.clear : B;
    const P = {
        fogMul: lerp(Aw.fogMul, Bw.fogMul, t), sunMul: lerp(Aw.sunMul, Bw.sunMul, t),
        hemiMul: lerp(Aw.hemiMul, Bw.hemiMul, t), skyFillMul: lerp(Aw.skyFillMul, Bw.skyFillMul, t),
        exposureMul: lerp(Aw.exposureMul, Bw.exposureMul, t),
        turbidity: lerp(Aw.turbidity, Bw.turbidity, t), rayleigh: lerp(Aw.rayleigh, Bw.rayleigh, t),
        wind: lerp(Aw.wind, Bw.wind, t),
    };
    const rainAmt = precipAmt(Aw, Bw, t, 'rain');
    const snowAmt = precipAmt(Aw, Bw, t, 'snow');
    const stormAmt = (Aw.lightning ? 1 - t : 0) + (Bw.lightning ? t : 0);

    // ---- wind (gusting) published for flora sway + mote drift ----
    const gust = P.wind * (0.65 + 0.35 * Math.sin(elapsed * 0.55) + 0.2 * Math.sin(elapsed * 1.7 + 1.3));
    state.weatherWind = Math.max(0, gust);
    state.weatherWindDir = W.windDir;

    // ---- lightning strikes ----
    W.strikeCd -= dt;
    if (stormAmt > 0.35 && W.strikeCd <= 0 && !state.isPaused) {
        if (Math.random() < stormAmt * 0.04) triggerLightning(elapsed);
    }
    if (W.flashK > 0) W.flashK = Math.max(0, W.flashK - dt * 5.0);
    const flash = W.flashK * (0.75 + 0.25 * Math.abs(Math.sin(elapsed * 55))); // bright, flickering

    // ---- apply sky / fog / lights ----
    applyEnvironment(P, flash);

    // ---- precipitation ----
    updateRain(dt, rainAmt);
    updateSnow(dt, elapsed, snowAmt);
}

function precipAmt(A, B, t, kind) {
    const a = A.precip && A.precip.kind === kind ? A.precip.rate : 0;
    const b = B.precip && B.precip.kind === kind ? B.precip.rate : 0;
    return lerp(a, b, t);
}

function applyEnvironment(P, flash) {
    const scene = state.scene;
    // Phase 2h: cave overrides (darkness / eye-adaptation exposure / localized
    // haze). IDENTITY (mul 1, fogK 0) whenever the player is out in the open, so
    // the outdoor look — and the exposure returned on leaving — is exactly the
    // weather-driven value. Sun is NOT dimmed: the daylight mouth stays bright
    // (and over-exposes with the eye-adaptation lift, seen from deep inside).
    const fx = state.caveFx || CAVE_FX_ID;
    if (scene.fog) {
        let dens = W.base.fog * P.fogMul;
        _cA.setHex(W.base.fogColor);
        // current fog colour target = blend of the two states' fogColor
        const A = WEATHER_STATES[W.cur] || WEATHER_STATES.clear;
        const B = WEATHER_STATES[W.nxt] || A;
        _cB.setHex((state.qualityLevel === 'low') ? WEATHER_STATES.clear.fogColor : A.fogColor);
        _cC.setHex((state.qualityLevel === 'low') ? WEATHER_STATES.clear.fogColor : B.fogColor);
        _cB.lerp(_cC, state.qualityLevel === 'low' ? 0 : W.t);
        if (flash > 0.01) _cB.lerp(_cA.setHex(0xf5f7ff), Math.min(0.6, flash));
        if (fx.fogK > 0) { // localized cave haze, restored automatically as fogK → 0 outside
            dens += (fx.fogDensity - dens) * fx.fogK;
            _cB.lerp(_cCave.setHex(fx.fogColor), fx.fogK);
        }
        scene.fog.density = dens;
        scene.fog.color.copy(_cB);
    }
    if (state.sun) state.sun.intensity = W.base.sun * P.sunMul + flash * 4.5;
    if (state.hemi) state.hemi.intensity = W.base.hemi * P.hemiMul * fx.ambientMul + flash * 6.5;
    if (state.skyFill) state.skyFill.intensity = W.base.skyFill * P.skyFillMul * fx.ambientMul + flash * 3.0;
    if (state.renderer) state.renderer.toneMappingExposure = W.base.exposure * P.exposureMul * fx.exposureMul + flash * 0.7;
    if (state.sky) {
        const u = state.sky.material.uniforms;
        if (u.turbidity) u.turbidity.value = P.turbidity;
        if (u.rayleigh) u.rayleigh.value = P.rayleigh;
    }
}

function triggerLightning(elapsed) {
    W.flashK = 1.0;
    W.strikeCd = 2.5 + Math.random() * 6;
    // delayed thunder (one-shot); farther strike = longer delay, duller boom
    const far = Math.random();
    const delay = 300 + far * 2200;
    setTimeout(() => { if (!state.disposed) playThunder(far); }, delay);
}

/* ------------------------------------------------------------
   Rain — wind-slanted streaks in a box tracking the camera.
   ------------------------------------------------------------ */
function updateRain(dt, amount) {
    const rain = state.rain, drops = state.rainDrops;
    if (!rain || !drops) return;
    if (amount <= 0.001) { if (rain.material.opacity > 0) { rain.material.opacity = 0; rain.visible = false; } return; }
    rain.visible = true;
    rain.material.opacity = Math.min(0.68, 0.5 * amount);
    const cam = state.camera.position;
    const R = 22, TOP = 22, active = Math.floor(RAIN_MAX * Math.min(1, amount));
    const wx = W.windDir.x * (state.weatherWind || 0), wz = W.windDir.z * (state.weatherWind || 0);
    const pos = rain.geometry.attributes.position.array;
    for (let i = 0; i < RAIN_MAX; i++) {
        const d = drops[i];
        if (i >= active) { pos[i * 6 + 1] = -1000; pos[i * 6 + 4] = -1000; continue; }
        if (d.y < cam.y - 6 || d.y > cam.y + TOP + 4 || Math.abs(d.x - cam.x) > R + 4 || Math.abs(d.z - cam.z) > R + 4) {
            d.x = cam.x + (Math.random() * 2 - 1) * R;
            d.z = cam.z + (Math.random() * 2 - 1) * R;
            // respawn anywhere in the column so it fills instantly (streaks fall fast)
            d.y = cam.y - 5 + Math.random() * (TOP + 5);
        }
        d.y -= d.sp * dt;
        d.x += wx * 2.2 * dt; d.z += wz * 2.2 * dt;
        // streak: top -> bottom, tilted by wind
        const bx = d.x - wx * 0.09 * d.len, bz = d.z - wz * 0.09 * d.len;
        pos[i * 6] = d.x; pos[i * 6 + 1] = d.y + d.len; pos[i * 6 + 2] = d.z;
        pos[i * 6 + 3] = bx; pos[i * 6 + 4] = d.y; pos[i * 6 + 5] = bz;
    }
    rain.geometry.attributes.position.needsUpdate = true;

    // splash rings where drops meet water (throttled)
    W.splashAcc += dt;
    if (W.splashAcc > 0.06 && !state.isPaused) {
        W.splashAcc = 0;
        for (let k = 0; k < 2; k++) {
            const sx = cam.x + (Math.random() * 2 - 1) * 16;
            const sz = cam.z + (Math.random() * 2 - 1) * 16;
            if (isWaterAt(sx, sz)) { spawnWaterRipple(sx, sz); break; }
        }
    }
}

/* ------------------------------------------------------------
   Snow — soft drifting flakes in a box tracking the camera.
   ------------------------------------------------------------ */
function updateSnow(dt, elapsed, amount) {
    const snow = state.snow, flakes = state.snowFlakes;
    if (!snow || !flakes) return;
    if (amount <= 0.001) { if (snow.material.opacity > 0) { snow.material.opacity = 0; snow.visible = false; } return; }
    snow.visible = true;
    snow.material.opacity = Math.min(0.92, 0.9 * amount);
    const cam = state.camera.position;
    const R = 20, TOP = 20, active = Math.floor(SNOW_MAX * Math.min(1, amount));
    const wx = W.windDir.x * (state.weatherWind || 0), wz = W.windDir.z * (state.weatherWind || 0);
    const pos = snow.geometry.attributes.position.array;
    for (let i = 0; i < SNOW_MAX; i++) {
        const f = flakes[i];
        if (i >= active) { pos[i * 3 + 1] = -1000; continue; }
        if (f.y < cam.y - 4 || Math.abs(f.x - cam.x) > R + 3 || Math.abs(f.z - cam.z) > R + 3) {
            f.x = cam.x + (Math.random() * 2 - 1) * R;
            f.z = cam.z + (Math.random() * 2 - 1) * R;
            // respawn anywhere in the column so slow flakes fill it immediately
            f.y = cam.y - 3 + Math.random() * (TOP + 3);
        }
        f.y -= f.sp * dt;
        pos[i * 3] = f.x + Math.sin(elapsed * 0.8 + f.phase) * f.amp + wx * 1.4 * dt * 30;
        pos[i * 3 + 1] = f.y;
        pos[i * 3 + 2] = f.z + Math.cos(elapsed * 0.7 + f.phase) * f.amp + wz * 1.4 * dt * 30;
        f.x += wx * 0.5 * dt; f.z += wz * 0.5 * dt;
    }
    snow.geometry.attributes.position.needsUpdate = true;
}

/* ------------------------------------------------------------
   Teardown — restore the baseline so a re-init starts clean.
   ------------------------------------------------------------ */
function disposeObj(o) {
    if (!o) return;
    if (state.scene) state.scene.remove(o);
    if (o.geometry) { try { o.geometry.dispose(); } catch (e) {} }
    if (o.material) { try { o.material.dispose(); } catch (e) {} }
}

export function disposeWeather() {
    disposeObj(state.rain); state.rain = null; state.rainDrops = null;
    disposeObj(state.snow); state.snow = null; state.snowFlakes = null;
    if (state.snowTex) { try { state.snowTex.dispose(); } catch (e) {} state.snowTex = null; }
    // restore baseline lighting/fog (renderer/scene may persist across re-init)
    if (W.base) {
        try {
            if (state.scene && state.scene.fog) { state.scene.fog.density = W.base.fog; state.scene.fog.color.setHex(W.base.fogColor); }
            if (state.sun) state.sun.intensity = W.base.sun;
            if (state.hemi) state.hemi.intensity = W.base.hemi;
            if (state.skyFill) state.skyFill.intensity = W.base.skyFill;
            if (state.renderer) state.renderer.toneMappingExposure = W.base.exposure;
        } catch (e) {}
    }
    W.base = null;
    state.weatherWind = 0;
}
