/* ============================================================
   Day/Night & Celestial — graphics-backlog items 1,2,4,5,10,17,
   440,445 (split out of weather.js to keep that file under the
   project's soft line cap; same folder, same ownership).
   ------------------------------------------------------------
   Two independent layers, both handed back to weather.js as a
   small multiplier/tint recipe (DN) that it applies to the SAME
   captured baseline WEATHER_STATES already multiplies — so this
   never fights the weather blend, it just moves what "baseline"
   means a moment before weather's own mul lands on top:

     1) dayPhase — a continuous, deliberately SUBTLE arc: the sun
        disc slowly rides between a dimmer and brighter elevation
        over a multi-minute session (a short CAPTCHA session sees
        one slice of it, not a full sunrise-to-sunset sweep).
     2) a rare, independently-scheduled "night event" — a deeper
        dusk-to-moonlit dip on its own seeded timer (like a weather
        state's own hold/blend, but much rarer and longer): warms
        into a dusk rim first (item 2), then cools toward a moonlit
        palette as the sun disc itself recolours into a moon
        (item 4/440) and stars/aurora fade in (items 10/17) — all
        reusing the existing Sky/sun rig, no second skybox.

   A rare shooting star (item 445) can streak across the dome while
   deep in the night dip. A rainbow/fog-bow (items 197/211) is a
   separate, weather-triggered sky decoration living here too since
   it's the same "camera-facing sky billboard" technique as the
   stars/aurora.

   Own seeded RNG (independent of weather.js's W.rng) so nothing
   here perturbs the weather-state roll sequence.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { mulberry32 } from '../random.js';
import { SUN_DIRECTION } from '../engine.js';
import { DAY_NIGHT, AURORA_ZONES } from './weather-data.js';
import { zoneAt } from '../zones/zones.js';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
const _cA = new THREE.Color(), _cB = new THREE.Color();
function lerpHex(ha, hb, t) { _cA.setHex(ha); _cB.setHex(hb); return _cA.lerp(_cB, clamp01(t)).getHex(); }

const DN = {
    rng: null,
    elevJitter: 0, azJitter: 0, phaseOffset: 0,
    baseAz: 108, // fallback; overwritten from the live SUN_DIRECTION at init
    night: { phase: 'idle', t: 0, nextCheck: 0, holdUntil: 0 },
    rainbow: { phase: 'idle', t: 0, kind: null, holdUntil: 0 },
    shootingStar: { active: false, t: 0, life: 1.1, sx: 0, sy: 0, sz: 0, ex: 0, ey: 0, ez: 0 },
    stars: null, sunGlare: null, aurora: null, rainbowSprite: null, shootingStarLine: null,
    auroraPhase: 0,
};

/* ------------------------------------------------------------
   Build (eager, matching the rain/snow precip pattern) — every
   object exists from the start with visibility/opacity toggled,
   so disposeDayNight() always has something concrete to clean up.
   ------------------------------------------------------------ */
export function initDayNight() {
    DN.rng = mulberry32((CONFIG.WORLD_SEED ^ 0x6a17c3) >>> 0);
    DN.elevJitter = (DN.rng() * 2 - 1) * CONFIG.DAY_NIGHT_SEED_JITTER_DEG; // item 5
    DN.azJitter = (DN.rng() * 2 - 1) * CONFIG.DAY_NIGHT_SEED_JITTER_DEG;
    DN.phaseOffset = DN.rng() * CONFIG.DAY_NIGHT_PERIOD;
    try {
        const sph = new THREE.Spherical().setFromVector3(SUN_DIRECTION);
        DN.baseAz = THREE.MathUtils.radToDeg(sph.theta);
    } catch (e) { /* keep fallback */ }

    DN.night.phase = 'idle'; DN.night.t = 0;
    DN.night.nextCheck = CONFIG.NIGHT_EVENT_CHECK_MIN + DN.rng() * CONFIG.NIGHT_EVENT_CHECK_SPAN;
    DN.rainbow.phase = 'idle'; DN.rainbow.t = 0;
    DN.shootingStar.active = false;
    DN.auroraPhase = DN.rng() * Math.PI * 2;

    buildStars();
    buildSunGlare();
    buildAurora();
    buildRainbowSprite();
    buildShootingStarLine();
}

