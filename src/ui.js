/* ============================================================
   UI Bindings (Neon Interactive HUD Reticle)
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { zoneAt } from './zones/zones.js';
import { weatherState } from './weather/weather.js';

export const ui = {};

// Shared scratch Euler for the compass needle + off-screen legendary
// bearing (items 403/416) — same order PointerLockControls/touch-controls
// already use, so "yaw" reads consistently everywhere in the codebase.
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

export function cacheUI() {
    ui.container = state.container;
    ui.counter = document.getElementById('counter');
    ui.instructions = document.getElementById('instructions');
    ui.crosshair = document.getElementById('crosshair');
    ui.successModal = document.getElementById('success-modal');
    ui.clickToPlay = document.getElementById('click-to-play');
    ui.playHint = document.getElementById('play-hint');

    // Backlog items 403/408/414/416: HUD polish widgets — all optional
    // (markup-guarded) so an embedding page that trims them just no-ops.
    ui.weatherIcon = document.getElementById('weather-icon');
    ui.weatherLabel = document.getElementById('weather-label');
    ui.compass = document.getElementById('compass');
    ui.compassNeedle = document.getElementById('compass-needle');
    ui.legendaryRadar = document.getElementById('legendary-radar');
    ui.cooldownWipe = document.getElementById('cooldown-wipe');

    if (state.isTouchMode) applyTouchCopy();

    loadPrefs();
    applyPrefs();
    initA11yPanel();
    startHudTicker();
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

let firstCaptureFadeDone = 0; // last-seen creaturesCaught, edge-detects the FIRST capture (item 409)

export function updateCounterUI() {
    if (ui.counter) {
        ui.counter.textContent = `Captured: ${state.creaturesCaught}/${CONFIG.CAPTURES_REQUIRED}`;
        // item 404: progress-ring border fill (see style.css's #counter::after)
        const pct = Math.max(0, Math.min(100, (state.creaturesCaught / CONFIG.CAPTURES_REQUIRED) * 100));
        ui.counter.style.setProperty('--progress', String(pct));
    }
    // item 409: fade the always-on control hints out after the player's
    // actual first successful capture rather than a fixed timer, so a slow
    // first throw never costs anyone the chance to read them.
    if (state.creaturesCaught > 0 && firstCaptureFadeDone === 0 && ui.instructions) {
        ui.instructions.classList.add('instructions-faded');
    }
    firstCaptureFadeDone = state.creaturesCaught;
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
// Palworld-style capture readout panel and the 3D targeting ring. Its
// per-frame `ui.crosshair.classList.add/remove('hovering')` IS already the
// item-405 hook: crosshair color/scale/glow already changes the instant a
// valid, alive, non-capturing target enters CAPTURE_RANGE. See the CSS
// comment on #crosshair.hovering in style.css for exactly what targeting.js
// would need to expose for a finer, chance-graded color ramp.)

/* ------------------------------------------------------------
   Capture toast — small pill (styled like #play-hint, inline
   only): "+N" points badge + creature name + tier for ~1.5s.
   ------------------------------------------------------------ */
const TIER_COLORS = { common: '#9aa5b1', uncommon: '#4ade80', rare: '#7db2ff', legendary: '#ffd75e' };
// item 417: an alternate, colorblind-conscious tier palette — swaps the
// green/blue uncommon+rare pair for a cyan/violet pair (still nowhere near a
// red/green axis, which the defaults already avoid) so two CVD-affected
// players get genuinely different-reading hues to pick between.
const TIER_COLORS_CB = { common: '#9aa5b1', uncommon: '#2ec4ff', rare: '#9d7bff', legendary: '#ffd75e' };
function tierColor(tier) {
    const table = prefs.colorblindSafe ? TIER_COLORS_CB : TIER_COLORS;
    return table[tier] || '#fff';
}

export function showCaptureToast(def, points = 1) {
    if (!state.container) return;
    if (!state.toastEl) {
        const el = document.createElement('div');
        el.style.cssText = [
            'position:absolute', 'left:50%', 'bottom:96px', 'transform:translateX(-50%)',
            'background:rgba(10,14,20,0.72)', 'border:2px solid rgba(255,255,255,0.14)',
            'border-radius:999px', 'padding:10px 18px', 'color:#fff',
            'font:600 14px/1.2 system-ui,-apple-system,sans-serif', 'letter-spacing:0.02em',
            'z-index:30', 'pointer-events:none', 'white-space:nowrap',
            'opacity:0', 'transition:opacity 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease',
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
    const tc = tierColor(def.tier);
    state.toastTier.style.color = tc;
    // item 406: tier-colored accent on the WHOLE pill (not just the tag
    // text) so rarity reads at a glance, matching the tier colors already
    // used in targeting.js's readout panel.
    state.toastEl.style.borderColor = tc + 'aa';
    state.toastEl.style.boxShadow = def.tier === 'legendary' ? `0 0 18px ${tc}99` : 'none';
    state.toastEl.style.opacity = '1';
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
        if (state.toastEl) state.toastEl.style.opacity = '0';
    }, 1500);
    // item 410: extra HUD-wide celebration weight for a legendary capture,
    // beyond the existing 3D-space particle burst.
    if (def.tier === 'legendary') pulseLegendaryHud();
}

