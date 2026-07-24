/* ============================================================
   Quality Adapters
   ============================================================ */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { applyShadowMapSize } from './engine.js';
import { applyLodTier } from './lod.js';

// Tier lookup tables (same pattern as lod.js's CREATURE_LOD/FLORA_RING) — the
// single source of truth applyQualityTier() reconciles on every tier change,
// AND on the very first call (so a device seeded straight into a non-'high'
// starting tier — e.g. confirmed software rendering, see gpu-detect.js — gets
// the matching shadow-map size / pixel ratio from frame one, not just at the
// next FPS-driven step).
const SHADOW_MAP_BY_TIER = { high: CONFIG.SHADOW_MAP_HIGH, medium: CONFIG.SHADOW_MAP_MED, low: CONFIG.SHADOW_MAP_LOW };
// 'high' stays pinned to the pre-existing min(dpr,2) cap so the visreg
// baselines (minted on 'high') see no change; medium/low step the fill-rate
// cost down further — one of the biggest levers for a weak GPU, and unlike
// antialias/shadow-type this is safe to change live (setPixelRatio resizes
// the canvas internally, no shader recompile).
const PIXEL_RATIO_CAP_BY_TIER = { high: CONFIG.PIXEL_RATIO_HIGH, medium: CONFIG.PIXEL_RATIO_MEDIUM, low: CONFIG.PIXEL_RATIO_LOW };

export function initQuality() {
    state.fpsRing = new Float32Array(CONFIG.FPS_SAMPLE_FRAMES);
    state.fpsRingIdx = 0;
    state.fpsRingFilled = 0;
    state.lowFpsFrames = 0;
    state.highFpsFrames = 0;
    // Confirmed software rendering (see gpu-detect.js, set by engine.js before
    // this runs): skip the ~60-frame FPS-sampled ramp-down and start where a
    // software rasterizer always ends up anyway — shadow-map size, pixel
    // ratio, composer/bloom and LOD radii all follow from this via
    // applyQualityTier() below. Live FPS sampling still runs on top of this
    // and can still step a 'high' start down (or, in principle, step this
    // back up) if reality disagrees.
    state.qualityLevel = state.softwareRenderer ? 'low' : 'high';
    initPostProcessing();
}

/* ============================================================
   Post-Processing (EffectComposer + Bloom)
   Tiers:
     high/medium -> RenderPass + UnrealBloomPass + OutputPass
     low         -> direct renderer.render() (composer disabled)
   (SSAOPass was built here through Phase 4b but never enabled in any tier —
   removed entirely rather than paying its init/GPU-memory cost for nothing.)
   ============================================================ */
function initPostProcessing() {
    const renderer = state.renderer;
    const scene = state.scene;
    const camera = state.camera;
    if (!renderer || !scene || !camera) return;

    const w = state.container.clientWidth || window.innerWidth;
    const h = state.container.clientHeight || window.innerHeight;

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    // Subtle bloom — mainly catches the sun disc, water glints and fireflies
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.22, 0.5, 1.0);
    bloom.enabled = true;
    composer.addPass(bloom);
    state.bloomPass = bloom;

    composer.addPass(new OutputPass());

    state.composer = composer;
    state.composerEnabled = true;
    applyQualityTier();
}

function applyQualityTier() {
    const q = state.qualityLevel;
    // Reconcile the two renderer-level costs to this tier every time (initial
    // call included) — previously shadow-map size was only set from engine.js's
    // one-time bootstrap call plus the step functions, which could leave it
    // stuck at the wrong size for a tier that was seeded directly (skipping
    // the step machinery).
    applyShadowMapSize(SHADOW_MAP_BY_TIER[q] || CONFIG.SHADOW_MAP_HIGH);
    if (state.renderer) {
        const cap = PIXEL_RATIO_CAP_BY_TIER[q] || CONFIG.PIXEL_RATIO_HIGH;
        state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    }
    // Phase 4b (item 344): bind the distance-LOD radii to the tier machine —
    // low culls/simplifies sooner (always cheaper); high is generous (the
    // visreg baselines' tier, so no visual change).
    applyLodTier(q);
    if (!state.composer) return;
    if (q === 'low') {
        state.composerEnabled = false;
        if (state.bloomPass) state.bloomPass.enabled = false;
        if (state.water) state.water.material.uniforms['distortionScale'].value = 0.4;
    } else if (q === 'medium') {
        state.composerEnabled = true;
        if (state.bloomPass) state.bloomPass.enabled = true;
        if (state.water) state.water.material.uniforms['distortionScale'].value = 0.8;
    } else {
        state.composerEnabled = true;
        if (state.bloomPass) state.bloomPass.enabled = true;
        if (state.water) state.water.material.uniforms['distortionScale'].value = 1.0;
    }
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

export function recordFps(dt) {
    if (dt <= 0) return;
    const fps = 1 / dt;
    state.fpsRing[state.fpsRingIdx] = fps;
    state.fpsRingIdx = (state.fpsRingIdx + 1) % CONFIG.FPS_SAMPLE_FRAMES;
    if (state.fpsRingFilled < CONFIG.FPS_SAMPLE_FRAMES) state.fpsRingFilled++;

    let sum = 0;
    for (let i = 0; i < state.fpsRingFilled; i++) sum += state.fpsRing[i];
    state.fps = state.fpsRingFilled ? sum / state.fpsRingFilled : 0;

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
}

function stepQualityDown() {
    state.lowFpsFrames = 0;
    // Shadow map size + pixel ratio are now reconciled inside applyQualityTier()
    // itself (keep shadows enabled always — toggling shadowMap.enabled at
    // runtime recompiles shaders and can flash black; shrinking the map is the
    // cheap, safe lever instead).
    if (state.qualityLevel === 'high') state.qualityLevel = 'medium';
    else if (state.qualityLevel === 'medium') state.qualityLevel = 'low';
    applyQualityTier();
}

function stepQualityUp() {
    state.highFpsFrames = 0;
    if (state.qualityLevel === 'low') state.qualityLevel = 'medium';
    else if (state.qualityLevel === 'medium') state.qualityLevel = 'high';
    applyQualityTier();
}
