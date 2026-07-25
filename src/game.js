/* ============================================================
   Game Loop, Init & Teardown
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { buildEngine, updateSunFollow } from './engine.js';
import { buildTerrain } from './terrain.js';
import { updateEnvironmentAnim } from './atmosphere.js';
import { setupPlayer, onKeyDown, onKeyUp, updatePlayer } from './player.js';
import { spawnCreatures } from './creatures/spawn.js';
import { updateCreatures } from './creatures/behavior.js';
import { disposeCreatureCaches } from './creatures/factory.js';
import { tryCapture, updateProjectiles } from './projectiles.js';
import { updateCaptureSequences, disposeCaptureSequences } from './capture.js';
import { initViewmodel, updateViewmodel, disposeViewmodel } from './viewmodel.js';
import { initTargeting, updateTargeting, disposeTargeting } from './targeting.js';
import { removeBall, disposeBallCaches } from './ball.js';
import { initTouchControls, updateTouchControls, disposeTouchControls } from './touch-controls.js';
import { updateMountainFeatures, disposeMountainFeatures } from './mountain/mountain.js';
import { updateLava, disposeLava } from './lava.js';
import { updateCaves, disposeCaves } from './caves/caves.js';
import { updateCaveAtmos } from './caves/caves-atmos.js';
import { updateCaveLight } from './caves/caves-light.js';
import { initCaveGameplay, updateCaveGameplay, disposeCaveGameplay, caveCaptureBonus, tunnelBackDot, atDeadEnd, caveDeadEnds, caveDeepPoint, triggerCaveCollapse, caveRicochet, caveThrowUpAngle } from './caves/caves-gameplay.js';
import { initParticles, updateParticles, updateWaterRipples } from './particles.js';
import { updateCulling, disposeChunked } from './culling.js';
import { perfSample, perfInstanceTotal, perfDrawnInstances } from './perf.js';
import { initAudio } from './audio.js';
import { initMusic, musicSetActive, disposeMusic, musicCurrentMood } from './music.js';
import { initCaveAudio, updateCaveAudio, caveAudioSetActive, stopCaveAudio, disposeCaveAudio, caveAudioStats } from './caves/caves-audio.js';
import { initQuality, recordFps, applyPixelRatio } from './quality.js';
import { ui, cacheUI, updateCounterUI, showClickToPlay, showPauseOverlay, disposeHintToast, captureSeedThumbnail } from './ui.js';
import { zoneAt, ZONES } from './zones/zones.js';
import { PARTITION, SPAWN, MOUNTAIN, MOUNTAINS, VENT, CAVES, caveAt, sampleCave, caveConfine, caveCeilingAt, getTerrainHeight, getGroundY, isWaterAt, getWaterLevelAt, getWaterDepth, caveSlippery, riverAt, riverPointAt, riverSpan, BORDER_FALL, OXBOW } from './heightfield.js';
import { LAVA, lavaAt } from './lava.js';
import { forceWeather, forceLightning, weatherState, updateWeather, initWeather, disposeWeather } from './weather/weather.js';
import { CAVE_THEMES, getCaveThemeDescriptor, caveThemeRegistered, registeredCaveThemes } from './caves/caves-registry.js';
import { themeBuildLog } from './caves/caves-themes.js';

/* ============================================================
   Game Animation Loop
   ============================================================ */
// See the frame-gate note in animate(): absorbs rAF jitter so a cap that
// matches the display refresh does not halve the frame rate.
const FRAME_GATE_SLACK_MS = 1;

