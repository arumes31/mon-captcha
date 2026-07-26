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
    // Bootstrap ratio only — initQuality()'s applyPixelRatio() reconciles this
    // to the tier a moment later. It still honours CONFIG.MAX_BACKBUFFER_PIXELS
    // so the very first allocation cannot be the oversized one: on a HiDPI 4K
    // window min(dpr,2) alone asks for a 7680x4320 backing store, and the
    // context can be lost on that allocation before quality.js ever runs.
    const bootW = container.clientWidth, bootH = container.clientHeight;
    let bootPr = Math.min(window.devicePixelRatio || 1, 2);
    if (CONFIG.MAX_BACKBUFFER_PIXELS > 0 && bootW > 0 && bootH > 0) {
        bootPr = Math.min(bootPr, Math.sqrt(CONFIG.MAX_BACKBUFFER_PIXELS / (bootW * bootH)));
    }
    renderer.setPixelRatio(bootPr);
    renderer.setSize(bootW, bootH);
    renderer.shadowMap.enabled = true;
    // Confirmed software rendering: skip PCF's multi-tap shadow filtering
    // (decided once here, before any material compiles against it — no
    // runtime-toggle recompile/flicker risk).
    renderer.shadowMap.type = isSoftware ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
    /* ------------------------------------------------------------
       PERF (framedrop pass) — ONE shadow pass per frame, not N.
       WebGLRenderer.render() runs shadowMap.render() on EVERY call, and a
       frame issues far more than one render() call with the real scene:
         - EffectComposer's RenderPass                        (1)
         - three/addons Water's mirror hook, nested inside it (1)
         - OutlinePass, whenever a creature is hovered, renders the FULL
           scene twice more (depth mask + prepare mask)       (2)
           ...each of which re-entered the Water hook again   (2)
       Every one of those repeated the entire 2048x2048 sun depth pass over
       every shadow caster in the world, producing byte-identical output
       each time — a DirectionalLight's shadow camera is driven by the
       light's position/target (updateSunFollow pins it to the player), not
       by whichever camera is rendering, so none of the repeats could
       differ. Sweeping the crosshair across creatures while walking
       flipped OutlinePass on and off, which is why the waste showed up as
       framedrops *while moving* rather than as a steady lower framerate.

       autoUpdate:false + needsUpdate:true is three's documented idiom for
       exactly this: shadowMap.render() clears needsUpdate once it has run,
       so the first render() of a frame does the pass and every later one
       early-outs. game.js re-arms needsUpdate once per frame (and skips
       re-arming while idle, which is what updateSunFollow's idle branch
       used to express by toggling autoUpdate).
       ------------------------------------------------------------ */
    renderer.shadowMap.autoUpdate = false;
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

/* ------------------------------------------------------------
   three's Sky shader emits raw sky radiance in the 2–6 range —
   values authored for a renderer running a much lower exposure
   than this scene's 1.08. Two things go wrong at that magnitude:
   ACES saturates the whole dome to ~white (so turbidity/rayleigh
   stop being visible at all, and the cloud layer disappears into
   it), and — because RenderPass writes a pre-tone-mapped
   half-float target — every sky pixel clears UnrealBloomPass's
   threshold, blooming the entire sky and washing the frame.
   Scaling the shader's output back into ACES' responsive range
   fixes both without touching toneMappingExposure, which is tuned
   for the terrain. Keep BLOOM_THRESHOLD (quality.js) above the
   scaled sky's luminance or the whiteout returns.
   ------------------------------------------------------------ */
export const SKY_RADIANCE_SCALE = 0.42;

function applySkyRadianceScale(sky) {
    const mat = sky.material;
    mat.uniforms.uSkyRadianceScale = { value: SKY_RADIANCE_SCALE };
    const OUT = 'gl_FragColor = vec4( retColor, 1.0 );';
    if (mat.fragmentShader.indexOf(OUT) === -1) return; // upstream shader changed — leave it alone
    mat.fragmentShader = ('uniform float uSkyRadianceScale;\n' + mat.fragmentShader)
        .replace(OUT, 'gl_FragColor = vec4( retColor * uSkyRadianceScale, 1.0 );');
    mat.needsUpdate = true;
}

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
    // No useLegacyLights toggle needed: three@0.160.0 already defaults to
    // physically-correct lighting (legacy mode was removed as the default in
    // r155), and the property itself is deprecated for removal — setting it
    // was a no-op that only printed a console deprecation warning.
    state.scene = scene;
    state.camera = camera;
    state.renderer = renderer;

    // Sky dome (three/addons Sky) — pristine gradient + warm sun disc
    const sky = new Sky();
    sky.scale.setScalar(10000);
    scene.add(sky);
    state.sky = sky;

    applySkyRadianceScale(sky);

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

    // Cool sky bounce from BELOW. Sun and skyFill both shine downward, so a
    // downward-facing voxel face receives only the hemisphere light's ground
    // term — warm, dim, and (against dark foliage) squarely in the ACES toe,
    // which is why canopy undersides crushed to black. Aiming a weak cool fill
    // up lifts only those faces: an upward normal's dot product with it is
    // zero, so sunlit tops and the overall contrast are untouched. Cast no
    // shadow — it is a bounce approximation, not a light source.
    // weather.js keeps its intensity pinned to skyFill's (CONFIG.SKY_BOUNCE_FILL).
    const bounceFill = new THREE.DirectionalLight(0x9dbde0, 0.65 * CONFIG.SKY_BOUNCE_FILL);
    bounceFill.position.set(0, -60, 0);
    bounceFill.castShadow = false;
    scene.add(bounceFill);
    state.bounceFill = bounceFill;

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
// The deadband was 0.5 world units against a radius that ramps 45 -> 54 with
// speed: every frame of acceleration/deceleration moved the target further
// than that, so the ortho projection was rebuilt — and with it the whole
// shadow texel grid rescaled, which makes shadow edges crawl — on essentially
// every frame the player was changing speed. 2 units is still under 4% of the
// radius (invisible as a coverage change) but collapses the churn to a handful
// of rebuilds per accel/decel ramp instead of one per frame.
let _lastFollowRadius = null;
function applyFollowRadius(camera, r) {
    if (_lastFollowRadius !== null && Math.abs(r - _lastFollowRadius) < 2) return;
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
// pass every throttled frame is pure waste. Publishes state.shadowFrozen; the
// once-per-frame re-arm in game.js's animate() honours it and stops re-arming,
// so the last depth pass is simply reused. (This used to flip
// renderer.shadowMap.autoUpdate directly, which no longer works now that
// autoUpdate is permanently false — see the note in createRenderer above.)
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
        state.shadowFrozen = false;
    }

    const locked = state.controls && state.controls.isLocked;
    const idle = (typeof document !== 'undefined' && document.hidden) || (state.isPaused && !locked);
    if (idle) {
        if (!_shadowIdle) {
            _shadowIdle = true;
            state.shadowFrozen = true;
        }
        return; // frozen scene: skip repositioning and reuse the last depth pass
    }
    if (_shadowIdle) {
        _shadowIdle = false;
        state.shadowFrozen = false;
        if (state.renderer) state.renderer.shadowMap.needsUpdate = true;
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