// A brief golden radial wash over the whole viewport (CSS-driven, see
// style.css's #captcha-container.legendary-pulse::after). Toggling the
// class off-then-on (with a forced reflow) lets it re-fire even if two
// legendaries are caught in quick succession.
function pulseLegendaryHud() {
    if (!ui.container) return;
    ui.container.classList.remove('legendary-pulse');
    void ui.container.offsetWidth; // force reflow so the animation restarts
    ui.container.classList.add('legendary-pulse');
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

/* ------------------------------------------------------------
   Accessibility & comfort preferences (items 415/417/418/421/423/428)
   ------------------------------------------------------------
   A small settings panel reached from the shared title/pause card (the
   cursor is always free there, so it never fights Pointer Lock). Prefs
   persist to localStorage and apply as <html> classes/CSS custom
   properties that style.css already reads — no engine/render code touched.
   ------------------------------------------------------------ */
const PREFS_KEY = 'monsterCaptchaA11yPrefs';
const DEFAULT_PREFS = {
    highContrast: false,
    reducedMotion: false,
    largeCrosshair: false,
    colorblindSafe: false,
    brightness: 1,
    hudScale: 1,
};
const prefs = Object.assign({}, DEFAULT_PREFS);
let a11yPrevFocus = null;

function loadPrefs() {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        for (const k in DEFAULT_PREFS) {
            if (k in saved) prefs[k] = saved[k];
        }
    } catch (e) { /* storage blocked/corrupt — keep defaults */ }
}

function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* private mode etc. — not fatal */ }
}

function applyPrefs() {
    const root = document.documentElement;
    root.classList.toggle('pref-high-contrast', prefs.highContrast);
    root.classList.toggle('pref-reduced-motion', prefs.reducedMotion);
    root.classList.toggle('pref-large-crosshair', prefs.largeCrosshair);
    root.classList.toggle('pref-colorblind', prefs.colorblindSafe);
    root.style.setProperty('--hud-scale', String(prefs.hudScale));
    root.style.setProperty('--scene-brightness', String(prefs.brightness));
}

function initA11yPanel() {
    ui.a11yBtn = document.getElementById('a11y-open-btn');
    ui.a11yPanel = document.getElementById('a11y-panel');
    ui.a11yClose = document.getElementById('a11y-close-btn');
    ui.prefHighContrast = document.getElementById('pref-high-contrast');
    ui.prefReducedMotion = document.getElementById('pref-reduced-motion');
    ui.prefLargeCrosshair = document.getElementById('pref-large-crosshair');
    ui.prefColorblind = document.getElementById('pref-colorblind');
    ui.prefBrightness = document.getElementById('pref-brightness');
    ui.prefHudScale = document.getElementById('pref-hud-scale');
    // item 395: shareable ?seed=N link — reached via the same settings dialog
    // (markup-guarded like every other a11y widget above).
    ui.shareSeedInput = document.getElementById('share-seed-input');
    ui.shareSeedBtn = document.getElementById('share-seed-btn');
    initShareSeed();

    // Reflect loaded prefs onto the controls every cacheUI() call (cheap,
    // and correct if init() ever re-runs after destroy()).
    if (ui.prefHighContrast) ui.prefHighContrast.checked = prefs.highContrast;
    if (ui.prefReducedMotion) ui.prefReducedMotion.checked = prefs.reducedMotion;
    if (ui.prefLargeCrosshair) ui.prefLargeCrosshair.checked = prefs.largeCrosshair;
    if (ui.prefColorblind) ui.prefColorblind.checked = prefs.colorblindSafe;
    if (ui.prefBrightness) ui.prefBrightness.value = String(prefs.brightness);
    if (ui.prefHudScale) ui.prefHudScale.value = String(prefs.hudScale);

    // `_wired` guards each listener against being attached twice if cacheUI()
    // ever runs again on a destroy()->init() cycle (these are static, never
    // recreated, DOM nodes).
    if (ui.a11yBtn && !ui.a11yBtn._wired) {
        ui.a11yBtn._wired = true;
        ui.a11yBtn.addEventListener('click', (e) => {
            // #click-to-play (the ancestor) opens Pointer Lock on ANY click —
            // never let this bubble into that, or opening settings would
            // start play.
            e.stopPropagation();
            openA11yPanel();
        });
    }
    if (ui.a11yClose && !ui.a11yClose._wired) {
        ui.a11yClose._wired = true;
        ui.a11yClose.addEventListener('click', () => closeA11yPanel());
    }
    if (ui.a11yPanel && !ui.a11yPanel._wired) {
        ui.a11yPanel._wired = true;
        ui.a11yPanel.addEventListener('click', (e) => {
            if (e.target === ui.a11yPanel) closeA11yPanel(); // click on the scrim itself
        });
    }
    bindToggle(ui.prefHighContrast, 'highContrast');
    bindToggle(ui.prefReducedMotion, 'reducedMotion');
    bindToggle(ui.prefLargeCrosshair, 'largeCrosshair');
    bindToggle(ui.prefColorblind, 'colorblindSafe');
    bindRange(ui.prefBrightness, 'brightness');
    bindRange(ui.prefHudScale, 'hudScale');
}

