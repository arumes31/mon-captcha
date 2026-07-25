/* ============================================================
   Quality Adapters
   ============================================================ */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FilmPass } from 'three/addons/postprocessing/FilmPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { applyShadowMapSize } from './engine.js';
import { applyLodTier } from './lod.js';
import { isWaterAt, getWaterLevelAt } from './heightfield.js';

// Tier lookup tables (same pattern as lod.js's CREATURE_LOD/FLORA_RING) — the
// single source of truth applyQualityTier() reconciles on every tier change,
// AND on the very first call (so a device seeded straight into a non-'high'
// starting tier — e.g. confirmed software rendering, see gpu-detect.js — gets
// the matching shadow-map size / pixel ratio from frame one, not just at the
// next FPS-driven step).
// item 373: 'ultra' is manual-only (see the ?quality=/?photo handling in
// initQuality below) — the automatic FPS stepper's ceiling stays 'high'
// (stepQualityUp never assigns 'ultra'), matching gpu-detect.js's "only act
// on confirmed signals" stance.
const SHADOW_MAP_BY_TIER = { ultra: CONFIG.SHADOW_MAP_ULTRA, high: CONFIG.SHADOW_MAP_HIGH, medium: CONFIG.SHADOW_MAP_MED, low: CONFIG.SHADOW_MAP_LOW };
// 'high' stays pinned to the pre-existing min(dpr,2) cap so the visreg
// baselines (minted on 'high') see no change; medium/low step the fill-rate
// cost down further — one of the biggest levers for a weak GPU, and unlike
// antialias/shadow-type this is safe to change live (setPixelRatio resizes
// the canvas internally, no shader recompile).
const PIXEL_RATIO_CAP_BY_TIER = { ultra: CONFIG.PIXEL_RATIO_ULTRA, high: CONFIG.PIXEL_RATIO_HIGH, medium: CONFIG.PIXEL_RATIO_MEDIUM, low: CONFIG.PIXEL_RATIO_LOW };
// item 376/385: each visual cost gets its own per-tier table instead of one
// nested if/else ladder, so effects can be tuned/decoupled independently.
const WATER_DISTORTION_BY_TIER = { ultra: 1.0, high: 1.0, medium: 0.8, low: 0.4 };
const BLOOM_STRENGTH_BY_TIER = { ultra: 0.30, high: 0.22, medium: 0.20, low: 0.22 };
const SHARPEN_BY_TIER = { ultra: 0.22, high: 0.14, medium: 0, low: 0 };
// Highlight cutoff for UnrealBloomPass, in pre-tone-mapped luminance.
const BLOOM_THRESHOLD = 1.6;

const VALID_TIERS = ['low', 'medium', 'high', 'ultra'];
const SESSION_KEY = 'mc_quality_tier'; // item 387