function animate() {
    if (state.disposed) return;
    state.rafId = requestAnimationFrame(animate);

    const now = performance.now();
    const elapsedMs = now - state.clock.last;

    /* Idle throttle (item 356): when the tab is hidden, or the game is paused
       (pointer unlocked and not yet solved), there is no viewer — clamp the
       update rate hard. Otherwise run to CONFIG.MAX_FPS.

       The gate holds a TARGET TIMELINE (clock.next) rather than measuring
       from the last accepted frame. That distinction is the whole ballgame on
       a display whose refresh is not a multiple of the cap.

       Measuring from the last accepted frame quantises the result down to the
       largest submultiple of the panel that fits under the cap, because every
       rejection re-bases the origin: at 144Hz (6.94ms/tick) a 16.67ms target
       rejects ticks 1 and 2, accepts tick 3 at 20.8ms, and starts counting
       again from there — a hard 48 FPS, with 165Hz landing on 55 and 75Hz on
       an awful 37.5.

       Advancing clock.next by exactly one interval per accepted frame instead
       means the timeline never drifts, so the long-run rate is the cap itself:
       144Hz now alternates 13.9/20.8ms spacing for a true 60 FPS average
       (one refresh period of pacing jitter, which is the unavoidable cost of
       a cap the panel cannot divide evenly) instead of dropping a fifth of
       the frames outright.

       FRAME_GATE_SLACK_MS absorbs rAF's sub-millisecond jitter so a tick
       arriving a hair early is not thrown away — on a 60Hz panel, where the
       tick and the target coincide exactly, that jitter would otherwise cost
       one frame every time it lands on the wrong side. */
    const locked = state.controls && state.controls.isLocked;
    const idle = (typeof document !== 'undefined' && document.hidden) || (state.isPaused && !locked);
    const interval = idle
        ? 1000 / CONFIG.IDLE_UPDATE_FPS
        : 1000 / CONFIG.MAX_FPS;
    if (!state.clock.next) state.clock.next = now;
    if (now < state.clock.next - FRAME_GATE_SLACK_MS) {
        return;
    }
    // Advance by whole intervals. If we have fallen more than one interval
    // behind (a real hitch, a tab switch, an idle->active transition), resync
    // to now rather than letting the backlog fire a catch-up burst.
    state.clock.next += interval;
    if (state.clock.next < now) state.clock.next = now + interval;

    let dt = elapsedMs / 1000;
    state.clock.last = now;
    // One monotonically increasing id per ACCEPTED game frame. Anything that
    // must happen at most once per frame — even though it is reached from
    // several renderer.render() passes — keys off this rather than counting
    // its own invocations (terrain.js's water-mirror cadence does exactly
    // that: EffectComposer's RenderPass and OutlinePass each re-enter the
    // Water hook, so an invocation counter there would advance 1-3x a frame).
    state.frameId = (state.frameId + 1) | 0;

    if (!isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;

    // Idle (throttled) frames must not feed the quality auto-scaler, or a long
    // pause at ~8 FPS would trick it into stepping the tier down before play.
    if (!idle) recordFps(dt);

    const elapsed = now / 1000;
    updatePlayer(dt);
    updateSunFollow(state.camera);
    updateTouchControls();
    updateCreatures(dt, elapsed);
    updateProjectiles(dt);
    updateCaptureSequences(dt); // unconditional: sequences finish even paused/solved
    updateParticles(dt);
    updateWaterRipples(dt);
    updateTargeting();
    updateViewmodel(dt, elapsed);
    updateEnvironmentAnim(elapsed);
    updateMountainFeatures(dt, elapsed);
    updateLava(dt, elapsed);
    updateCaves(dt, elapsed);       // core cull/LOD: sets bands + aux visibility
    updateCaveAtmos(dt, elapsed);   // Phase 2h: eye-adaptation/darkness/haze → state.caveFx (weather reads it)
    updateCaveLight(dt, elapsed);   // Phase 2h: lantern follow/fade + god-rays/luring anim
    updateCaveGameplay(dt, elapsed);// Phase 2k: grotto-ball pickup bob/grab + collapse rock-fall
    updateCaveAudio(dt, elapsed);   // Phase 2l: cave reverb/drips/rumble/footsteps/trickle (reads state.caveFx)
    updateWeather(dt, elapsed);     // applies hemi/exposure/fog, folding in state.caveFx

    updateCulling();                // Phase 4b: per-frame chunk occlusion + flora LOD ring

    // Re-arm the single shadow depth pass for this frame. shadowMap.autoUpdate
    // is permanently false (see engine.js createRenderer) so that the FIRST
    // renderer.render() below does the pass and every other render() the frame
    // issues — Water's mirror hook, OutlinePass's two full-scene passes, every
    // composer fullscreen quad — early-outs instead of redoing it. Skipped
    // while state.shadowFrozen (engine.js's idle branch), which reuses the
    // previous frame's map exactly as before.
    if (state.renderer && !state.shadowFrozen) state.renderer.shadowMap.needsUpdate = true;

    renderFrame();
}

// Render via composer when available, else direct renderer
function renderFrame() {
    if (state.composer && state.composerEnabled) {
        state.composer.render();
    } else {
        state.renderer.render(state.scene, state.camera);
    }
}

/* ============================================================
   Teardown
   ============================================================ */
export function destroy() {
    if (state.disposed) return;
    state.disposed = true;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;

    /* three's Material.dispose() does NOT dispose the textures the material
       references, and several sprite factories (weather's flake, lava's haze,
       mountain's mist/rainbow/fall, ...) build a CanvasTexture inline and hand
       it straight to a material without recording it anywhere for teardown.
       Those stayed GPU-resident through every module's dispose(): measured at
       ~14 orphaned textures per destroy()/init() cycle — and onContextRestored()
       runs exactly that cycle on every lost context, so a machine losing the
       context repeatedly leaked its way to a second crash.

       Snapshot them off the live scene here and dispose below, once the
       modules have finished tearing it down. dispose() is idempotent and only
       frees the GPU copy — a texture some module-level cache still hands out
       is simply re-uploaded on next use — so double-covering a texture that
       its owner also disposes is harmless. */
    const orphanTex = new Set();
    const orphanShadows = [];
    if (state.scene) {
        state.scene.traverse((o) => {
            // A LightShadow's depth map is a render target three never frees on
            // its own — removing the light from the scene does not touch it. Each
            // init() builds a fresh sun, so without this every cycle stranded
            // another shadow map (16 MB at the 'high' tier's 2048x2048).
            if (o.isLight && o.shadow) orphanShadows.push(o.shadow);
            const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
            for (const m of mats) {
                if (!m) continue;
                for (const k in m) {
                    const t = m[k];
                    if (t && t.isTexture) orphanTex.add(t);
                }
                // ShaderMaterials keep their maps in uniforms, not as named
                // properties — three/addons Water hides its whole mirror
                // render target behind uniforms.tReflectionMap.
                if (m.uniforms) {
                    for (const k in m.uniforms) {
                        const u = m.uniforms[k];
                        if (u && u.value && u.value.isTexture) orphanTex.add(u.value);
                    }
                }
            }
        });
    }

    disposeMusic();
    disposeCaveAudio(); // Phase 2l: stop + disconnect all cave-audio nodes before ctx.close()

    window.removeEventListener('keydown', onKeyDown, false);
    window.removeEventListener('keyup', onKeyUp, false);
    window.removeEventListener('resize', onResize, false);
    if (state.renderer) {
        state.renderer.domElement.removeEventListener('mousedown', onCanvasMouseDown, false);
        state.renderer.domElement.removeEventListener('webglcontextlost', onContextLost, false);
        state.renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored, false);
    }
    if (ui.clickToPlay) ui.clickToPlay.removeEventListener('click', requestLock, false);
    if (state.controls) {
        state.controls.removeEventListener('lock', onLock);
        state.controls.removeEventListener('unlock', onUnlock);
        try { state.controls.unlock(); } catch (e) {}
    }
    disposeTouchControls();

    // Clean the capture layer first (sequences reference creatures & balls)
    disposeCaptureSequences();
    disposeTargeting();
    disposeViewmodel();

    // Clean creatures (shared geo/mat caches disposed once below)
    for (const c of state.creatures) {
        if (c.group) state.scene && state.scene.remove(c.group);
        for (const m of c.materials) {
            if (m && m.dispose) { try { m.dispose(); } catch (e) {} }
        }
    }
    state.creatures = [];
    disposeCreatureCaches();

    // Clean capture toast
    if (state.toastTimer) { clearTimeout(state.toastTimer); state.toastTimer = null; }
    if (state.toastEl) {
        if (state.toastEl.parentNode) state.toastEl.parentNode.removeChild(state.toastEl);
        state.toastEl = null;
        state.toastPts = null;
        state.toastName = null;
        state.toastTier = null;
    }

    // Clean projectiles (shared ball geo/mats disposed once below)
    for (const p of state.projectiles) {
        removeBall(p.mesh);
    }
    state.projectiles = [];
    disposeBallCaches();

    // Clean terrain — the terrain columns + flora detail are sector-chunked
    // (Phase 4b): dispose each chunk mesh's instance buffers + the one shared
    // material per group (shared box geometry is disposed once, below).
    disposeChunked(state.terrainChunks);
    state.terrainChunks = null;
    disposeChunked(state.terrainInteriorChunks);
    state.terrainInteriorChunks = null;
    state.floorMesh = null;
    disposeChunked(state.detailChunks);
    state.detailChunks = null;
    state.obstacleMesh = null;
    disposeChunked(state.wallChunks);
    state.wallChunks = null;
    state.wallMesh = null;
    disposeMesh(state.pondMesh);
    state.pondMesh = null;

    // Clean mountain dressing (waterfall, basin pool, magma vent)
    disposeMountainFeatures();

    // Clean the lava river (flow surface, embers, heat shimmer, steam column)
    disposeLava();

    // Clean weather (precipitation, fog/light overrides, flash light)
    disposeWeather();

    // Clean caves (rock shell, glow dressing, drips, interior lights)
    disposeCaves();

    // Clean the Phase 2k cave-gameplay layer (grotto-ball pickup, collapse rocks,
    // screen-dust overlay) + the pickup hint toast
    disposeCaveGameplay();
    disposeHintToast();

    // Clean water, foam & splash ripples
    if (state.water) {
        if (state.scene) state.scene.remove(state.water);
        if (state.water.geometry) { try { state.water.geometry.dispose(); } catch (e) {} }
        if (state.water.material) { try { state.water.material.dispose(); } catch (e) {} }
        state.water = null;
    }
    if (state.waterNormalTex) { try { state.waterNormalTex.dispose(); } catch (e) {} state.waterNormalTex = null; }
    if (state.foamRing) {
        disposeMesh(state.foamRing);
        state.foamRing = null;
    }
    if (state.foamTex) { try { state.foamTex.dispose(); } catch (e) {} state.foamTex = null; }
    if (state.ripples) {
        for (const rp of state.ripples) {
            if (state.scene) state.scene.remove(rp.mesh);
            if (rp.mesh.material) { try { rp.mesh.material.dispose(); } catch (e) {} }
        }
        state.ripples = [];
    }
    if (state.rippleGeo) { try { state.rippleGeo.dispose(); } catch (e) {} state.rippleGeo = null; }

    // Clean sky, clouds, points of interest & ambient life
    if (state.sky) {
        disposeMesh(state.sky);
        state.sky = null;
    }
    if (state.cloudLayers) {
        for (const layer of state.cloudLayers) disposeMesh(layer.mesh);
        state.cloudLayers = null;
    }
    disposeMesh(state.statueMesh);
    state.statueMesh = null;
    disposeMesh(state.roofMesh);
    state.roofMesh = null;
    if (state.fireflies) {
        if (state.scene) state.scene.remove(state.fireflies);
        if (state.fireflies.geometry) { try { state.fireflies.geometry.dispose(); } catch (e) {} }
        if (state.fireflies.material) { try { state.fireflies.material.dispose(); } catch (e) {} }
        state.fireflies = null;
        state.fireflyData = null;
    }
    if (state.fallingLeaves) {
        disposeMesh(state.fallingLeaves);
        state.fallingLeaves = null;
        state.fallingLeafData = null;
    }
    if (state.birdMesh) {
        disposeMesh(state.birdMesh);
        state.birdMesh = null;
        state.birdData = null;
    }
    // Per-zone ambient particle groups (share one sprite texture, disposed once)
    if (state.zoneGlow) { disposeMesh(state.zoneGlow); state.zoneGlow = null; }
    if (state.zoneSoft) { disposeMesh(state.zoneSoft); state.zoneSoft = null; }
    state.zoneGlowData = null;
    state.zoneSoftData = null;
    if (state.zoneSpriteTex) { try { state.zoneSpriteTex.dispose(); } catch (e) {} state.zoneSpriteTex = null; }
    state.windLight = null;
    state.windLeaves = null;
    state.detailInstances = null;

    // Clean atmosphere-fx.js additions (cloud shadows, ground decals, POI
    // props + campfire light) — reuse state.sharedBoxGeo (disposed once,
    // below), each owns exactly one small material.
    if (state.cloudShadowMesh) { disposeMesh(state.cloudShadowMesh); state.cloudShadowMesh = null; }
    state.cloudShadowData = null;
    if (state.groundDecalMesh) { disposeMesh(state.groundDecalMesh); state.groundDecalMesh = null; }
    state.groundDecalData = null;
    if (state.poiDetailMesh) { disposeMesh(state.poiDetailMesh); state.poiDetailMesh = null; }
    if (state.poiFireLight) { if (state.scene) state.scene.remove(state.poiFireLight); state.poiFireLight = null; }

    if (state.sharedBoxGeo) { try { state.sharedBoxGeo.dispose(); } catch (e) {} state.sharedBoxGeo = null; }
    if (state.sharedInteriorGeo) { try { state.sharedInteriorGeo.dispose(); } catch (e) {} state.sharedInteriorGeo = null; }

    // Clean particles
    if (state.particles) {
        if (state.scene) state.scene.remove(state.particles);
        if (state.particles.geometry) { try { state.particles.geometry.dispose(); } catch (e) {} }
        if (state.particles.material) { try { state.particles.material.dispose(); } catch (e) {} }
        state.particles = null;
    }

    // Clean post-processing (composer + its own render targets, plus each
    // pass's internal targets — was never disposed/nulled here, so a
    // destroy()/init() cycle orphaned one EffectComposer's GPU resources
    // per cycle instead of freeing them).
    if (_resizeTimer) { clearTimeout(_resizeTimer); _resizeTimer = null; }
    if (state.composer) {
        /* EffectComposer.dispose() frees ONLY its own ping-pong pair and the
           internal copy pass — it never walks this.passes. OutlinePass owns 7
           render targets and UnrealBloomPass owns 11 (its whole mip chain), so
           relying on the composer alone orphaned ~13 GPU textures per
           destroy()/init() cycle. Measured: textures climbed 32 -> 45 -> 58 ->
           71 -> 84 -> 97 across six cycles, dead linear, on a renderer that is
           deliberately reused across cycles (engine.js's __globalRenderer).
           onContextRestored() runs this cycle on every lost context. */
        for (const pass of state.composer.passes || []) {
            if (pass && typeof pass.dispose === 'function') { try { pass.dispose(); } catch (e) {} }
        }
        try { state.composer.dispose(); } catch (e) {}
        state.composer = null;
    }
    state.composerEnabled = false;
    state.outlinePass = null;
    state.bloomPass = null;
    state.filmPass = null;
    state.fxPass = null;

    // Every texture that was hanging off a scene material at teardown (see the
    // snapshot at the top). Modules that track their own textures have already
    // disposed theirs; this catches the ones nobody owned.
    for (const t of orphanTex) { try { t.dispose(); } catch (e) {} }
    orphanTex.clear();
    for (const sh of orphanShadows) { try { sh.dispose(); } catch (e) {} }
    orphanShadows.length = 0;

    // Clean engine
    if (state.renderer) {
        if (state.renderer.domElement && state.renderer.domElement.parentNode) {
            state.renderer.domElement.parentNode.removeChild(state.renderer.domElement);
        }
        state.renderer = null;
    }
    if (state.audio) { try { state.audio.close(); } catch (e) {} state.audio = null; }

    state.scene = null;
    state.camera = null;
    state.controls = null;
    state.sun = null;
    state.obstacles = [];
}