function makeRadialTexture(stops) {
    const s = 64;
    const cv = document.createElement('canvas'); cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    for (const [off, col] of stops) grd.addColorStop(off, col);
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
}

function buildStars() {
    const n = CONFIG.STAR_COUNT;
    const pos = new Float32Array(n * 3);
    const r = DN.rng;
    for (let i = 0; i < n; i++) {
        // uniform-ish points over the upper hemisphere of a large dome
        const theta = r() * Math.PI * 2;
        const phi = Math.acos(1 - r() * 0.92); // bias toward the crown, skip near-horizon clutter
        const rad = 400;
        pos[i * 3] = rad * Math.sin(phi) * Math.cos(theta);
        pos[i * 3 + 1] = rad * Math.cos(phi) + 20;
        pos[i * 3 + 2] = rad * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
        color: 0xdfe8ff, size: 1.4, map: makeRadialTexture([[0, 'rgba(255,255,255,1)'], [0.5, 'rgba(210,225,255,0.7)'], [1, 'rgba(210,225,255,0)']]),
        transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(geo, mat);
    stars.frustumCulled = false;
    stars.renderOrder = -1;
    state.scene.add(stars);
    DN.stars = stars;
}

// Sun-shaft/glare billboard (items 6/15/20): a single camera-facing sprite
// riding the sun/moon direction. depthTest keeps it a real point in space —
// it correctly hides behind terrain/mountains for free.
function buildSunGlare() {
    const tex = makeRadialTexture([[0, 'rgba(255,255,255,0.9)'], [0.25, 'rgba(255,240,210,0.45)'], [1, 'rgba(255,240,210,0)']]);
    const mat = new THREE.SpriteMaterial({
        map: tex, color: 0xffd6a0, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    const spr = new THREE.Sprite(mat);
    spr.scale.setScalar(70);
    spr.renderOrder = -1;
    state.scene.add(spr);
    DN.sunGlare = spr;
}

// Aurora ribbon (item 10): a soft additive plane high overhead, only ever
// shown over alpine/ice/snow AND only deep in a night event, gated off 'low'.
function buildAurora() {
    const size = 5;
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 64);
    grd.addColorStop(0, 'rgba(120,255,200,0)');
    grd.addColorStop(0.5, 'rgba(120,255,200,0.55)');
    grd.addColorStop(0.75, 'rgba(150,140,255,0.35)');
    grd.addColorStop(1, 'rgba(150,140,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 64);
    const tex = new THREE.CanvasTexture(cv);
    const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0, depthWrite: false, fog: false,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    const geo = new THREE.PlaneGeometry(size * 22, size * 4);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = Math.PI / 2.3;
    mesh.renderOrder = -1;
    state.scene.add(mesh);
    DN.aurora = mesh;
}

// Rainbow/fog-bow (items 197/211): camera-facing arc sprite, opposite the sun.
function buildRainbowSprite() {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    const cx = 64, cy = 128;
    for (let ring = 0; ring < 7; ring++) {
        const rr = 118 - ring * 8;
        g.strokeStyle = RAINBOW_BANDS[ring];
        g.lineWidth = 7;
        g.beginPath();
        g.arc(cx, cy, rr, Math.PI, 0);
        g.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, fog: true });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(150, 75, 1);
    state.scene.add(spr);
    DN.rainbowSprite = spr;
}
const RAINBOW_BANDS = ['#e34a4a', '#e8914a', '#e8d24a', '#7bc94a', '#4ab0c9', '#4a6fe8', '#8a4ae8'];
const FOGBOW_BANDS = ['#e9eef5', '#e2e8f2', '#dbe2ee', '#d4dceb', '#cdd7e8', '#c6d1e5', '#bfccdf'];

function buildShootingStarLine() {
    const pos = new Float32Array(6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    state.scene.add(line);
    DN.shootingStarLine = line;
}

/* ------------------------------------------------------------
   Night-event scheduling — its own tiny state machine, independent
   of weather.js's forceWeather()/hold-timer so a probe freezing the
   weather state doesn't also freeze time of day.
   ------------------------------------------------------------ */
function advanceNightEvent(dt, elapsed) {
    const N = DN.night;
    switch (N.phase) {
        case 'idle':
            if (elapsed >= N.nextCheck) {
                if (DN.rng() < CONFIG.NIGHT_EVENT_CHANCE) { N.phase = 'enter'; N.t = 0; }
                N.nextCheck = elapsed + CONFIG.NIGHT_EVENT_CHECK_MIN + DN.rng() * CONFIG.NIGHT_EVENT_CHECK_SPAN;
            }
            break;
        case 'enter':
            N.t = Math.min(1, N.t + dt / CONFIG.NIGHT_EVENT_ENTER_TIME);
            if (N.t >= 1) { N.phase = 'hold'; N.holdUntil = elapsed + CONFIG.NIGHT_EVENT_HOLD_MIN + DN.rng() * CONFIG.NIGHT_EVENT_HOLD_SPAN; }
            break;
        case 'hold':
            if (elapsed >= N.holdUntil) N.phase = 'exit';
            break;
        case 'exit':
            N.t = Math.max(0, N.t - dt / CONFIG.NIGHT_EVENT_EXIT_TIME);
            if (N.t <= 0) N.phase = 'idle';
            break;
    }
    return N.t;
}

function duskWeight(t) {
    const peak = DAY_NIGHT.duskWarmPeak;
    if (t <= peak) return peak > 0 ? t / peak : 0;
    return Math.max(0, 1 - (t - peak) / (1 - peak));
}
function moonWeight(t) {
    const peak = DAY_NIGHT.duskWarmPeak;
    return t <= peak ? 0 : (t - peak) / (1 - peak);
}

/* ------------------------------------------------------------
   Rare rainbow trigger — called by weather.js when a transition
   lands on 'clear' from rain/thunderstorm/fog.
   ------------------------------------------------------------ */
export function triggerRainbow(kind) {
    if (DN.rainbow.phase !== 'idle') return; // don't interrupt one already showing
    DN.rainbow.phase = 'enter'; DN.rainbow.t = 0; DN.rainbow.kind = kind;
    if (DN.rainbowSprite) {
        const cv = DN.rainbowSprite.material.map.image;
        const g = cv.getContext('2d');
        g.clearRect(0, 0, cv.width, cv.height);
        const bands = kind === 'fogbow' ? FOGBOW_BANDS : RAINBOW_BANDS;
        for (let ring = 0; ring < 7; ring++) {
            const rr = 118 - ring * 8;
            g.strokeStyle = bands[ring]; g.lineWidth = 7;
            g.beginPath(); g.arc(64, 128, rr, Math.PI, 0); g.stroke();
        }
        DN.rainbowSprite.material.map.needsUpdate = true;
    }
}

function advanceRainbow(dt) {
    const R = DN.rainbow;
    switch (R.phase) {
        case 'enter':
            R.t = Math.min(1, R.t + dt / CONFIG.RAINBOW_FADE_TIME);
            if (R.t >= 1) { R.phase = 'hold'; R.holdUntil = CONFIG.RAINBOW_HOLD_TIME; }
            break;
        case 'hold':
            R.holdUntil -= dt;
            if (R.holdUntil <= 0) R.phase = 'exit';
            break;
        case 'exit':
            R.t = Math.max(0, R.t - dt / CONFIG.RAINBOW_FADE_TIME);
            if (R.t <= 0) R.phase = 'idle';
            break;
        default: return 0;
    }
    return R.t;
}

/* ------------------------------------------------------------
   Per-frame update. Returns the multiplier/tint recipe weather.js
   folds INTO its own baseline before the weather-state mul lands
   on top; also drives every celestial visual directly.
   ------------------------------------------------------------ */
export function updateDayNight(dt, elapsed, sunMulFromWeather) {
    const cam = state.camera;
    const low = state.qualityLevel === 'low';

    // ---- continuous, subtle arc (item 1) ----
    const cyclePos = (elapsed + DN.phaseOffset) % CONFIG.DAY_NIGHT_PERIOD;
    const dayPhase = 0.5 - 0.5 * Math.cos((2 * Math.PI * cyclePos) / CONFIG.DAY_NIGHT_PERIOD);
    let elevation = lerp(CONFIG.DAY_NIGHT_NIGHT_ELEV, CONFIG.DAY_NIGHT_DAY_ELEV, dayPhase) + DN.elevJitter;
    const azimuth = DN.baseAz + DN.azJitter + (dayPhase - 0.5) * CONFIG.DAY_NIGHT_AZIMUTH_SWING;

    // ---- rare night event (items 2/4/10/17/440/445) ----
    const nightT = advanceNightEvent(dt, elapsed);
    elevation = lerp(elevation, DAY_NIGHT.nightMinElev, nightT);
    const dusk = duskWeight(nightT), moon = moonWeight(nightT);

    // ---- sun disc -> Sky rig (reused for the "moon" too, item 440) ----
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    SUN_DIRECTION.setFromSphericalCoords(1, phi, theta);
    if (state.sky) {
        const u = state.sky.material.uniforms;
        if (u.sunPosition) u.sunPosition.value.copy(SUN_DIRECTION);
    }

    // ---- colour temperature (item 49 infra) / moon recolour (item 4/440) ----
    let sunColorHex = 0xffd6a0;
    if (dusk > 0.001 || moon > 0.001) {
        sunColorHex = lerpHex(0xffd6a0, DAY_NIGHT.duskSunColor, dusk);
        sunColorHex = lerpHex(sunColorHex, DAY_NIGHT.nightSunColor, moon);
    }
    if (state.sun) state.sun.color.setHex(sunColorHex);

    // ---- celestial visuals ----
    if (cam) {
        if (DN.stars) {
            DN.stars.position.copy(cam.position);
            DN.stars.material.opacity = low ? 0 : moon * 0.85;
        }
        if (DN.sunGlare) {
            DN.sunGlare.position.copy(cam.position).addScaledVector(SUN_DIRECTION, 260);
            DN.sunGlare.material.color.setHex(sunColorHex);
            const glareAmt = low ? 0 : clamp01(sunMulFromWeather) * lerp(1, 0.45, moon);
            DN.sunGlare.material.opacity = glareAmt * 0.55;
            DN.sunGlare.scale.setScalar(60 + glareAmt * 30);
        }
        if (DN.aurora) {
            let auroraOn = false;
            if (!low && moon > 0.15) {
                try {
                    const z = zoneAt(cam.position.x, cam.position.z);
                    auroraOn = !!(z && AURORA_ZONES.has(z.id));
                } catch (e) { /* zones not ready yet */ }
            }
            if (auroraOn) {
                DN.auroraPhase += dt * 0.06;
                DN.aurora.position.set(cam.position.x + Math.sin(DN.auroraPhase) * 12, cam.position.y + 46, cam.position.z + Math.cos(DN.auroraPhase * 0.8) * 12);
                DN.aurora.rotation.z = Math.sin(DN.auroraPhase * 0.5) * 0.2;
                DN.aurora.material.opacity = Math.min(0.5, (moon - 0.15) / 0.85) * (0.6 + 0.4 * Math.sin(elapsed * 0.3));
            } else if (DN.aurora.material.opacity > 0) {
                DN.aurora.material.opacity = Math.max(0, DN.aurora.material.opacity - dt * 0.3);
            }
        }
        updateShootingStar(dt, elapsed, moon, cam, low);
        updateRainbow(dt, cam);
    }

    // publish for atmosphere.js / any future HUD hook
    state.dayPhase = dayPhase;
    state.nightAmt = nightT;

    // ---- recipe handed back to weather.js (nightT/dayPhase let weather.js do
    // its own hemi/fog colour lerps toward DAY_NIGHT's night tints — sunColorHex
    // is already applied directly to state.sun.color above, nothing more to do) ----
    const floor = DAY_NIGHT.dayHemiFloor;
    return {
        dayPhase, nightT,
        sunMul: lerp(0.94, 1.06, dayPhase) * lerp(1, 0.32, nightT),
        hemiMul: lerp(0.96, 1.03, dayPhase) * lerp(1, floor, nightT),
        skyFillMul: lerp(0.96, 1.03, dayPhase) * lerp(1, floor, nightT),
        exposureMul: lerp(0.95, 1.04, dayPhase) * lerp(1, floor + 0.05, nightT),
        fogMul: lerp(1.08, 0.95, dayPhase),
        turbidityAdd: lerp(0, 3.4, nightT) + dusk * 1.2,
        rayleighMul: lerp(1, 0.35, nightT),
    };
}

function updateShootingStar(dt, elapsed, moon, cam, low) {
    const S = DN.shootingStar;
    if (!DN.shootingStarLine) return;
    if (!S.active) {
        if (!low && moon > 0.55 && Math.random() < CONFIG.SHOOTING_STAR_CHANCE) {
            const ang = Math.random() * Math.PI * 2;
            const r0 = 150 + Math.random() * 80;
            S.sx = cam.position.x + Math.cos(ang) * r0; S.sy = cam.position.y + 90 + Math.random() * 40; S.sz = cam.position.z + Math.sin(ang) * r0;
            const dAng = ang + (Math.random() * 1.2 - 0.6);
            S.ex = S.sx + Math.cos(dAng) * 60; S.ey = S.sy - 35 - Math.random() * 20; S.ez = S.sz + Math.sin(dAng) * 60;
            S.t = 0; S.active = true;
        }
    } else {
        S.t += dt / S.life;
        if (S.t >= 1) { S.active = false; DN.shootingStarLine.material.opacity = 0; return; }
        const head = Math.min(1, S.t * 2.2);
        const tail = Math.max(0, head - 0.35);
        const pos = DN.shootingStarLine.geometry.attributes.position.array;
        pos[0] = lerp(S.sx, S.ex, tail); pos[1] = lerp(S.sy, S.ey, tail); pos[2] = lerp(S.sz, S.ez, tail);
        pos[3] = lerp(S.sx, S.ex, head); pos[4] = lerp(S.sy, S.ey, head); pos[5] = lerp(S.sz, S.ez, head);
        DN.shootingStarLine.geometry.attributes.position.needsUpdate = true;
        DN.shootingStarLine.material.opacity = Math.sin(Math.PI * Math.min(1, S.t * 3)) * 0.9;
    }
}

function updateRainbow(dt, cam) {
    const t = advanceRainbow(dt);
    if (!DN.rainbowSprite) return;
    if (t <= 0.001) { DN.rainbowSprite.material.opacity = 0; return; }
    const dir = SUN_DIRECTION;
    DN.rainbowSprite.position.set(cam.position.x - dir.x * 200, cam.position.y + 30 - dir.y * 40, cam.position.z - dir.z * 200);
    DN.rainbowSprite.material.opacity = t * 0.8;
}

export function dayNightDebug() {
    return { phase: DN.night.phase, t: +DN.night.t.toFixed(3), rainbow: DN.rainbow.phase };
}

export function disposeDayNight() {
    const kill = (o) => {
        if (!o) return;
        if (state.scene) state.scene.remove(o);
        if (o.geometry) { try { o.geometry.dispose(); } catch (e) {} }
        if (o.material) {
            if (o.material.map) { try { o.material.map.dispose(); } catch (e) {} }
            try { o.material.dispose(); } catch (e) {}
        }
    };
    kill(DN.stars); DN.stars = null;
    kill(DN.sunGlare); DN.sunGlare = null;
    kill(DN.aurora); DN.aurora = null;
    kill(DN.rainbowSprite); DN.rainbowSprite = null;
    kill(DN.shootingStarLine); DN.shootingStarLine = null;
    DN.night = { phase: 'idle', t: 0, nextCheck: 0, holdUntil: 0 };
    DN.rainbow = { phase: 'idle', t: 0, kind: null, holdUntil: 0 };
    DN.shootingStar.active = false;
}