function bindToggle(el, key) {
    if (!el || el._wired) return;
    el._wired = true;
    el.addEventListener('change', () => {
        prefs[key] = el.checked;
        applyPrefs();
        savePrefs();
    });
}

function bindRange(el, key) {
    if (!el || el._wired) return;
    el._wired = true;
    el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        if (isFinite(v)) prefs[key] = v;
        applyPrefs();
        savePrefs();
    });
}

function onA11yKeydown(e) {
    if (e.key === 'Escape') closeA11yPanel();
}

function openA11yPanel() {
    if (!ui.a11yPanel) return;
    a11yPrevFocus = document.activeElement;
    ui.a11yPanel.classList.add('visible');
    document.addEventListener('keydown', onA11yKeydown, true);
    ui.a11yPanel.focus();
}

function closeA11yPanel() {
    if (!ui.a11yPanel) return;
    ui.a11yPanel.classList.remove('visible');
    document.removeEventListener('keydown', onA11yKeydown, true);
    if (a11yPrevFocus && typeof a11yPrevFocus.focus === 'function') a11yPrevFocus.focus();
    a11yPrevFocus = null;
}

/* ------------------------------------------------------------
   item 395: shareable ?seed=N link. CONFIG.WORLD_SEED is the exact
   number rollWorldSeed() either rolled fresh or pinned from an
   incoming ?seed=N (config.js) — round-tripping it back into a URL
   reproduces this precise world (terrain/flora/clouds/river/weather
   personality/etc. all key off this one number), so a player can
   show off or compare a particularly nice-looking layout.
   ------------------------------------------------------------ */
function shareSeedUrl() {
    try {
        const url = new URL(window.location.href);
        url.searchParams.set('seed', String(CONFIG.WORLD_SEED));
        return url.toString();
    } catch (e) { return ''; }
}

function initShareSeed() {
    if (ui.shareSeedInput) ui.shareSeedInput.value = shareSeedUrl();
    if (ui.shareSeedBtn && !ui.shareSeedBtn._wired) {
        ui.shareSeedBtn._wired = true;
        ui.shareSeedBtn.addEventListener('click', async () => {
            const url = ui.shareSeedInput ? ui.shareSeedInput.value : shareSeedUrl();
            let copied = false;
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(url);
                    copied = true;
                }
            } catch (e) { /* clipboard permission denied / insecure context — fall through */ }
            if (!copied && ui.shareSeedInput) {
                try {
                    ui.shareSeedInput.select();
                    ui.shareSeedInput.setSelectionRange(0, url.length);
                    copied = document.execCommand('copy');
                } catch (e) { /* no fallback available either */ }
            }
            showHintToast(copied ? 'World link copied!' : url, '#5ff0d0', 2600);
        });
    }
}

/* ------------------------------------------------------------
   item 399: seed-preview thumbnail FOUNDATION — captures the current
   frame's already-rendered canvas at a small, fixed max dimension as
   a PNG data URL. No extra render pass (just a downscaled 2D-canvas
   copy of what the renderer already drew), so it costs nothing until
   called. Exposed on the public API (window.__captcha.getSeedThumbnail)
   for a future seed-picker/gallery feature to build on — that
   gallery/storage layer (picking WHEN to capture, where to store
   {seed, dataUrl} pairs) is explicitly out of scope for this pass;
   this is the minimal capture primitive it would sit on top of.
   ------------------------------------------------------------ */