function disposeMesh(mesh) {
    if (!mesh) return;
    if (state.scene) state.scene.remove(mesh);
    if (mesh.geometry) { try { mesh.geometry.dispose(); } catch (e) {} }
    if (mesh.material) {
        if (Array.isArray(mesh.material)) {
            for (const m of mesh.material) { try { m.dispose(); } catch (e) {} }
        } else { try { mesh.material.dispose(); } catch (e) {} }
    }
}

/* ============================================================
   Initialization
   ============================================================ */
export function init() {
    if (state.scene) return;
    // destroy() sets this true and never resets it — without this line, any
    // destroy() -> init() cycle (the documented public re-init contract, and
    // now onContextRestored below) would rebuild the whole scene and then
    // have animate() immediately no-op on it forever.
    state.disposed = false;
    try {
        const container = document.getElementById('captcha-container');
        if (!container) throw new Error('#captcha-container not found');
        state.container = container;

        buildEngine(container);
        initTouchControls();
        cacheUI();
        buildTerrain();
        setupPlayer();
        initParticles();
        initAudio();
        initMusic();
        initCaveAudio(); // Phase 2l: reset the cave-audio layer (graph built lazily on first lock)
        initWeather();
        initQuality();
        state.raycaster = new THREE.Raycaster();
        spawnCreatures();
        initCaveGameplay(); // Phase 2k: build the dead-end registry + grotto-ball pickup (after caves + cave-life)
        initViewmodel();
        initTargeting();
        updateCounterUI();

        // Canvas events bindings
        state.renderer.domElement.addEventListener('mousedown', onCanvasMouseDown, false);
        ui.clickToPlay && ui.clickToPlay.addEventListener('click', requestLock, false);
        state.controls.addEventListener('lock', onLock, false);
        state.controls.addEventListener('unlock', onUnlock, false);
        window.addEventListener('resize', onResize, false);
        state.renderer.domElement.addEventListener('webglcontextlost', onContextLost, false);
        state.renderer.domElement.addEventListener('webglcontextrestored', onContextRestored, false);

        // Optional diagnostic hook (only when the page URL carries ?probe) —
        // exposes internal state for the offline test rig. Zero cost otherwise
        // and never part of the frozen public API.
        if (typeof window !== 'undefined' && window.location && /[?&]probe\b/.test(window.location.search)) {
            window.__probe = {
                state, CONFIG,
                zoneAt, ZONES, PARTITION,
                SPAWN, MOUNTAIN, MOUNTAINS, VENT, CAVES, caveAt, sampleCave, caveConfine, caveCeilingAt,
                getTerrainHeight, getGroundY, musicCurrentMood,
                isWaterAt, getWaterLevelAt, getWaterDepth, caveSlippery, riverAt, riverPointAt, riverSpan, BORDER_FALL,
                LAVA, lavaAt,
                forceWeather, forceLightning, weatherState, // force weather + a flash for screenshots
                // Phase 2e cave foundation: theme registry + cull/LOD introspection
                CAVE_THEMES, getCaveThemeDescriptor, caveThemeRegistered, registeredCaveThemes, themeBuildLog,
                updateCaves, // test-only: drive the cull/LOD pass directly (headless rAF doesn't self-tick)
                updateCaveAtmos, updateCaveLight, // Phase 2h: drive eye-adaptation/lantern in the rig
                updateCaveAudio, caveAudioSetActive, stopCaveAudio, caveAudioStats, // Phase 2l: drive/inspect cave audio
                updateCreatures, // Phase 2j: drive creature behavior directly in the headless rig
                // Phase 2k gameplay/capture: capped modifiers + geometry + collapse for the rig
                caveCaptureBonus, tunnelBackDot, atDeadEnd, caveDeadEnds, caveDeepPoint,
                triggerCaveCollapse, updateCaveGameplay, updateProjectiles, updateCaptureSequences, tryCapture,
                caveRicochet, caveThrowUpAngle,
                // Phase 4b perf foundation: the instance/draw/geometry/texture
                // monitor (item 357) + the per-frame chunk-visibility driver, so
                // the rig can read TOTAL and DRAWN instance counts directly and
                // A/B the culling win from a fixed viewpoint.
                perf: {
                    sample: perfSample,           // full {totalInstances, drawnInstances, info, counters}
                    instanceTotal: perfInstanceTotal, // {total, meshes} — matches the 4a scene-walk
                    drawnInstances: perfDrawnInstances,
                },
                updateCulling, // drive occlusion/LOD directly (headless rAF is parked)
                // Section 23 (procedural variety, items 389-402): OXBOW is this
                // seed's river-course descriptor; captureSeedThumbnail is the
                // item-399 capture primitive; everything else this pass added
                // (zone twin-flourish, mountain archetype, cave branchBias/
                // gemLucky, weather personality, creature raritySkew, cloud
                // streak threshold, flora species jitter) is already reachable
                // above via PARTITION/MOUNTAINS/CAVES/weatherState()/state.*.
                OXBOW, captureSeedThumbnail,
            };
        }

        // item 402: "reroll" debug shortcut — Alt+R regenerates the world seed
        // by navigating to a fresh ?seed=N (a full reload). QA/screenshot
        // sweeps across many layouts without hand-editing the URL each time.
        // Gated the same as the ?probe hook above: this touches nothing for
        // normal players, only a QA/test session that opted into ?probe.
        // (A true in-place reroll would need every seeded module-scope IIFE —
        // heightfield's L/MOUNTAINS/PARTITION/CAVES/SPAWN, zones' partition,
        // and every sibling module's own `mulberry32(WORLD_SEED ^ salt)` init —
        // to re-run from scratch; that is an engine-wide rebuild far outside
        // this backlog item's scope, so a reload is the deliberate, safe
        // substitute that still delivers the same QA benefit.)
        if (typeof window !== 'undefined' && window.location && /[?&]probe\b/.test(window.location.search)) {
            window.addEventListener('keydown', (e) => {
                if (e.altKey && e.code === 'KeyR') {
                    e.preventDefault();
                    const newSeed = Math.floor(Math.random() * 0xffffffff) >>> 0;
                    const url = new URL(window.location.href);
                    url.searchParams.set('seed', String(newSeed));
                    window.location.href = url.toString();
                }
            }, false);
        }

        /* item 490: shader precompile warm-up.

           three links a material's GPU program the first time that material is
           actually RENDERED, not when it is built. So every material that is
           off-screen or hidden at spawn — the cave shells and their dressing,
           far biomes, weather precipitation, creature variants — paid its
           compile+link the moment the player first turned toward it or walked
           into it. A link is synchronous and driver-side, tens to hundreds of
           milliseconds each on a real GPU, which is exactly the shape of a
           1-2 second freeze mid-play. Measured over a ten-minute session: the
           program count was still climbing at minute six (37 programs at t=16s,
           59 by t=354s), i.e. ~22 stalls spread through normal play.

           compile() walks the whole scene, including objects that are hidden or
           frustum-culled, and links everything against the current lighting.
           Rendering one real frame afterwards covers what compile() does not:
           the shadow depth materials (WebGLShadowMap links those on its first
           pass) and every composer pass's fullscreen-quad shader.

           Both run here, while the loading overlay is still up and a pause is
           expected and invisible, instead of during play. Neither is required
           for correctness — a failure just restores the old lazy behaviour. */
        try {
            state.renderer.compile(state.scene, state.camera);
            renderFrame();
        } catch (e) {
            console.warn('[captcha] shader warm-up skipped', e);
        }

        state.clock.last = performance.now();
        state.clock.next = state.clock.last;
        animate();
        showClickToPlay(true);

        const loadingEl = document.getElementById('loading');
        if (loadingEl) {
            loadingEl.classList.add('hidden');
        }
    } catch (e) {
        console.error('[captcha] init failed', e);
        const loadingEl = document.getElementById('loading');
        if (loadingEl) {
            loadingEl.classList.add('hidden');
        }
        showFallback(e.message || 'WebGL not available');
    }
}

