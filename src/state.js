import * as THREE from 'three';

/* ============================================================
   State
   ============================================================ */
export const state = {
    // Engine
    container: null,
    scene: null,
    camera: null,
    renderer: null,
    controls: null,
    // last: timestamp of the last ACCEPTED frame (drives dt).
    // next: the frame gate's target timeline — see animate().
    clock: { last: 0, next: 0 },
    rafId: null,
    disposed: false,
    softwareRenderer: false, // set once by engine.js's createRenderer() via gpu-detect.js
    gpuRendererString: null,

    // Terrain & Environment
    floorMesh: null,
    wallMesh: null,
    obstacleMesh: null,
    terrainChunks: null,    // Phase 4b: sector-chunked terrain — topmost voxel per column (full box)
    terrainInteriorChunks: null, // buried (non-topmost) column voxels — top face stripped, always hidden
    detailChunks: null,     // Phase 4b: sector-chunked flora detail (culling.js record)
    wallChunks: null,       // Phase 4b: sector-chunked perimeter wall (culling.js record)
    obstacles: [],          // [{x,z,r}] for collision
    sharedBoxGeo: null,
    sharedInteriorGeo: null, // box with its +y (top) face removed — see terrain.js

    // Player
    player: {
        velocity: null,
        keys: {},
        analogMove: null, // touch joystick output {fwd, strafe} (magnitude 0..1), else null
    },

    // Touch controls (mobile) — isTouchMode is set once at init by
    // touch-controls.js; `touch` is only populated while it's true.
    isTouchMode: false,
    touch: null,

    // Projectiles
    projectiles: [],        // [{mesh, pos, vel, active, age, radius}]

    // Creatures
    creatures: [],          // [{group, parts, type, pos, heading, phase, alive}]

    // Capture
    raycaster: null,
    lastLockTime: 0,
    captureSeqs: [],        // active catch sequences (capture.js state machines)
    captureFlashes: [],     // additive flash sprites [{sprite, age, life, from, to}]

    // Viewmodel (held capture ball)
    viewmodel: null,        // {group, phase, t, swayT, release}

    // Targeting UI
    targetPanel: null,      // DOM refs {root, name, tier, pct, bonus, lastKey}
    targetRing: null,       // {group, mat, arcs} — 3D ring at the hovered creature's feet
    targetHover: null,      // currently hovered creature record
    backFlashEl: null,      // "Back Bonus!" flourish element
    backFlashTimer: null,

    // Particles
    particles: null,
    particleData: null,     // {positions, colors, alphas, ages, velocities, lives, active}

    // Audio
    audio: null,
    popBuffer: null,
    sfxBus: null,           // shared one-shot SFX bus (cave reverb taps it)
    caveAudio: null,        // Phase 2l cave audio layer (reverb/drips/rumble/footsteps/trickle)

    // Security & Logic
    creaturesCaught: 0,
    isCaptchaSolved: false,
    token: null,
    captureHash: 0,

    // Quality
    fps: 0,
    qualityLevel: 'high',
    fpsRing: null,
    fpsRingIdx: 0,
    fpsRingFilled: 0,
    lowFpsFrames: 0,
    highFpsFrames: 0,

    // Render scheduling. frameId counts ACCEPTED game frames (game.js's
    // animate()); shadowFrozen is engine.js's idle latch, honoured by the
    // once-per-frame shadow re-arm in animate(). See engine.js createRenderer
    // for why the shadow pass is armed manually instead of via autoUpdate.
    frameId: 0,
    shadowFrozen: false,

    // Game flow
    isPaused: false,
};

// Reusable objects for performance
export const reuse = {
    tmpVec3: new THREE.Vector3(),
    tmpVec3b: new THREE.Vector3(),
    rayOrigin: new THREE.Vector3(),
    rayDir: new THREE.Vector3(0, 0, -1),
    playerForward: new THREE.Vector3(),
    playerRight: new THREE.Vector3(),
    moveDir: new THREE.Vector3(),
    matrix: new THREE.Matrix4(),
    color: new THREE.Color(),
    intersectArray: [],
};
