/* ============================================================
   Camera Shake — shared screen-shake bus
   ------------------------------------------------------------
   Split out of projectiles.js (world-graphics-improvements.md item
   353's original ricochet trick-shot punch) so Section 29's
   audio-visual sync pass could hang MORE shake triggers off the
   same small camera-roll accumulator without creating a circular
   import: projectiles.js already imports from caves-gameplay.js,
   and caves-gameplay.js/creatures/behavior.js each want to trigger
   a shake too (items 462 thunderclap, 467 rock-rumble, 477 golem
   footsteps) — importing straight from projectiles.js from any of
   those would import projectiles.js -> that module -> projectiles.js.
   This tiny standalone module lets every trigger site import it
   with no cycle.

   Camera roll (rotation.z) is left untouched by PointerLockControls
   (pitch/yaw only), so this transient nudge never fights the look
   controls; it decays back to 0 on its own. Only one shake is ever
   "in control" at a time (the strongest still-decaying trigger
   wins) — matching the original ricochet-only behavior, plenty for
   occasional, largely non-overlapping juice beats.
   ============================================================ */
import { state } from './state.js';

let shakeMag = 0, shakeDur = 0, shakeT = 0, shakeFreq = 53;

// freq (rad/s) lets a caller read as a heavier low-frequency thud (item 477's
// golem stomp) instead of the sharper default rattle (item 353's ricochet).
export function triggerScreenShake(mag, dur, freq = 53) {
    shakeMag = Math.max(shakeMag, mag);
    shakeDur = dur;
    shakeT = 0;
    shakeFreq = freq;
}

export function updateScreenShake(dt) {
    const cam = state.camera;
    if (!cam) return;
    if (shakeDur <= 0) {
        if (cam.rotation.z !== 0) cam.rotation.z *= Math.max(0, 1 - dt * 10);
        return;
    }
    shakeT += dt;
    if (shakeT >= shakeDur) {
        shakeDur = 0;
        cam.rotation.z = 0;
        return;
    }
    const k = 1 - shakeT / shakeDur;
    cam.rotation.z = Math.sin(shakeT * shakeFreq) * shakeMag * k;
}