function showFallback(msg) {
    if (!state.container) return;
    state.container.innerHTML = `<div style="color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center;padding:20px;">${msg}</div>`;
}

function requestLock() {
    if (state.isTouchMode) {
        // No real Pointer Lock on touch — fake the same isLocked + 'lock'
        // event PointerLockControls dispatches so every existing gate
        // (player/projectiles/targeting/viewmodel/music/cave-audio) and
        // the onLock() listener below still fire normally.
        state.controls.isLocked = true;
        state.controls.dispatchEvent({ type: 'lock' });
        return;
    }
    try {
        state.controls.lock();
    } catch (e) {
        console.warn('[captcha] lock request failed', e);
    }
}

function onLock() {
    state.lastLockTime = performance.now();
    state.isPaused = false;
    showClickToPlay(false);
    if (ui.playHint) ui.playHint.classList.add('visible');
    try { if (state.audio && state.audio.state === 'suspended') state.audio.resume(); } catch (e) {}
    musicSetActive(true); // gesture-gated zone ambient starts/resumes here
    caveAudioSetActive(true); // Phase 2l: gesture-gated cave audio layer starts/resumes here
}

function onUnlock() {
    if (ui.playHint) ui.playHint.classList.remove('visible');
    musicSetActive(false); // pause fades the ambient out
    caveAudioSetActive(false); // Phase 2l: pause ducks the cave audio out
    if (state.isCaptchaSolved) return;
    state.isPaused = true;
    showPauseOverlay(true);
}

