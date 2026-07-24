/* ============================================================
   Touch Controls (Mobile)
   ------------------------------------------------------------
   Feature-detects a coarse (touch) primary pointer and, only in
   that case, wires up a virtual joystick (analog move), a
   drag-to-look zone, and jump/crouch/throw/pause buttons.

   Real browser Pointer Lock is unreliable-to-absent on touch, so
   this never touches PointerLockControls' own lock()/mousemove
   path — it fakes state.controls.isLocked + dispatches the same
   'lock'/'unlock' events the desktop path already relies on, so
   every existing isLocked gate (player.js, projectiles.js,
   targeting.js, viewmodel.js, music.js, caves-audio.js, game.js)
   keeps working untouched.

   Zero cost on desktop: every exported function no-ops unless
   state.isTouchMode is true.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { tryCapture } from './projectiles.js';

let els = null; // cached DOM refs, built once in initTouchControls
const _euler = new THREE.Euler(0, 0, 0, 'YXZ'); // same order/clamp as PointerLockControls

function detectTouchMode() {
    try {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
            window.matchMedia('(pointer: coarse)').matches;
    } catch (e) {
        return false; // safest default: desktop keyboard/mouse controls
    }
}

export function initTouchControls() {
    state.isTouchMode = detectTouchMode();
    if (typeof document !== 'undefined' && document.body) {
        document.body.classList.toggle('touch-mode', state.isTouchMode);
    }
    if (!state.isTouchMode) return;

    state.touch = {
        moveId: null, moveOriginX: 0, moveOriginY: 0,
        lookId: null, lookLastX: 0, lookLastY: 0,
        lookDeltaX: 0, lookDeltaY: 0,
        crouchOn: false,
    };

    els = {
        root: document.getElementById('touch-controls'),
        lookZone: document.getElementById('touch-look-zone'),
        moveZone: document.getElementById('touch-move-zone'),
        moveKnob: document.getElementById('touch-move-knob'),
        jumpBtn: document.getElementById('touch-jump-btn'),
        crouchBtn: document.getElementById('touch-crouch-btn'),
        throwBtn: document.getElementById('touch-throw-btn'),
        pauseBtn: document.getElementById('touch-pause-btn'),
    };
    if (!els.root) return; // markup missing (e.g. an embedding page trimmed it) — nothing to wire up

    if (els.moveZone) {
        els.moveZone.addEventListener('touchstart', onMoveStart, { passive: false });
        els.moveZone.addEventListener('touchmove', onMoveMove, { passive: false });
        els.moveZone.addEventListener('touchend', onMoveEnd, false);
        els.moveZone.addEventListener('touchcancel', onMoveEnd, false);
    }
    if (els.lookZone) {
        els.lookZone.addEventListener('touchstart', onLookStart, { passive: false });
        els.lookZone.addEventListener('touchmove', onLookMove, { passive: false });
        els.lookZone.addEventListener('touchend', onLookEnd, false);
        els.lookZone.addEventListener('touchcancel', onLookEnd, false);
    }
    if (els.jumpBtn) {
        els.jumpBtn.addEventListener('touchstart', onJumpStart, { passive: false });
        els.jumpBtn.addEventListener('touchend', onJumpEnd, false);
        els.jumpBtn.addEventListener('touchcancel', onJumpEnd, false);
    }
    if (els.crouchBtn) {
        els.crouchBtn.addEventListener('touchstart', onCrouchToggle, { passive: false });
    }
    if (els.throwBtn) {
        els.throwBtn.addEventListener('touchstart', onThrow, { passive: false });
    }
    if (els.pauseBtn) {
        els.pauseBtn.addEventListener('touchstart', onPauseTap, { passive: false });
    }

    // Piggyback on the same lock/unlock events game.js's onLock/onUnlock
    // already listen for (dispatched for real on desktop pointer-lock
    // change, or manually by game.js's requestLock()/our own onPauseTap
    // on touch) — shows/hides the touch HUD without any game.js changes.
    state.controls.addEventListener('lock', onGameLock);
    state.controls.addEventListener('unlock', onGameUnlock);
}

export function updateTouchControls() {
    if (!state.isTouchMode || !state.touch) return;
    const t = state.touch;
    if (t.lookDeltaX === 0 && t.lookDeltaY === 0) return;

    const camera = state.camera;
    _euler.setFromQuaternion(camera.quaternion);
    _euler.y -= t.lookDeltaX * CONFIG.TOUCH_LOOK_SENSITIVITY;
    _euler.x -= t.lookDeltaY * CONFIG.TOUCH_LOOK_SENSITIVITY;
    _euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, _euler.x));
    camera.quaternion.setFromEuler(_euler);
    t.lookDeltaX = 0;
    t.lookDeltaY = 0;
}

export function disposeTouchControls() {
    if (els) {
        if (els.moveZone) {
            els.moveZone.removeEventListener('touchstart', onMoveStart, { passive: false });
            els.moveZone.removeEventListener('touchmove', onMoveMove, { passive: false });
            els.moveZone.removeEventListener('touchend', onMoveEnd, false);
            els.moveZone.removeEventListener('touchcancel', onMoveEnd, false);
        }
        if (els.lookZone) {
            els.lookZone.removeEventListener('touchstart', onLookStart, { passive: false });
            els.lookZone.removeEventListener('touchmove', onLookMove, { passive: false });
            els.lookZone.removeEventListener('touchend', onLookEnd, false);
            els.lookZone.removeEventListener('touchcancel', onLookEnd, false);
        }
        if (els.jumpBtn) {
            els.jumpBtn.removeEventListener('touchstart', onJumpStart, { passive: false });
            els.jumpBtn.removeEventListener('touchend', onJumpEnd, false);
            els.jumpBtn.removeEventListener('touchcancel', onJumpEnd, false);
        }
        if (els.crouchBtn) els.crouchBtn.removeEventListener('touchstart', onCrouchToggle, { passive: false });
        if (els.throwBtn) els.throwBtn.removeEventListener('touchstart', onThrow, { passive: false });
        if (els.pauseBtn) els.pauseBtn.removeEventListener('touchstart', onPauseTap, { passive: false });
        if (els.root) els.root.classList.remove('visible');
        if (els.moveKnob) els.moveKnob.style.transform = '';
        if (els.crouchBtn) els.crouchBtn.classList.remove('active');
    }
    if (state.controls) {
        state.controls.removeEventListener('lock', onGameLock);
        state.controls.removeEventListener('unlock', onGameUnlock);
    }
    if (state.player) state.player.analogMove = null;
    state.touch = null;
    els = null;
}

/* ------------------------------------------------------------
   Lock/unlock: show/hide the touch HUD, reset transient state
   ------------------------------------------------------------ */
