/* ============================================================
   Viewmodel — the capture ball held in the hand
   ------------------------------------------------------------
   A detailed voxel ball parented to the camera, bottom-right of
   view. Gentle idle bob + speed-scaled walk sway; on a throw it
   winds up (~0.1s), releases the real projectile at the top of
   the swing, follows through and vanishes, then pops back into
   the hand after a short cooldown. All motion runs off the game
   loop clock — no timers.

   Backlog items folded in here (world-graphics-improvements.md):
     328  windup/throw now squash-stretch the ball non-uniformly
          (compress on the pull-back, elongate on the snap) instead
          of a uniform scale.
     331  the "return" pop is now a short flown-in arc (position +
          a trailing sparkle) rather than just a scale-pop.
     334  a charge-up glow builds on the ball during windup.
     336  a small procedural hand/wrist cradles the ball so it reads
          less like a floating prop.
     337  under a low cave ceiling the windup/throw squash flattens
          further, visually explaining the flatter throw arc
          (caveThrowUpAngle, in projectiles.js, already flattens the lob).
     339  breath-fog puffs drift off in cold zones / snowfall.
     341  a dim "empty holster" glow marks the hand during
          VM_COOLDOWN, reading throw availability at a glance.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { makeCaptureBall, getGlowTexture } from './ball.js';
import { spawnTrailMote } from './particles.js';
import { caveCeilingAt } from './heightfield.js';
import { zoneAt } from './zones/zones.js';
import { weatherState } from './weather/weather.js';

// Rest pose in camera space (bottom-right corner, ~1/5 of screen height,
// tilted so the red crown, gold band and glowing button all stay in-view)
const VM_POS = { x: 0.55, y: -0.34, z: -0.78 };
const VM_SCALE = 0.62;

const easeOutBack = (k) => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);

const _worldScratch = new THREE.Vector3();

// item 336 — a small procedural cradling hand. Geometry/material are
// module-level (built fresh each initViewmodel, torn down each
// disposeViewmodel) — same cache-then-dispose contract as ball.js.
let handGeo = null;
let handMat = null;
function buildHandGroup() {
    if (!handGeo) handGeo = new THREE.BoxGeometry(1, 1, 1);
    if (!handMat) handMat = new THREE.MeshStandardMaterial({ color: 0xd9a878, roughness: 0.75, metalness: 0.03 });
    const g = new THREE.Group();
    const palm = new THREE.Mesh(handGeo, handMat);
    palm.scale.set(0.46, 0.2, 0.4);
    palm.position.set(0.05, -0.34, 0.08);
    g.add(palm);
    for (let i = 0; i < 3; i++) {
        const finger = new THREE.Mesh(handGeo, handMat);
        finger.scale.set(0.09, 0.09, 0.26);
        finger.position.set(-0.1 + i * 0.11, -0.25, 0.28);
        finger.rotation.x = -0.45;
        g.add(finger);
    }
    return g;
}

export function initViewmodel() {
    if (!state.camera) return;
    const group = makeCaptureBall({ shadow: false }); // no shadows from a camera-glued prop
    group.scale.setScalar(VM_SCALE);
    group.position.set(VM_POS.x, VM_POS.y, VM_POS.z);
    state.camera.add(group);

    // item 336: cradling hand — tracks the ball's position/rotation each
    // frame but keeps its own scale, so it doesn't vanish during the throw's
    // hand-off shrink.
    const handGroup = buildHandGroup();
    handGroup.scale.setScalar(VM_SCALE);
    handGroup.position.set(VM_POS.x, VM_POS.y, VM_POS.z);
    state.camera.add(handGroup);

    // item 334: charge-up glow, a CHILD of the ball group (correctly hidden
    // whenever the ball itself is) — its own unshared material.
    const chargeGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getGlowTexture(), color: 0xffe1a0, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    chargeGlow.position.set(0, 0, CONFIG.BALL_RADIUS * 1.05);
    chargeGlow.scale.setScalar(0.001);
    group.add(chargeGlow);

    // item 341: dim "empty holster" glow during VM_COOLDOWN — a direct camera
    // child (NOT parented to the ball group) so it stays visible while the
    // ball itself is hidden during the 'gone' phase.
    const holsterGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getGlowTexture(), color: 0xffcf8a, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    holsterGlow.position.set(VM_POS.x, VM_POS.y, VM_POS.z);
    holsterGlow.scale.setScalar(0.001);
    holsterGlow.visible = false;
    state.camera.add(holsterGlow);

    // item 339: a couple of pooled breath-fog puffs, also direct camera
    // children so they read independent of the ball's own throw phase.
    const breathPuffs = [0, 1].map(() => {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
            map: getGlowTexture(), color: 0xe8f0f5, transparent: true, opacity: 0, depthWrite: false,
        }));
        s.scale.setScalar(0.001);
        s.userData.active = false;
        state.camera.add(s);
        return s;
    });

    state.viewmodel = {
        group, handGroup, chargeGlow, holsterGlow, breathPuffs,
        phase: 'idle',   // idle | windup | throw | gone | return
        t: 0,
        swayT: 0,
        release: null,   // pending projectile-spawn callback, fired at release
        breathT: 0,
        breathIdx: 0,
        breathCheckT: 0,
        isCold: false,
    };
}

/* ------------------------------------------------------------
   Throw gate — the mousedown handler asks for a throw; we only
   grant one while a ball is actually resting in the hand. The
   callback fires at the windup->swing transition so the real
   projectile leaves exactly when the hand snaps forward.
   ------------------------------------------------------------ */
