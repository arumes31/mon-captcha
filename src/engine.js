/* ============================================================
   Engine Setup
   ============================================================ */

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { getGroundY, SPAWN } from './heightfield.js';
import { detectSoftwareRenderer } from './gpu-detect.js';

function createRenderer(container) {
    // Read once regardless of the reuse branch below — quality.js's initQuality()
    // needs it either way, and a confirmed software rasterizer is exactly the
    // case where skipping MSAA + soft-shadow filtering matters most.
    const { isSoftware, rendererString } = detectSoftwareRenderer();
    state.softwareRenderer = isSoftware;
    state.gpuRendererString = rendererString;

    if (window.__globalRenderer) {
        const renderer = window.__globalRenderer;
        if (renderer.domElement.parentNode !== container) {
            if (renderer.domElement.parentNode) {
                renderer.domElement.parentNode.removeChild(renderer.domElement);
            }
            container.appendChild(renderer.domElement);
        }
        renderer.setSize(container.clientWidth, container.clientHeight);
        return renderer;
    }

    let renderer;
    try {
        // Antialias is a context-creation-time flag — can't be toggled later,
        // so the software-renderer probe above has to happen before this call.
        renderer = new THREE.WebGLRenderer({ antialias: !isSoftware, powerPreference: 'high-performance' });
        if (!renderer.getContext()) {
            throw new Error('WebGL context is null');
        }
    } catch (e) {
        throw new Error('WebGL not available');
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    // Confirmed software rendering: skip PCF's multi-tap shadow filtering
    // (decided once here, before any material compiles against it — no
    // runtime-toggle recompile/flicker risk).
    renderer.shadowMap.type = isSoftware ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
    renderer.shadowMap.needsUpdate = true;
    // Physically-based lighting defaults for next-gen look
    renderer.physicallyCorrectLights = true;
    container.appendChild(renderer.domElement);
    window.__globalRenderer = renderer;
    return renderer;
}

export const SUN_DIRECTION = new THREE.Vector3();
const SUN_ELEVATION = 24; // degrees — late-afternoon sun: warm but high enough to light tops
const SUN_AZIMUTH = 108;  // degrees — front-right of the spawn view, just out of frame

export function buildEngine(container) {
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xf2dcb3, 0.0036); // light warm-cream haze, thin in the middle distance

    const camera = new THREE.PerspectiveCamera(
        75,
        container.clientWidth / container.clientHeight,
        0.1,
        1000
    );
    // Spawn player on the flat meadow pad, looking towards the center lake
    camera.position.set(SPAWN.x, getGroundY(SPAWN.x, SPAWN.z) + CONFIG.PLAYER_EYE_HEIGHT, SPAWN.z);

    const renderer = createRenderer(container);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08; // bright but not blown golden-hour exposure
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    if ('useLegacyLights' in renderer) {
        renderer.useLegacyLights = false; // ensure next-gen physical lighting is active
    }
    state.scene = scene;
    state.camera = camera;
    state.renderer = renderer;

    // Sky dome (three/addons Sky) — pristine gradient + warm sun disc
    const sky = new Sky();
    sky.scale.setScalar(10000);
    scene.add(sky);
    state.sky = sky;

    const skyU = sky.material.uniforms;
    skyU['turbidity'].value = 2.4;        // clear warm air — soft glow without whiting out the sky
    skyU['rayleigh'].value = 2.0;         // saturated blue overhead falling to amber horizon
    skyU['mieCoefficient'].value = 0.004;
    skyU['mieDirectionalG'].value = 0.8;  // gentler sun halo

    const phi = THREE.MathUtils.degToRad(90 - SUN_ELEVATION);
    const theta = THREE.MathUtils.degToRad(SUN_AZIMUTH);
    SUN_DIRECTION.setFromSphericalCoords(1, phi, theta);
    skyU['sunPosition'].value.copy(SUN_DIRECTION);

    // Lights — warm key, cool fill, earthy bounce (classic golden-hour triad)
    const hemi = new THREE.HemisphereLight(0xbdd8f5, 0x96804f, 1.5); // bright sky dome + warm grass bounce
    scene.add(hemi);
    state.hemi = hemi;

    // Soft cool sky fill from the shadow side, so shade reads blue instead of black
    const skyFill = new THREE.DirectionalLight(0x93b4de, 0.65);
    skyFill.position.set(-40, 30, -40);
    scene.add(skyFill);
    state.skyFill = skyFill;

    const sun = new THREE.DirectionalLight(0xffd6a0, 3.6); // warm golden sun, strong but not scorching
    sun.position.copy(SUN_DIRECTION).multiplyScalar(60);
    sun.castShadow = true;
    // Small frustum, RECENTERED ON THE PLAYER every frame by updateSunFollow()
    // below — not the whole arena. See CONFIG.SHADOW_FOLLOW_RADIUS for why.
    sun.shadow.camera.left = -CONFIG.SHADOW_FOLLOW_RADIUS;
    sun.shadow.camera.right = CONFIG.SHADOW_FOLLOW_RADIUS;
    sun.shadow.camera.top = CONFIG.SHADOW_FOLLOW_RADIUS;
    sun.shadow.camera.bottom = -CONFIG.SHADOW_FOLLOW_RADIUS;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 160;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.06; // generous: flat voxel tops at low sun angles acne-shadow otherwise
    sun.shadow.radius = 4; // soft-edged shadow penumbra
    scene.add(sun);
    scene.add(sun.target);
    state.sun = sun;

    applyShadowMapSize(CONFIG.SHADOW_MAP_HIGH);

    const controls = new PointerLockControls(camera, renderer.domElement);
    scene.add(controls.getObject());
    state.controls = controls;
}

