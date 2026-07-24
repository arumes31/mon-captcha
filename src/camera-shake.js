/* ============================================================
   Camera Shake — shared screen-shake bus
   ------------------------------------------------------------
   Split out of projectiles.js (world-graphics-improvements.md item
   353's original ricochet trick-shot punch) so Section 29's
   audio-visual sync pass could hang MORE shake triggers off the
   same small accumulator without creating a circular import:
   projectiles.js already imports from caves-gameplay.js, and
   caves-gameplay.js / creatures/behavior.js each want to trigger a
   shake too (items 462 thunderclap, 467 rock-rumble, 477 golem
   footsteps) — importing straight from projectiles.js from any of
   those would cycle projectiles.js -> that module -> projectiles.js.
   This tiny standalone module lets every trigger site import it
   with no cycle.

   IMPORTANT — the shake is applied as a CSS `rotate()` on the canvas
   ELEMENT, NOT by touching camera.rotation.z. An earlier version set
   camera.rotation.z directly on the theory that PointerLockControls
   "only reads/writes pitch+yaw and leaves roll alone" — that's false
   and caused a real bug (fast mouse-look could flip the whole view
   upside down): PointerLockControls decomposes the camera's FULL
   quaternion in 'YXZ' order on every mousemove, so any roll this bus
   wrote got folded back into look math and warped it, worse the
   faster/more often the mouse moved. A CSS transform on the canvas is
   a pure screen-space overlay the renderer/camera/controls never see,
   so it can't get tangled into mouse-look at all. Any future shake
   MUST use this bus (or the same canvas-transform pattern) rather
   than mutating camera.rotation. See projectiles.js git history for
   the full write-up.

   Only one shake is ever "in control" at a time (the strongest
   still-decaying trigger wins) — plenty for occasional, largely
   non-overlapping juice beats.
   ============================================================ */
import { state } from './state.js';

let shakeMag = 0, shakeDur = 0, shakeT = 0, shakeFreq = 53, shakeAngle = 0;

// freq (rad/s) lets a caller read as a heavier low-frequency thud (item 477's
// golem stomp) instead of the sharper default rattle (item 353's ricochet).
export function triggerScreenShake(mag, dur, freq = 53) {
    shakeMag = Math.max(shakeMag, mag);
    shakeDur = dur;
    shakeT = 0;
    shakeFreq = freq;
}

export function updateScreenShake(dt) {
    const canvas = state.renderer && state.renderer.domElement;
    if (!canvas) return;
    if (shakeDur <= 0) {
        if (shakeAngle !== 0) {
            shakeAngle *= Math.max(0, 1 - dt * 10);
            if (Math.abs(shakeAngle) < 0.0001) shakeAngle = 0;
            canvas.style.transform = shakeAngle === 0 ? '' : `rotate(${shakeAngle}rad)`;
        }
        return;
    }
    shakeT += dt;
    if (shakeT >= shakeDur) {
        shakeDur = 0;
        shakeAngle = 0;
        canvas.style.transform = '';
        return;
    }
    const k = 1 - shakeT / shakeDur;
    shakeAngle = Math.sin(shakeT * shakeFreq) * shakeMag * k;
    canvas.style.transform = `rotate(${shakeAngle}rad)`;
}
