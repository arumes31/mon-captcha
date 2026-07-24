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
    state.sun.shadow.normalBias = 0.06 * (CONFIG.SHADOW_MAP_HIGH / size);
    if (state.sun.shadow.map) {
        state.sun.shadow.map.dispose();
        state.sun.shadow.map = null;
    }
    state.sun.shadow.needsUpdate = true;
}

// Recenters the (small, CONFIG.SHADOW_FOLLOW_RADIUS-wide) shadow frustum on
// the player every frame — keeps the sun's DIRECTION fixed (just offsets
// position/target by the same SUN_DIRECTION vector the player is standing at),
// so lighting angle/mood never changes, only which slice of the world falls
// inside the shadow pass. Only a transform update (no projection-matrix
// recompute needed — the frustum's own bounds never change size, just
// position), so this is cheap enough to run unconditionally every frame.
export function updateSunFollow(camera) {
    const sun = state.sun;
    if (!sun || !camera) return;
    sun.target.position.copy(camera.position);
    sun.position.copy(camera.position).addScaledVector(SUN_DIRECTION, 60);
}