function onGameLock() {
    if (els && els.root) els.root.classList.add('visible');
}

function onGameUnlock() {
    if (els && els.root) els.root.classList.remove('visible');
    releaseMoveTouch();
    releaseLookTouch();
    setCrouch(false); // never resume paused mid-crouch from a forgotten toggle
}

/* ------------------------------------------------------------
   Move joystick — analog, clamped to CONFIG.TOUCH_JOYSTICK_RADIUS
   ------------------------------------------------------------ */
function findTouch(touchList, id) {
    if (id === null) return null;
    for (let i = 0; i < touchList.length; i++) {
        if (touchList[i].identifier === id) return touchList[i];
    }
    return null;
}

function onMoveStart(e) {
    e.preventDefault();
    if (state.touch.moveId !== null) return;
    const touch = e.changedTouches[0];
    state.touch.moveId = touch.identifier;
    const rect = els.moveZone.getBoundingClientRect();
    state.touch.moveOriginX = rect.left + rect.width / 2;
    state.touch.moveOriginY = rect.top + rect.height / 2;
    updateMoveVector(touch.clientX, touch.clientY);
}

function onMoveMove(e) {
    const touch = findTouch(e.changedTouches, state.touch.moveId);
    if (!touch) return;
    e.preventDefault();
    updateMoveVector(touch.clientX, touch.clientY);
}