export function captureSeedThumbnail(maxDim = CONFIG.SEED_THUMBNAIL_MAX_DIM) {
    const src = state.renderer && state.renderer.domElement;
    if (!src || !src.width || !src.height) return null;
    const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    try {
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.drawImage(src, 0, 0, w, h);
        return cv.toDataURL('image/png');
    } catch (e) { return null; } // tainted-canvas edge case
}

/* ------------------------------------------------------------
   HUD ticker — a self-driven rAF loop (started once from cacheUI(),
   self-terminating on state.disposed) that keeps a few HUD widgets in
   sync with world state ui.js has no other per-frame hook into. Every
   read below is a PUBLIC accessor (zoneAt/weatherState) or a plain
   `state.*`/creature-record field other modules already write for their
   own purposes — nothing here edits or requires edits to those modules.
   ------------------------------------------------------------ */
let hudTickerRunning = false;
let hudFrameCount = 0;
let lastZoneId = null;
let lastWeatherCur = null;
let lastQualityLevel = null;
let activeBreakoutUntil = 0;
let activeBreakoutLabel = '';

const WEATHER_GLYPHS = {
    clear: { icon: '☀️', label: 'Clear' },
    overcast: { icon: '☁️', label: 'Overcast' },
    rain: { icon: '🌧️', label: 'Rain' },
    thunderstorm: { icon: '⛈️', label: 'Storm' },
    fog: { icon: '🌫️', label: 'Fog' },
    snowfall: { icon: '❄️', label: 'Snow' },
    windy: { icon: '💨', label: 'Windy' },
};

function startHudTicker() {
    if (hudTickerRunning) return;
    hudTickerRunning = true;
    requestAnimationFrame(hudTick);
}

function hudTick() {
    if (state.disposed) { hudTickerRunning = false; return; } // self-stop across a destroy()/init() cycle
    hudFrameCount++;
    updateCompass();
    if (hudFrameCount % 15 === 0) updateWeatherBadge(); // slow-changing — no need at 60fps
    updateLegendaryRadar();
    updateCooldownWipe();
    checkQualityDrop();
    checkBreakouts();
    requestAnimationFrame(hudTick);
}

// item 403: needle tracks camera yaw; ring tints to the zone under the
// player's feet (zoneAt is the same public resolver zones.js exposes to
// terrain/flora/spawn — reading it here doesn't touch that module).
function updateCompass() {
    if (!state.camera) return;
    if (ui.compassNeedle) {
        _euler.setFromQuaternion(state.camera.quaternion);
        const deg = _euler.y * (180 / Math.PI);
        ui.compassNeedle.style.transform = `rotate(${(-deg).toFixed(1)}deg)`;
    }
    if (ui.compass) {
        const pos = state.camera.position;
        const zone = zoneAt(pos.x, pos.z);
        if (zone && zone.id !== lastZoneId) {
            lastZoneId = zone.id;
            const hex = '#' + (zone.surf1 >>> 0).toString(16).padStart(6, '0');
            ui.compass.style.setProperty('--zone-color', hex);
        }
    }
}

// item 408: weatherState() is the same ?probe-hook accessor game.js already
// exposes — cur/next are WEATHER_STATES keys (clear/overcast/rain/...).
function updateWeatherBadge() {
    if (!ui.weatherLabel || !ui.weatherIcon) return;
    let w;
    try { w = weatherState(); } catch (e) { return; }
    if (!w || w.cur === lastWeatherCur) return;
    lastWeatherCur = w.cur;
    const info = WEATHER_GLYPHS[w.cur] || WEATHER_GLYPHS.clear;
    ui.weatherIcon.textContent = info.icon;
    ui.weatherLabel.textContent = info.label;
}