export function requestThrow(onRelease) {
    const vm = state.viewmodel;
    if (!vm) { onRelease(); return true; } // viewmodel failed to init — throw anyway
    if (vm.phase !== 'idle') return false; // hand empty or mid-swing
    vm.phase = 'windup';
    vm.t = 0;
    vm.release = onRelease;
    return true;
}

export function updateViewmodel(dt, elapsed) {
    const vm = state.viewmodel;
    if (!vm) return;
    const g = vm.group;

    const active = state.controls && state.controls.isLocked && !state.isPaused && !state.isCaptchaSolved;
    if (!active) {
        // never release a throw into a paused/solved game — swallow it
        if (vm.phase === 'windup' || vm.phase === 'throw') {
            vm.phase = 'idle';
            vm.t = 0;
            vm.release = null;
            g.scale.setScalar(VM_SCALE);
        }
        g.visible = false;
        vm.handGroup.visible = false;
        vm.holsterGlow.visible = false;
        for (const p of vm.breathPuffs) p.material.opacity = 0;
        return;
    }
    g.visible = vm.phase !== 'gone';
    vm.handGroup.visible = true;
    vm.t += dt;

    // ---- idle bob + walk sway (amplitude follows player speed) ----
    const spd = state.player.velocity ? state.player.velocity.length() : 0;
    const walkK = Math.min(1, spd / CONFIG.PLAYER_MAX_SPEED);
    vm.swayT += dt * (1.6 + walkK * 6.4);
    let px = VM_POS.x + Math.sin(vm.swayT) * (0.003 + walkK * 0.012);
    let py = VM_POS.y + Math.sin(vm.swayT * 2) * (0.004 + walkK * 0.011) + Math.sin(elapsed * 1.4) * 0.004;
    let pz = VM_POS.z;
    let rx = -0.14 + Math.sin(elapsed * 1.1) * 0.03;
    let ry = -0.35 + Math.sin(elapsed * 0.6) * 0.08; // slow turn so the gold band shimmers
    let rz = 0.05 + Math.sin(vm.swayT) * walkK * 0.03;

    // item 337: under a low cave ceiling, flatten the squash further so the
    // windup/throw visually sells the flatter throw arc (caveThrowUpAngle in
    // projectiles.js already reduces the lob under the same condition).
    let caveFlatten = 0;
    const camPos = state.camera.position;
    const ceil = caveCeilingAt(camPos.x, camPos.z);
    if (isFinite(ceil)) {
        const headroom = ceil - camPos.y;
        if (headroom < CONFIG.CAVE_LOW_CEIL) caveFlatten = THREE.MathUtils.clamp(1 - headroom / CONFIG.CAVE_LOW_CEIL, 0, 1);
    }

    let scaleX = VM_SCALE, scaleY = VM_SCALE, scaleZ = VM_SCALE;

    // ---- throw state machine ----
    if (vm.phase === 'windup') {
        const k = Math.min(1, vm.t / CONFIG.VM_WINDUP_TIME);
        px += k * 0.1;                 // cock back-down-right
        py -= k * 0.11;
        pz += k * 0.14;
        rx -= k * 1.0;

        // item 328: squash on the pull-back (compress vertically, bulge out)
        scaleX = VM_SCALE * (1 + k * 0.16 + caveFlatten * 0.12);
        scaleY = VM_SCALE * (1 - k * 0.22 - caveFlatten * 0.3);
        scaleZ = VM_SCALE * (1 + k * 0.1 + caveFlatten * 0.12);

        // item 334: charge-up glow builds through the windup
        vm.chargeGlow.material.opacity = k * CONFIG.VM_CHARGE_GLOW_MAX;
        vm.chargeGlow.scale.setScalar(0.1 + k * 0.42);

        if (k >= 1) {
            vm.phase = 'throw';
            vm.t = 0;
            const fn = vm.release;
            vm.release = null;
            if (fn) fn();              // the ball leaves the hand NOW
        }
    } else if (vm.phase === 'throw') {
        const k = Math.min(1, vm.t / CONFIG.VM_THROW_TIME);
        px += (1 - k) * 0.1 - k * 0.06; // snap forward-up, following through
        py += -0.11 + k * 0.24;
        pz += 0.14 - k * 0.42;
        rx += -1.0 + k * 1.7;

        // item 328: stretch peaks mid-swing, then the existing hand-off shrink
        // takes over — squash-stretch reads as extra snap on the follow-through.
        const stretch = Math.sin(k * Math.PI) * (1 - caveFlatten * 0.4);
        const shrink = Math.max(0.001, 1 - k);
        scaleX = VM_SCALE * shrink * (1 - stretch * 0.22);
        scaleY = VM_SCALE * shrink * (1 - stretch * 0.16 - caveFlatten * 0.25);
        scaleZ = VM_SCALE * shrink * (1 + stretch * 0.55);

        vm.chargeGlow.material.opacity = Math.max(0, CONFIG.VM_CHARGE_GLOW_MAX * (1 - k * 3));

        if (k >= 1) {
            vm.phase = 'gone';
            vm.t = 0;
        }
    } else if (vm.phase === 'gone') {
        g.visible = false;
        vm.chargeGlow.material.opacity = 0;

        // item 341: empty-holster glow intensifies as the cooldown nears done
        const k = Math.min(1, vm.t / CONFIG.VM_COOLDOWN);
        vm.holsterGlow.visible = true;
        vm.holsterGlow.material.opacity = CONFIG.VM_HOLSTER_GLOW_MAX * (0.25 + 0.75 * k);
        vm.holsterGlow.scale.setScalar(0.08 + 0.1 * (0.4 + 0.6 * Math.sin(k * Math.PI * 0.5)));

        if (vm.t >= CONFIG.VM_COOLDOWN) {
            vm.phase = 'return';
            vm.t = 0;
        }
    } else if (vm.phase === 'return') {
        vm.holsterGlow.visible = false;
        // item 331: a short flown-in arc (position, not just a scale-pop),
        // trailing a fading sparkle back into the hand.
        const k = Math.min(1, vm.t / CONFIG.VM_RETURN_TIME);
        const back = easeOutBack(k);
        px += (1 - back) * 0.24;
        py += (1 - back) * -0.32;
        pz += (1 - back) * 0.18;
        const s = Math.max(0.03, back);
        scaleX = VM_SCALE * s; scaleY = VM_SCALE * s; scaleZ = VM_SCALE * s;

        if (state.qualityLevel !== 'low' && Math.random() < dt * 55) {
            g.getWorldPosition(_worldScratch);
            spawnTrailMote(_worldScratch.x, _worldScratch.y, _worldScratch.z, 0xffe2b8);
        }
        if (k >= 1) {
            vm.phase = 'idle';
            vm.t = 0;
            scaleX = scaleY = scaleZ = VM_SCALE;
        }
    } else {
        vm.chargeGlow.material.opacity = 0;
        vm.holsterGlow.visible = false;
    }

    g.position.set(px, py, pz);
    g.rotation.set(rx, ry, rz);
    g.scale.set(scaleX, scaleY, scaleZ);
    vm.handGroup.position.set(px, py, pz);
    vm.handGroup.rotation.set(rx, ry, rz);

    // item 339: breath-fog in cold zones / snowfall — cheap zone/weather read
    // throttled to twice a second, not every frame.
    vm.breathCheckT += dt;
    if (vm.breathCheckT > 0.5) {
        vm.breathCheckT = 0;
        const zone = zoneAt(camPos.x, camPos.z);
        vm.isCold = !!(zone && (zone.id === 'ice' || zone.id === 'snow')) || weatherState().cur === 'snowfall';
    }
    if (vm.isCold && state.qualityLevel !== 'low') {
        vm.breathT += dt;
        if (vm.breathT >= CONFIG.BREATH_FOG_INTERVAL) {
            vm.breathT = 0;
            const puff = vm.breathPuffs[vm.breathIdx];
            vm.breathIdx = (vm.breathIdx + 1) % vm.breathPuffs.length;
            puff.userData.active = true;
            puff.userData.age = 0;
            puff.position.set(0.02 + (Math.random() - 0.5) * 0.03, -0.1, -0.42);
            puff.scale.setScalar(0.05);
            puff.material.opacity = 0.45;
        }
    }
    for (const puff of vm.breathPuffs) {
        if (!puff.userData.active) continue;
        puff.userData.age += dt;
        const t = puff.userData.age / 1.5;
        if (t >= 1) { puff.userData.active = false; puff.material.opacity = 0; continue; }
        puff.position.y += dt * 0.1;
        puff.position.z -= dt * 0.06;
        puff.scale.setScalar(0.05 + t * 0.24);
        puff.material.opacity = 0.45 * (1 - t);
    }
}

export function disposeViewmodel() {
    const vm = state.viewmodel;
    if (!vm) return;
    if (vm.group && vm.group.parent) vm.group.parent.remove(vm.group);
    if (vm.handGroup && vm.handGroup.parent) vm.handGroup.parent.remove(vm.handGroup);
    if (vm.holsterGlow) {
        if (vm.holsterGlow.parent) vm.holsterGlow.parent.remove(vm.holsterGlow);
        try { vm.holsterGlow.material.dispose(); } catch (e) {}
    }
    if (vm.chargeGlow) { try { vm.chargeGlow.material.dispose(); } catch (e) {} }
    if (vm.breathPuffs) {
        for (const p of vm.breathPuffs) {
            if (p.parent) p.parent.remove(p);
            try { p.material.dispose(); } catch (e) {}
        }
    }
    if (handGeo) { try { handGeo.dispose(); } catch (e) {} handGeo = null; }
    if (handMat) { try { handMat.dispose(); } catch (e) {} handMat = null; }
    state.viewmodel = null; // ball's own shared geo/mats die once in disposeBallCaches()
}