function onMoveEnd(e) {
    const touch = findTouch(e.changedTouches, state.touch.moveId);
    if (!touch) return;
    releaseMoveTouch();
}

function updateMoveVector(clientX, clientY) {
    const t = state.touch;
    const radius = CONFIG.TOUCH_JOYSTICK_RADIUS;
    let dx = clientX - t.moveOriginX;
    let dy = clientY - t.moveOriginY;
    let dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > radius) {
        dx = (dx / dist) * radius;
        dy = (dy / dist) * radius;
        dist = radius;
    }
    if (els.moveKnob) els.moveKnob.style.transform = `translate(${dx}px, ${dy}px)`;

    const mag = dist / radius; // 0..1
    const dz = CONFIG.TOUCH_JOYSTICK_DEADZONE;
    if (dist === 0 || mag < dz) {
        state.player.analogMove = { fwd: 0, strafe: 0 };
        return;
    }
    // Re-map past the deadzone so clearing it doesn't jump-start motion at
    // (1 - deadzone) magnitude — full range is still reachable at the edge.
    const eased = (mag - dz) / (1 - dz);
    const ux = dx / dist;
    const uy = dy / dist;
    // Screen-space: joystick pushed up (negative dy) = forward; right = strafe right.
    state.player.analogMove = { fwd: -uy * eased, strafe: ux * eased };
}

function releaseMoveTouch() {
    state.touch.moveId = null;
    state.player.analogMove = null;
    if (els && els.moveKnob) els.moveKnob.style.transform = '';
}

/* ------------------------------------------------------------
   Look zone — raw drag deltas accumulated, consumed once/frame
   in updateTouchControls so rotation stays frame-rate independent.
   ------------------------------------------------------------ */
function onLookStart(e) {
    e.preventDefault();
    if (state.touch.lookId !== null) return;
    const touch = e.changedTouches[0];
    state.touch.lookId = touch.identifier;
    state.touch.lookLastX = touch.clientX;
    state.touch.lookLastY = touch.clientY;
}

function onLookMove(e) {
    const touch = findTouch(e.changedTouches, state.touch.lookId);
    if (!touch) return;
    e.preventDefault();
    const t = state.touch;
    t.lookDeltaX += touch.clientX - t.lookLastX;
    t.lookDeltaY += touch.clientY - t.lookLastY;
    t.lookLastX = touch.clientX;
    t.lookLastY = touch.clientY;
}

function onLookEnd(e) {
    const touch = findTouch(e.changedTouches, state.touch.lookId);
    if (!touch) return;
    releaseLookTouch();
}

function releaseLookTouch() {
    state.touch.lookId = null;
    state.touch.lookDeltaX = 0;
    state.touch.lookDeltaY = 0;
}

/* ------------------------------------------------------------
   Buttons — jump (momentary), crouch (toggle), throw, pause
   ------------------------------------------------------------ */
function onJumpStart(e) {
    e.preventDefault();
    state.player.keys['Space'] = true;
}
function onJumpEnd(e) {
    e.preventDefault();
    state.player.keys['Space'] = false;
}

function onCrouchToggle(e) {
    e.preventDefault();
    setCrouch(!state.touch.crouchOn);
}

function setCrouch(on) {
    if (state.touch) state.touch.crouchOn = on;
    if (state.player) state.player.keys['ControlLeft'] = on;
    if (els && els.crouchBtn) els.crouchBtn.classList.toggle('active', on);
}

function onThrow(e) {
    e.preventDefault();
    if (!state.controls.isLocked) return;
    if (performance.now() - state.lastLockTime < 100) return; // same post-lock debounce as desktop's onCanvasMouseDown
    tryCapture();
}

function onPauseTap(e) {
    e.preventDefault();
    if (!state.controls.isLocked) return;
    state.controls.isLocked = false;
    state.controls.dispatchEvent({ type: 'unlock' });
}
