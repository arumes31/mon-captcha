/* ============================================================
   Viewmodel — the capture ball held in the hand
   ------------------------------------------------------------
   A detailed voxel ball parented to the camera, bottom-right of
   view. Gentle idle bob + speed-scaled walk sway; on a throw it
   winds up (~0.1s), releases the real projectile at the top of
   the swing, follows through and vanishes, then pops back into
   the hand after a short cooldown. All motion runs off the game
   loop clock — no timers.
   ============================================================ */

import { CONFIG } from './config.js';
import { state } from './state.js';
import { makeCaptureBall } from './ball.js';

// Rest pose in camera space (bottom-right corner, ~1/5 of screen height,
// tilted so the red crown, gold band and glowing button all stay in-view)
const VM_POS = { x: 0.55, y: -0.34, z: -0.78 };
const VM_SCALE = 0.62;

const easeOutBack = (k) => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);

export function initViewmodel() {
    if (!state.camera) return;
    const group = makeCaptureBall({ shadow: false }); // no shadows from a camera-glued prop
    group.scale.setScalar(VM_SCALE);
    group.position.set(VM_POS.x, VM_POS.y, VM_POS.z);
    state.camera.add(group);
    state.viewmodel = {
        group,
        phase: 'idle',   // idle | windup | throw | gone | return
        t: 0,
        swayT: 0,
        release: null,   // pending projectile-spawn callback, fired at release
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
        return;
    }
    g.visible = vm.phase !== 'gone';
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

    // ---- throw state machine ----
    if (vm.phase === 'windup') {
        const k = Math.min(1, vm.t / CONFIG.VM_WINDUP_TIME);
        px += k * 0.1;                 // cock back-down-right
        py -= k * 0.11;
        pz += k * 0.14;
        rx -= k * 1.0;
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
        g.scale.setScalar(VM_SCALE * Math.max(0.001, 1 - k)); // hand-off to the projectile
        if (k >= 1) {
            vm.phase = 'gone';
            vm.t = 0;
        }
    } else if (vm.phase === 'gone') {
        g.visible = false;
        if (vm.t >= CONFIG.VM_COOLDOWN) {
            vm.phase = 'return';
            vm.t = 0;
        }
    } else if (vm.phase === 'return') {
        const k = Math.min(1, vm.t / CONFIG.VM_RETURN_TIME);
        g.scale.setScalar(VM_SCALE * Math.max(0.03, easeOutBack(k))); // pop back into the palm
        if (k >= 1) {
            vm.phase = 'idle';
            vm.t = 0;
            g.scale.setScalar(VM_SCALE);
        }
    }

    g.position.set(px, py, pz);
    g.rotation.set(rx, ry, rz);
}

export function disposeViewmodel() {
    const vm = state.viewmodel;
    if (!vm) return;
    if (vm.group && vm.group.parent) vm.group.parent.remove(vm.group);
    state.viewmodel = null; // shared geo/mats die once in disposeBallCaches()
}