export function applyShadowMapSize(size) {
    if (!state.sun) return;
    state.sun.shadow.mapSize.set(size, size);
    // Normal bias must grow as shadow texels get coarser, or flat sunlit voxel
    // tops self-shadow into black acne on the lower quality tiers.
    const ratio = CONFIG.SHADOW_MAP_HIGH / size;
    state.sun.shadow.normalBias = 0.06 * ratio;
    // item 36: `bias` scales the same way normalBias always has — a coarser
    // shadow texel needs a proportionally bigger depth bias too, or medium/low
    // trade acne for peter-panning instead of just shrinking cleanly.
    state.sun.shadow.bias = -0.0002 * ratio;
    if (state.sun.shadow.map) {
        state.sun.shadow.map.dispose();
        state.sun.shadow.map = null;
    }
    state.sun.shadow.needsUpdate = true;
}

// item 34: widen/shrink the follow frustum with player speed so a fast
// approach doesn't have shadow-casters popping in at the frustum edge.
// Only touches the projection matrix (cheap) when the target radius has
// actually moved a meaningful amount, to avoid needless per-frame churn
// while cruising at a roughly steady speed.
let _lastFollowRadius = null;
function applyFollowRadius(camera, r) {
    if (_lastFollowRadius !== null && Math.abs(r - _lastFollowRadius) < 0.5) return;
    _lastFollowRadius = r;
    camera.left = -r; camera.right = r; camera.top = r; camera.bottom = -r;
    camera.updateProjectionMatrix();
}

// item 39: soften PCFSoft's shadow.radius under heavy fog/overcast instead of
// only tinting the fog color — reads as "the light itself got hazier", not
// just a color grade. Baseline density is captured once (the clear-day
// FogExp2 set in buildEngine); weather.js's own per-frame fogMul drives the
// live value this compares against, so this needs no coupling to weather.js.
let _fogBaseDensity = null;

// item 44: idle-aware shadow-update caching. Mirrors game.js's own idle
// predicate (tab hidden, or paused with the pointer unlocked) — in that
// state creatures/player are already fully frozen (see creatures/behavior.js's
// `frozen` gate and player.js's early-return), so re-running the shadow depth
// pass every throttled frame is pure waste. Restores autoUpdate the instant
// activity resumes so nothing ever renders a stale shadow while actually playing.
let _shadowIdle = false;

// Recenters the (dynamically sized, see item 34) shadow frustum on the
// player every frame — keeps the sun's DIRECTION fixed (just offsets
// position/target by the same SUN_DIRECTION vector the player is standing at),
// so lighting angle/mood never changes, only which slice of the world falls
// inside the shadow pass.
let _sunRef = null;
export function updateSunFollow(camera) {
    const sun = state.sun;
    if (!sun || !camera) return;

    // Self-heals across a destroy()/init() re-build in the same page load (the
    // test harness's restart flow, and the reason createRenderer() has its own
    // window.__globalRenderer reuse branch above): buildEngine() creates a
    // fresh `sun` with fresh shadow-camera bounds, but the module-level caches
    // below are per-page-load singletons, so a stale radius/baseline from a
    // PRIOR sun would otherwise survive the rebuild undetected.
    if (sun !== _sunRef) {
        _sunRef = sun;
        _lastFollowRadius = null;
        _fogBaseDensity = null;
        _shadowIdle = false;
    }

    const locked = state.controls && state.controls.isLocked;
    const idle = (typeof document !== 'undefined' && document.hidden) || (state.isPaused && !locked);
    if (idle) {
        if (!_shadowIdle) {
            _shadowIdle = true;
            if (state.renderer) state.renderer.shadowMap.autoUpdate = false;
        }
        return; // frozen scene: skip repositioning and reuse the last depth pass
    }
    if (_shadowIdle) {
        _shadowIdle = false;
        if (state.renderer) {
            state.renderer.shadowMap.autoUpdate = true;
            state.renderer.shadowMap.needsUpdate = true;
        }
    }

    const speed = (state.player && state.player.velocity) ? state.player.velocity.length() : 0;
    const speedT = THREE.MathUtils.clamp(speed / CONFIG.SHADOW_FOLLOW_SPEED_REF, 0, 1);
    const radius = CONFIG.SHADOW_FOLLOW_RADIUS + (CONFIG.SHADOW_FOLLOW_RADIUS_MAX - CONFIG.SHADOW_FOLLOW_RADIUS) * speedT;
    applyFollowRadius(sun.shadow.camera, radius);

    if (state.scene && state.scene.fog) {
        if (_fogBaseDensity === null) _fogBaseDensity = state.scene.fog.density || 0.0036;
        const fogRatio = _fogBaseDensity > 0 ? (state.scene.fog.density / _fogBaseDensity) : 1;
        const boost = THREE.MathUtils.clamp((fogRatio - 1) / 2, 0, 1) * CONFIG.SHADOW_FOG_RADIUS_BOOST;
        sun.shadow.radius = 4 + boost;
    }

    sun.target.position.copy(camera.position);
    sun.position.copy(camera.position).addScaledVector(SUN_DIRECTION, 60);
}
