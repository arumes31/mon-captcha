/* ============================================================
   UI Bindings (Neon Interactive HUD Reticle)
   ============================================================ */

import { CONFIG } from './config.js';
import { state } from './state.js';

export const ui = {};

export function cacheUI() {
    ui.container = state.container;
    ui.counter = document.getElementById('counter');
    ui.instructions = document.getElementById('instructions');
    ui.crosshair = document.getElementById('crosshair');
    ui.successModal = document.getElementById('success-modal');
    ui.clickToPlay = document.getElementById('click-to-play');
    ui.playHint = document.getElementById('play-hint');

    if (state.isTouchMode) applyTouchCopy();
}

// One-time copy swap for touch mode — same textContent-rewrite pattern
// showPauseOverlay already uses for the h1/p inside #click-to-play-card.
function applyTouchCopy() {
    if (ui.instructions) {
        ui.instructions.textContent = 'Left stick to move · Drag right side to look · Buttons: jump / crouch / throw';
    }
    if (ui.playHint) {
        ui.playHint.textContent = 'Drag to look · Tap Throw to capture';
    }
    if (ui.clickToPlay) {
        const h1 = ui.clickToPlay.querySelector('#click-to-play-card h1');
        const hint = ui.clickToPlay.querySelector('.hint');
        if (h1) h1.textContent = 'Tap to play';
        if (hint) hint.textContent = 'Tap anywhere to begin.';
    }
}

export function updateCounterUI() {
    if (ui.counter) {
        ui.counter.textContent = `Captured: ${state.creaturesCaught}/${CONFIG.CAPTURES_REQUIRED}`;
    }
}

export function showClickToPlay(show) {
    if (!ui.clickToPlay) return;
    if (show) ui.clickToPlay.classList.remove('hidden');
    else ui.clickToPlay.classList.add('hidden');
}

export function showPauseOverlay(show) {
    if (!ui.clickToPlay) return;
    if (show) {
        const card = ui.clickToPlay.querySelector('#click-to-play-card');
        if (card) {
            card.querySelector('h1').textContent = 'Paused';
            const ps = card.querySelectorAll('p');
            if (ps[0]) ps[0].textContent = state.isTouchMode ? 'Tap to resume' : 'Click to resume';
        }
        showClickToPlay(true);
    } else {
        showClickToPlay(false);
    }
}

// Success Modal
export function showSuccessModal() {
    if (!ui.successModal) return;
    ui.successModal.classList.add('visible');
    
    // Add success modal continue button listener
    const btn = ui.successModal.querySelector('#success-continue');
    if (btn) {
        btn.addEventListener('click', () => {
            ui.successModal.classList.remove('visible');
        });
    }
}

// (The reticle hover raycast moved to targeting.js — it now also feeds the
// Palworld-style capture readout panel and the 3D targeting ring.)

/* ------------------------------------------------------------
   Capture toast — small pill (styled like #play-hint, inline
   only): "+N" points badge + creature name + tier for ~1.5s.
   ------------------------------------------------------------ */
const TIER_COLORS = { common: '#9aa5b1', uncommon: '#4ade80', rare: '#7db2ff', legendary: '#ffd75e' };

export function showCaptureToast(def, points = 1) {
    if (!state.container) return;
    if (!state.toastEl) {
        const el = document.createElement('div');
        el.style.cssText = [
            'position:absolute', 'left:50%', 'bottom:96px', 'transform:translateX(-50%)',
            'background:rgba(10,14,20,0.72)', 'border:1px solid rgba(255,255,255,0.14)',
            'border-radius:999px', 'padding:10px 18px', 'color:#fff',
            'font:600 14px/1.2 system-ui,-apple-system,sans-serif', 'letter-spacing:0.02em',
            'z-index:30', 'pointer-events:none', 'white-space:nowrap',
            'opacity:0', 'transition:opacity 0.25s ease',
        ].join(';');
        const pts = document.createElement('span');
        pts.style.cssText = 'margin-right:8px;font-weight:800;color:#ffd75e;';
        const name = document.createElement('span');
        const tier = document.createElement('span');
        tier.style.cssText = 'margin-left:8px;font-size:12px;text-transform:uppercase;letter-spacing:0.12em;';
        el.appendChild(pts);
        el.appendChild(name);
        el.appendChild(tier);
        state.container.appendChild(el);
        state.toastEl = el;
        state.toastPts = pts;
        state.toastName = name;
        state.toastTier = tier;
    }
    state.toastPts.textContent = `+${points}`;
    state.toastName.textContent = def.name + ' captured!';
    state.toastTier.textContent = def.tier;
    state.toastTier.style.color = TIER_COLORS[def.tier] || '#fff';
    state.toastEl.style.opacity = '1';
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
        if (state.toastEl) state.toastEl.style.opacity = '0';
    }, 1500);
}

/* ------------------------------------------------------------
   Generic hint toast — a one-line reward/notice pill (Phase 2k:
   the grotto-ball pickup). Its own DOM node (separate from the
   capture toast so a pickup + a catch can show together), same
   inline-styled field-guide skin.
   ------------------------------------------------------------ */
export function showHintToast(text, accent = '#5ff0d0', ms = 2600) {
    if (!state.container) return;
    if (!state.hintToastEl) {
        const el = document.createElement('div');
        el.style.cssText = [
            'position:absolute', 'left:50%', 'bottom:140px', 'transform:translateX(-50%)',
            'background:rgba(10,14,20,0.78)', 'border:1px solid rgba(255,255,255,0.16)',
            'border-radius:999px', 'padding:9px 18px',
            "font:700 14px/1.2 'Fraunces',Georgia,serif", 'letter-spacing:0.02em',
            'z-index:31', 'pointer-events:none', 'white-space:nowrap',
            'opacity:0', 'transition:opacity 0.25s ease',
        ].join(';');
        state.container.appendChild(el);
        state.hintToastEl = el;
    }
    state.hintToastEl.textContent = text;
    state.hintToastEl.style.color = accent;
    state.hintToastEl.style.borderColor = accent + '66';
    state.hintToastEl.style.opacity = '1';
    if (state.hintToastTimer) clearTimeout(state.hintToastTimer);
    state.hintToastTimer = setTimeout(() => {
        if (state.hintToastEl) state.hintToastEl.style.opacity = '0';
    }, ms);
}

export function disposeHintToast() {
    if (state.hintToastTimer) { clearTimeout(state.hintToastTimer); state.hintToastTimer = null; }
    if (state.hintToastEl) {
        if (state.hintToastEl.parentNode) state.hintToastEl.parentNode.removeChild(state.hintToastEl);
        state.hintToastEl = null;
    }
}