// item 416: nearest alive legendary within CONFIG.LEGENDARY_RADAR_RANGE,
// shown only while it's outside the camera's own horizontal FOV (already
// visible on-screen otherwise, where the crosshair/ring take over).
function updateLegendaryRadar() {
    if (!ui.legendaryRadar) return;
    const active = state.camera && state.controls && state.controls.isLocked && !state.isPaused && !state.isCaptchaSolved;
    if (!active) { ui.legendaryRadar.style.opacity = '0'; return; }

    const camPos = state.camera.position;
    let best = null, bestD = Infinity;
    for (const c of state.creatures) {
        if (!c.alive || !c.def || c.def.tier !== 'legendary') continue;
        const dx = c.pos.x - camPos.x, dz = c.pos.z - camPos.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d <= CONFIG.LEGENDARY_RADAR_RANGE && d < bestD) { bestD = d; best = { dx, dz, d }; }
    }
    if (!best) { ui.legendaryRadar.style.opacity = '0'; return; }

    _euler.setFromQuaternion(state.camera.quaternion);
    const yaw = _euler.y;
    // signed bearing relative to camera forward: + = to the right, - = left
    const rightDot = Math.cos(yaw) * best.dx - Math.sin(yaw) * best.dz;
    const fwdDot = -Math.sin(yaw) * best.dx - Math.cos(yaw) * best.dz;
    const rel = Math.atan2(rightDot, fwdDot);

    const vFov = THREE.MathUtils.degToRad(state.camera.fov || 60);
    const aspect = state.camera.aspect || (window.innerWidth / Math.max(1, window.innerHeight));
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    if (Math.abs(rel) < hFov / 2 * 0.92) { ui.legendaryRadar.style.opacity = '0'; return; } // already in view

    // Approximate edge placement by swinging the arrow around a circle
    // centered on the viewport, clamped inside it — simpler than true
    // screen-edge ray intersection and plenty legible for an ambient hint.
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const R = Math.min(window.innerWidth, window.innerHeight) * 0.42;
    const pad = 30;
    const sx = Math.max(pad, Math.min(window.innerWidth - pad, cx + Math.sin(rel) * R));
    const sy = Math.max(pad, Math.min(window.innerHeight - pad, cy - Math.cos(rel) * R));
    ui.legendaryRadar.style.left = sx + 'px';
    ui.legendaryRadar.style.top = sy + 'px';
    ui.legendaryRadar.style.transform = `translate(-50%, -50%) rotate(${rel.toFixed(3)}rad)`;
    ui.legendaryRadar.style.opacity = String((0.4 + 0.45 * (1 - best.d / CONFIG.LEGENDARY_RADAR_RANGE)).toFixed(2));
}

// item 414: state.viewmodel.phase/t already carry the throw state machine
// (viewmodel.js); 'gone' IS the VM_COOLDOWN window (see viewmodel.js).
function updateCooldownWipe() {
    if (!ui.cooldownWipe) return;
    const vm = state.viewmodel;
    const active = vm && vm.phase === 'gone' && state.controls && state.controls.isLocked && !state.isPaused;
    if (!active) { ui.cooldownWipe.style.opacity = '0'; return; }
    const k = Math.min(1, vm.t / CONFIG.VM_COOLDOWN);
    ui.cooldownWipe.style.setProperty('--wipe', k.toFixed(3));
    ui.cooldownWipe.style.opacity = '1';
}

// item 411: an unobtrusive toast the moment state.qualityLevel actually
// STEPS DOWN (quality.js already owns that decision — this only observes
// the result), so a visual change never reads as a silent/unexplained pop.
const QUALITY_ORDER = { high: 2, medium: 1, low: 0 };
function checkQualityDrop() {
    const q = state.qualityLevel;
    if (!q) return;
    if (lastQualityLevel === null) { lastQualityLevel = q; return; } // don't fire on the very first read
    if (q !== lastQualityLevel) {
        const was = QUALITY_ORDER[lastQualityLevel] ?? 1;
        const now = QUALITY_ORDER[q] ?? 1;
        if (now < was) {
            showHintToast(`Graphics eased to ${q} for smoother play`, '#ffb84d', 3200);
        }
        lastQualityLevel = q;
    }
}

// items 412/427: a creature's capture.js-set c.breakoutUntil is the exact
// "escape window" signal — detect it going from unseen to active and show
// a plain-language, sound-independent countdown for its duration.
function checkBreakouts() {
    const nowS = performance.now() / 1000;
    for (const c of state.creatures) {
        if (c.breakoutUntil && c.breakoutUntil !== c._uiSeenBreakout) {
            c._uiSeenBreakout = c.breakoutUntil;
            if (c.breakoutUntil > nowS && c.def) {
                activeBreakoutUntil = c.breakoutUntil;
                activeBreakoutLabel = `${c.def.name} broke free — extra spooked for `;
                showHintToast(activeBreakoutLabel + CONFIG.BREAKOUT_PANIC_TIME.toFixed(1) + 's', '#ff9a4d', CONFIG.BREAKOUT_PANIC_TIME * 1000);
            }
        }
    }
    if (!activeBreakoutUntil) return;
    if (nowS >= activeBreakoutUntil) {
        activeBreakoutUntil = 0;
    } else if (state.hintToastEl) {
        state.hintToastEl.textContent = activeBreakoutLabel + Math.max(0, activeBreakoutUntil - nowS).toFixed(1) + 's';
    }
}