function onCanvasMouseDown(e) {
    if (!state.controls.isLocked) return;
    if (performance.now() - state.lastLockTime < 100) return;
    tryCapture();
}

// item 485: debounce so a window resize / mobile orientation-change drag
// doesn't thrash renderer+composer render-target reallocation on every
// intermediate event — only the settled final size gets applied.
let _resizeTimer = null;
function onResize() {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(applyResize, 120);
}

function applyResize() {
    _resizeTimer = null;
    if (!state.container || !state.renderer || !state.camera) return;
    const w = state.container.clientWidth;
    const h = state.container.clientHeight;
    state.camera.aspect = w / h;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(w, h);
    // Bug fix: the composer's own render targets (+ OutlinePass/UnrealBloomPass's
    // internal ones) were never resized here, so a post-resize frame rendered
    // post-processing at the stale old resolution into the new-size canvas.
    if (state.composer) state.composer.setSize(w, h);
    // The backing-store pixel BUDGET (CONFIG.MAX_BACKBUFFER_PIXELS) depends on
    // the window size, so the ratio it resolves to has to be recomputed here —
    // otherwise dragging a window onto a larger monitor keeps the old ratio and
    // blows straight through the budget the cap exists to enforce.
    applyPixelRatio();
}

function onContextLost(e) {
    e.preventDefault();
    console.warn('[captcha] context lost - stopping render frames');
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;
}

// Graphics backlog item 498: a lost context used to freeze the game forever
// (onContextLost stopped the loop but nothing ever restarted it — there was
// no 'webglcontextrestored' listener at all). destroy()+init() already do a
// full, clean teardown/rebuild of every three.js resource, so reuse them
// rather than trying to selectively re-upload state onto the restored
// context. window.__globalRenderer (engine.js) is left untouched here since
// a context restore replaces the GL context WebGLRenderer wraps in place —
// there is nothing stale to drop.
function onContextRestored() {
    console.warn('[captcha] context restored - rebuilding');
    destroy();
    init();
}
