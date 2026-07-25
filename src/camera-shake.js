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

   BUG FIX — "the screen shakes all the time". The original
   triggerScreenShake did `shakeMag = Math.max(shakeMag, mag)` but
   NOTHING ever reset shakeMag back to 0, so it was not "the strongest
   STILL-DECAYING trigger wins" as intended — it was the strongest
   trigger EVER SEEN, for the rest of the session. One nearby
   thunderclap (CONFIG.THUNDER_SHAKE_MAG 0.05 rad ~= 2.9 degrees of
   full-screen roll) permanently pinned the amplitude, and from then on
   every subsequent trigger — including a barely-felt golem footstep
   30m away, whose own `near` falloff had scaled it down to near
   nothing — replayed at that full 2.9 degrees.

   That collided with item 477's golem footfalls, which re-trigger on
   every zero-crossing of the leg-sway sine: at `3 + speed*5` rad/s a
   golem stomps (3 + speed*5)/PI times a second, i.e. every 0.4-0.6s,
   while GOLEM_STOMP_SHAKE_TIME is 0.28s. A single golem inside the
   (formerly 30m) trigger radius therefore restarted the shake before
   the previous one had finished decaying, and two golems made it
   literally continuous. Permanent max amplitude + permanent retrigger
   = a screen that never stops shaking.

   The accumulator is now decay-aware: a new trigger only takes over if
   it is genuinely stronger than what is left of the live one, the
   magnitude is cleared when a shake expires, and sub-threshold
   triggers are dropped outright instead of restarting the timer.
   ============================================================ */
import { state } from './state.js';

let shakeMag = 0, shakeDur = 0, shakeT = 0, shakeFreq = 53, shakeAngle = 0;

// Below this the roll is under ~0.15 degrees — invisible, but still enough to
// restart the timer and keep a per-frame style write alive on the canvas. Drop
// those triggers entirely rather than paying for a shake nobody can see.
const MIN_SHAKE_MAG = 0.004;

// freq (rad/s) lets a caller read as a heavier low-frequency thud (item 477's
// golem stomp) instead of the sharper default rattle (item 353's ricochet).
export function triggerScreenShake(mag, dur, freq = 53) {
    if (!(mag >= MIN_SHAKE_MAG) || !(dur > 0)) return;
    // What is actually LEFT of the shake currently in control (0 once expired).
    // Comparing against this — not against an all-time high-water mark — is
    // what makes "the strongest still-decaying trigger wins" true.
    const residual = shakeDur > 0 ? shakeMag * (1 - shakeT / shakeDur) : 0;
    if (mag <= residual) return; // a weaker beat never overrides (or restarts) a stronger live one
    shakeMag = mag;
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
        shakeMag = 0; // <- the reset the original was missing; see the header note
        shakeAngle = 0;
        canvas.style.transform = '';
        return;
    }
    const k = 1 - shakeT / shakeDur;
    shakeAngle = Math.sin(shakeT * shakeFreq) * shakeMag * k;
    canvas.style.transform = `rotate(${shakeAngle}rad)`;
}

// Test/diagnostic hook — lets the offline rig assert the accumulator actually
// decays to rest instead of latching at an all-time maximum.
export function screenShakeDebug() {
    return { mag: shakeMag, dur: shakeDur, t: shakeT, freq: shakeFreq, angle: shakeAngle };
}