// item 374/376/379/382/385/387: tiny ?param helpers, same convention as the
// existing ?nochunk/?noocclude/?seed hooks elsewhere in this codebase.
function qsFlag(name) {
    try {
        return typeof window !== 'undefined' && window.location && new RegExp('[?&]' + name + '\\b').test(window.location.search);
    } catch (e) { return false; }
}
function qsValue(name) {
    try {
        if (typeof window === 'undefined' || !window.location) return null;
        const m = new RegExp('[?&]' + name + '=([^&]+)').exec(window.location.search);
        return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
}

// item 374: manual override; item 382: photo/screenshot mode (maxes settings,
// ignores live FPS entirely). Both LOCK the tier — the FPS auto-stepper backs
// off completely so a deliberate choice never gets silently overridden.
let _qualityLocked = false;
// item 376/385: bloom decoupled from the tier ladder for a quick A/B or a
// mid-tier device that wants the rest of the composer but not the bloom cost.
let _bloomForcedOff = false;
// item 379: emergency resolution-scale floor below 'low' — see stepQualityDown.
let _resScale = 1;
// item 273: baseline bloom strength for the CURRENT tier; the per-frame fog
// modulation in updateQualityFx() multiplies around this rather than fighting it.
let _bloomBaseStrength = 0.22;
// item 273: clear-day fog density baseline, captured once, so "fogginess" is
// read as a ratio rather than needing any coupling to weather.js internals.
let _fogBaseDensity = null;
// item 282: reused selection array for the OutlinePass (see updateQualityFx).
const _outlineSel = [];

function persistTier(q) {
    try { sessionStorage.setItem(SESSION_KEY, q); } catch (e) { /* private mode / storage disabled */ }
}

export function initQuality() {
    state.fpsRing = new Float32Array(CONFIG.FPS_SAMPLE_FRAMES);
    state.fpsRingIdx = 0;
    state.fpsRingFilled = 0;
    state.lowFpsFrames = 0;
    state.highFpsFrames = 0;

    // Fresh per-session state (a destroy()/init() re-build in the same page
    // load — e.g. the test harness's restart flow — must not inherit a prior
    // session's lock/degraded-resolution/fog-baseline).
    _qualityLocked = false;
    _resScale = 1;
    _fogBaseDensity = null;

    _bloomForcedOff = qsFlag('nobloom');
    const photo = qsFlag('photo');
    const manual = qsValue('quality');

    if (photo) {
        // item 382: max everything, screenshot-ready, immune to live FPS.
        state.qualityLevel = 'ultra';
        _qualityLocked = true;
    } else if (manual && VALID_TIERS.includes(manual)) {
        // item 374: explicit player/QA choice beats every other default.
        state.qualityLevel = manual;
        _qualityLocked = true;
    } else {
        let persisted = null;
        try { persisted = sessionStorage.getItem(SESSION_KEY); } catch (e) { /* ignore */ }
        if (persisted && VALID_TIERS.includes(persisted)) {
            // item 387: resume where the last session's FPS ramp landed
            // instead of always restarting from scratch. Stepper stays free
            // to keep adjusting from here (not locked).
            state.qualityLevel = persisted;
        } else {
            // Confirmed software rendering (see gpu-detect.js, set by engine.js
            // before this runs): skip the ~60-frame FPS-sampled ramp-down and
            // start where a software rasterizer always ends up anyway —
            // shadow-map size, pixel ratio, composer/bloom and LOD radii all
            // follow from this via applyQualityTier() below. Live FPS sampling
            // still runs on top of this and can still step a 'high' start down
            // (or, in principle, step this back up) if reality disagrees.
            state.qualityLevel = state.softwareRenderer ? 'low' : 'high';
        }
    }
    initPostProcessing();
}

/* ============================================================
   Post-Processing (EffectComposer + Bloom + a few small extras)
   Tiers:
     ultra/high/medium -> RenderPass + OutlinePass + Bloom + FilmPass + FxPass + OutputPass
     low                -> direct renderer.render() (composer disabled)
   (SSAOPass was built here through Phase 4b but never enabled in any tier —
   removed entirely rather than paying its init/GPU-memory cost for nothing.
   The Phase 4c additions below follow the same rule: everything new is
   entirely bypassed on 'low' because the whole composer is, so none of it
   can regress the software-rendered/no-GPU tier this project optimizes for.)
   ============================================================ */

// items 272/278/279: vignette + underwater tint + a 'high'/'ultra'-only
// sharpen, combined into ONE extra fullscreen pass instead of three.
const FX_SHADER = {
    uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uVignette: { value: 0 },
        uUnderwater: { value: 0 },
        uUnderwaterColor: { value: new THREE.Color(0x0a3a4a) },
        uSharpen: { value: 0 },
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform vec2 uResolution;
        uniform float uVignette;
        uniform float uUnderwater;
        uniform vec3 uUnderwaterColor;
        uniform float uSharpen;
        varying vec2 vUv;

        void main() {
            vec4 texel = texture2D(tDiffuse, vUv);
            vec3 color = texel.rgb;

            if (uSharpen > 0.0) {
                vec2 px = 1.0 / uResolution;
                vec3 sum = texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb
                         + texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb
                         + texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb
                         + texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb;
                vec3 blur = sum * 0.25;
                color += (color - blur) * uSharpen;
            }

            if (uUnderwater > 0.0) {
                color = mix(color, uUnderwaterColor, uUnderwater * 0.55);
            }

            vec2 c = vUv - 0.5;
            float vig = 1.0 - smoothstep(0.35, 0.85, length(c) * 1.15) * uVignette;
            color *= vig;

            gl_FragColor = vec4(color, texel.a);
        }
    `,
};

function initPostProcessing() {
    const renderer = state.renderer;
    const scene = state.scene;
    const camera = state.camera;
    if (!renderer || !scene || !camera) return;

    const w = state.container.clientWidth || window.innerWidth;
    const h = state.container.clientHeight || window.innerHeight;

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    // item 282: outline the currently-targeted creature for readability.
    // Tier-gated to 'high'/'ultra' only in applyQualityTier() (two extra
    // passes even with nothing selected) — same "prove it on the strong tier
    // first" stance the removed SSAOPass note describes.
    const outline = new OutlinePass(new THREE.Vector2(w, h), scene, camera, []);
    outline.edgeStrength = 3.2;
    outline.edgeGlow = 0.35;
    outline.edgeThickness = 1.2;
    outline.pulsePeriod = 0;
    outline.visibleEdgeColor.set(0xfff2c0);
    outline.hiddenEdgeColor.set(0x000000);
    outline.enabled = false;
    composer.addPass(outline);
    state.outlinePass = outline;

    // Subtle bloom — mainly catches the sun disc, water glints and fireflies.
    // Threshold sits above the sky dome's scaled luminance (see
    // SKY_RADIANCE_SCALE in engine.js): RenderPass feeds this pass a
    // pre-tone-mapped half-float buffer, so a threshold at/below the sky's
    // radiance blooms the entire dome instead of the highlights in it.
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.22, 0.5, BLOOM_THRESHOLD);
    bloom.enabled = true;
    composer.addPass(bloom);
    state.bloomPass = bloom;

    // item 269: subtle film grain (off on 'low' — see applyQualityTier).
    const film = new FilmPass(0.28, false);
    composer.addPass(film);
    state.filmPass = film;

    // items 272/278/279 (see FX_SHADER above)
    const fx = new ShaderPass(FX_SHADER);
    fx.uniforms.uResolution.value.set(w, h);
    fx.setSize = (ww, hh) => { fx.uniforms.uResolution.value.set(ww, hh); }; // EffectComposer.setSize calls this on resize
    composer.addPass(fx);
    state.fxPass = fx;

    composer.addPass(new OutputPass());

    state.composer = composer;
    state.composerEnabled = true;
    applyQualityTier();
}

function applyQualityTier() {
    const q = state.qualityLevel;
    persistTier(q); // item 387
    // Reconcile the two renderer-level costs to this tier every time (initial
    // call included) — previously shadow-map size was only set from engine.js's
    // one-time bootstrap call plus the step functions, which could leave it
    // stuck at the wrong size for a tier that was seeded directly (skipping
    // the step machinery).
    applyShadowMapSize(SHADOW_MAP_BY_TIER[q] || CONFIG.SHADOW_MAP_HIGH);
    if (state.renderer) {
        const cap = PIXEL_RATIO_CAP_BY_TIER[q] || CONFIG.PIXEL_RATIO_HIGH;
        // item 379: _resScale is 1 outside the emergency low-tier floor, so
        // this is a no-op multiply for every normal tier/device.
        const pr = Math.min(window.devicePixelRatio || 1, cap) * _resScale;
        state.renderer.setPixelRatio(pr);
        // PERF (framedrop pass): the composer has its OWN pixel ratio, captured
        // from the renderer once in EffectComposer's constructor and never
        // refreshed afterwards. Its ping-pong targets — and every pass's
        // internal targets, including UnrealBloomPass's whole mip chain — are
        // sized _width * _pixelRatio, so without this call stepping the tier
        // down shrank ONLY the final canvas: the entire post chain, which is
        // where most of the fill rate goes, kept rendering at the original
        // (up to 2x dpr) resolution. That made the single biggest lever in the
        // tier ladder almost a no-op, which is a large part of why a struggling
        // device never actually recovered after the stepper dropped a tier.
        if (state.composer) state.composer.setPixelRatio(pr);
    }
    // Phase 4b (item 344): bind the distance-LOD radii to the tier machine —
    // low culls/simplifies sooner (always cheaper); high is generous (the
    // visreg baselines' tier, so no visual change).
    applyLodTier(q);
    if (!state.composer) return;

    const composerOn = q !== 'low';
    state.composerEnabled = composerOn;
    if (state.bloomPass) state.bloomPass.enabled = composerOn && !_bloomForcedOff; // items 376/385
    if (state.water) state.water.material.uniforms['distortionScale'].value = WATER_DISTORTION_BY_TIER[q] ?? 1.0;
    if (state.filmPass) state.filmPass.enabled = composerOn; // item 269
    if (state.outlinePass) state.outlinePass.enabled = composerOn && (q === 'high' || q === 'ultra'); // item 282
    if (state.fxPass) state.fxPass.uniforms.uSharpen.value = SHARPEN_BY_TIER[q] ?? 0; // item 279

    _bloomBaseStrength = BLOOM_STRENGTH_BY_TIER[q] ?? 0.22;
    if (state.bloomPass) state.bloomPass.strength = _bloomBaseStrength;

    // Ambient-life extras step down with the tier (leaf wind sway is also
    // skipped per-frame on 'low' inside updateEnvironmentAnim)
    const rich = q !== 'low';
    if (state.fireflies) state.fireflies.visible = rich;
    if (state.fallingLeaves) state.fallingLeaves.visible = rich;
    if (state.cloudLayers && state.cloudLayers[1]) state.cloudLayers[1].mesh.visible = rich;
    // zone ambience: the additive glow layer steps out on 'low' (the soft layer
    // stays — it is the cheaper half and carries the zone mood)
    if (state.zoneGlow) state.zoneGlow.visible = rich;
}

/* ------------------------------------------------------------
   Per-frame cosmetic tie-ins (items 272/273/278/282). Piggybacks on
   recordFps(dt) — the one per-frame hook quality.js already had — so
   nothing here needed a new call site wired into game.js's animate().
   Skipped during the idle/paused throttle exactly like FPS sampling
   already is: nothing to reveal, so nothing worth computing.
   ------------------------------------------------------------ */
function updateQualityFx(dt) {
    const fx = state.fxPass;
    const cam = state.camera;
    if (fx && cam) {
        // item 278: underwater tint — cheap position check against the local
        // water surface (pond OR river; isWaterAt/getWaterLevelAt already
        // handle both). Fades rather than cuts so breaking the surface isn't
        // a hard pop.
        let underwater = 0;
        try {
            if (isWaterAt(cam.position.x, cam.position.z) && cam.position.y < getWaterLevelAt(cam.position.x, cam.position.z)) underwater = 1;
        } catch (e) { /* pre-world-build guard */ }
        const cur = fx.uniforms.uUnderwater.value;
        fx.uniforms.uUnderwater.value = cur + (underwater - cur) * Math.min(1, dt * 4);

        // item 272: vignette baseline + a storm-gust boost. state.weatherWind
        // is already published by weather.js for exactly this kind of
        // cross-system read (flora sway/motes already key off it too) — reused
        // here rather than coupling this file to weather.js's internals.
        const wind = state.weatherWind || 0;
        fx.uniforms.uVignette.value = 0.16 + Math.min(1, wind / 1.4) * 0.16;
    }

    // item 273: bloom strength follows fogginess relative to the clear-day
    // baseline — overcast/fog reads dimmer, a clear/sunny moment pops a touch
    // more, both eased around the tier's own base strength.
    if (state.bloomPass && state.scene && state.scene.fog) {
        if (_fogBaseDensity === null) _fogBaseDensity = state.scene.fog.density || 0.0036;
        const ratio = _fogBaseDensity > 0 ? (state.scene.fog.density / _fogBaseDensity) : 1;
        const fogFactor = THREE.MathUtils.clamp(1.25 - ratio * 0.3, 0.55, 1.15);
        state.bloomPass.strength = _bloomBaseStrength * fogFactor;
    }

    // item 282: keep the outline synced to whichever creature targeting.js
    // currently has hovered (state.targetHover — already CAPTURE_RANGE-gated
    // by targeting.js itself, so no distance check needed here).
    // Reuse one array instead of allocating a fresh literal every frame. Beyond
    // the garbage, OutlinePass only early-outs when selectedObjects is EMPTY —
    // and when it is not, it renders the whole scene twice more. Keeping the
    // same array and mutating its length makes the "nothing hovered" case an
    // unambiguous, allocation-free empty.
    if (state.outlinePass) {
        const t = state.targetHover;
        if (t && t.group) { _outlineSel.length = 1; _outlineSel[0] = t.group; }
        else _outlineSel.length = 0;
        state.outlinePass.selectedObjects = _outlineSel;
    }
}

/* ------------------------------------------------------------
   The auto-stepper's input. This used to ring-buffer INSTANTANEOUS
   fps (1/dt) and average THOSE — an arithmetic mean of reciprocals,
   which is not the frame rate. It weights fast frames far more
   heavily than slow ones, so it systematically over-reports exactly
   in the stuttery case the stepper exists to catch:

     frames alternating 8ms and 60ms
       mean(1/dt)         = (125 + 16.7) / 2  = 70.8  "fps"
       true rate          = 2 frames / 0.068s = 29.4   fps

   At 70.8 the reported figure sits above FPS_UP_THRESHOLD (52), so a
   session dropping half its frames did not merely fail to step DOWN —
   it stepped UP, adding cost to an already-hitching frame. Ring the
   frame TIMES instead and divide count by their sum: that is the real
   average frame rate over the window (the harmonic mean of 1/dt), and
   one 60ms frame now drags it down as much as it actually hurts.
   ------------------------------------------------------------ */
export function recordFps(dt) {
    if (dt <= 0) return;
    state.fpsRing[state.fpsRingIdx] = dt;
    state.fpsRingIdx = (state.fpsRingIdx + 1) % CONFIG.FPS_SAMPLE_FRAMES;
    if (state.fpsRingFilled < CONFIG.FPS_SAMPLE_FRAMES) state.fpsRingFilled++;

    let sum = 0;
    for (let i = 0; i < state.fpsRingFilled; i++) sum += state.fpsRing[i];
    state.fps = sum > 0 ? state.fpsRingFilled / sum : 0;

    // Quality check bounds limits
    if (state.fps < CONFIG.FPS_DOWN_THRESHOLD) {
        state.lowFpsFrames++;
        state.highFpsFrames = 0;
        if (state.lowFpsFrames >= CONFIG.FPS_DOWN_FRAMES) stepQualityDown();
    } else if (state.fps > CONFIG.FPS_UP_THRESHOLD) {
        state.highFpsFrames++;
        state.lowFpsFrames = 0;
        if (state.highFpsFrames >= CONFIG.FPS_UP_FRAMES) stepQualityUp();
    } else {
        state.lowFpsFrames = 0;
        state.highFpsFrames = 0;
    }

    updateQualityFx(dt);
}

function stepQualityDown() {
    state.lowFpsFrames = 0;
    if (_qualityLocked) return; // items 374/382: manual/photo override — the auto-stepper backs off entirely
    // Shadow map size + pixel ratio are now reconciled inside applyQualityTier()
    // itself (keep shadows enabled always — toggling shadowMap.enabled at
    // runtime recompiles shaders and can flash black; shrinking the map is the
    // cheap, safe lever instead).
    if (state.qualityLevel === 'high') state.qualityLevel = 'medium';
    else if (state.qualityLevel === 'medium') state.qualityLevel = 'low';
    else if (state.qualityLevel === 'low') {
        // item 379: no tier left below 'low' — sink the render resolution
        // further instead of doing nothing, floored so a device is never
        // pushed to an unusably small framebuffer.
        _resScale = Math.max(CONFIG.PIXEL_RATIO_FLOOR / CONFIG.PIXEL_RATIO_LOW, _resScale * CONFIG.PIXEL_RATIO_STEP);
    }
    applyQualityTier();
}

function stepQualityUp() {
    state.highFpsFrames = 0;
    if (_qualityLocked) return;
    if (state.qualityLevel === 'low' && _resScale < 1) {
        // item 379: climb back out of the emergency resolution floor before
        // promoting tiers again.
        _resScale = Math.min(1, _resScale / CONFIG.PIXEL_RATIO_STEP);
    } else if (state.qualityLevel === 'low') state.qualityLevel = 'medium';
    else if (state.qualityLevel === 'medium') state.qualityLevel = 'high';
    // item 373: 'ultra' is manual-only — the auto-stepper's ceiling stays
    // 'high' even at sustained good FPS (see gpu-detect.js's note on only
    // acting on confirmed-strong signals, which this project doesn't have).
    applyQualityTier();
}
