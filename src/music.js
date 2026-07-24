/* ============================================================
   Music — per-zone generative ambient loops
   ------------------------------------------------------------
   Twelve synthesized moods, one per zone, all Web Audio (no
   assets). Each mood is a small data recipe:
     pad    — detuned oscillator chord breathing under a slow LFO
     events — sparse melodic voices (bells / plucks / booms /
              chirps) rolled from the mood's scale at a seeded-
              feeling random cadence
     noise  — optional filtered wind/water bed
   The active mood plays into one of two crossfade slots; when
   the player wanders into a new zone (polled ~1s) the next mood
   fades in over ~2s while the old one fades out and is torn down.

   Gesture-gated: nothing sounds until the first pointer lock
   (musicSetActive(true) from onLock). Pause/unlock suspends it;
   solving the captcha stops it for good. Master volume is kept
   LOW — this is a captcha, not a concert.
   ============================================================ */

import { state } from './state.js';
import { zoneAt } from './zones/zones.js';
import { caveAt } from './heightfield.js';

const MASTER_GAIN = 0.16;
const XFADE = 2.0;          // seconds
const POLL_MS = 1000;

/* ------------------------------------------------------------
   Mood recipes. Frequencies in Hz; event rate = [min,max] secs
   between notes; each event rolls a random note from its scale.
   ------------------------------------------------------------ */
const MOODS = {
    meadow: {
        pad: { freqs: [130.8, 196.0, 261.6], type: 'sine', gain: 0.30, lfo: 0.07 },
        events: [
            { scale: [261.6, 293.7, 329.6, 392.0, 440.0, 523.3], type: 'triangle', rate: [2.2, 5.0], dur: 1.6, gain: 0.35 },
        ],
    },
    volcanic: {
        pad: { freqs: [55.0, 82.4, 110.0], type: 'sawtooth', gain: 0.16, lfo: 0.05, lp: 320 },
        events: [
            { scale: [110.0, 130.8, 155.6, 164.8], type: 'sine', rate: [3.0, 7.0], dur: 2.2, gain: 0.5, slideTo: 0.5 },
            { scale: [46.2, 55.0], type: 'sine', rate: [4.5, 9.0], dur: 0.9, gain: 0.7 }, // deep pulses
        ],
        noise: { freq: 180, q: 0.7, gain: 0.10 },
    },
    ice: {
        pad: { freqs: [220.0, 329.6, 440.0], type: 'sine', gain: 0.22, lfo: 0.05 },
        events: [
            { scale: [987.8, 1174.7, 1318.5, 1568.0, 1975.5], type: 'sine', rate: [2.6, 6.5], dur: 3.2, gain: 0.30 },
        ],
        noise: { freq: 1200, q: 0.5, gain: 0.045 },
    },
    snow: {
        pad: { freqs: [138.6, 207.7, 277.2], type: 'sine', gain: 0.26, lfo: 0.04 },
        events: [
            { scale: [554.4, 622.3, 693.0, 831.6, 924.6], type: 'sine', rate: [3.0, 7.0], dur: 2.6, gain: 0.26 },
        ],
        noise: { freq: 700, q: 0.4, gain: 0.05 },
    },
    jungle: {
        pad: { freqs: [98.0, 146.8, 196.0], type: 'triangle', gain: 0.22, lfo: 0.09 },
        events: [
            { scale: [392.0, 440.0, 523.3, 587.3, 698.5], type: 'triangle', rate: [1.2, 3.2], dur: 0.5, gain: 0.35 },
            { scale: [1760.0, 2093.0, 2637.0], type: 'sine', rate: [4.0, 9.0], dur: 0.22, gain: 0.20, slideTo: 1.25 }, // bird chips
        ],
    },
    autumn: {
        pad: { freqs: [146.8, 220.0, 293.7], type: 'sine', gain: 0.28, lfo: 0.06 },
        events: [
            { scale: [293.7, 349.2, 392.0, 440.0, 523.3], type: 'sawtooth', rate: [2.4, 5.5], dur: 1.2, gain: 0.20, lp: 1400 },
        ],
    },
    swamp: {
        pad: { freqs: [73.4, 110.0, 146.8], type: 'sine', gain: 0.26, lfo: 0.05, wobble: 0.9 },
        events: [
            { scale: [220.0, 246.9, 293.7], type: 'sine', rate: [3.0, 7.5], dur: 1.4, gain: 0.30, slideTo: 0.6 }, // bloops
        ],
        noise: { freq: 300, q: 0.6, gain: 0.07 },
    },
    desert: {
        pad: { freqs: [146.8, 220.0], type: 'sine', gain: 0.26, lfo: 0.04 },
        events: [
            { scale: [440.0, 466.2, 523.3, 587.3], type: 'triangle', rate: [3.2, 7.5], dur: 1.8, gain: 0.24, slideTo: 0.94 },
        ],
        noise: { freq: 900, q: 0.35, gain: 0.04 },
    },
    rocky: {
        pad: { freqs: [98.0, 130.8, 196.0], type: 'sine', gain: 0.26, lfo: 0.05 },
        events: [
            { scale: [196.0, 261.6, 293.7, 392.0], type: 'sine', rate: [3.6, 8.0], dur: 3.0, gain: 0.30 },
        ],
        noise: { freq: 480, q: 0.4, gain: 0.055 },
    },
    mushroom: {
        pad: { freqs: [110.0, 174.6, 220.0], type: 'triangle', gain: 0.24, lfo: 0.10, wobble: 0.5 },
        events: [
            { scale: [349.2, 392.0, 440.0, 493.9, 554.4, 622.3], type: 'sine', rate: [1.6, 4.0], dur: 1.1, gain: 0.30 },
        ],
    },
    lakeside: {
        pad: { freqs: [130.8, 196.0, 246.9], type: 'sine', gain: 0.28, lfo: 0.06 },
        events: [
            { scale: [523.3, 587.3, 659.3, 740.0, 784.0], type: 'sine', rate: [2.2, 5.5], dur: 2.0, gain: 0.28 },
        ],
        noise: { freq: 850, q: 0.3, gain: 0.035 },
    },
    alpine: {
        pad: { freqs: [130.8, 196.0, 293.7], type: 'sine', gain: 0.28, lfo: 0.045 },
        events: [
            { scale: [261.6, 329.6, 392.0, 523.3], type: 'triangle', rate: [3.4, 7.5], dur: 2.8, gain: 0.26, attack: 0.9 },
        ],
        noise: { freq: 600, q: 0.4, gain: 0.05 },
    },
    // Cave: an OVERRIDE mood (not a zone). When the player is inside a cave the
    // poll swaps to this instead of the zone mood — same two-slot crossfader, so
    // walking in/out fades between the two. Low cavern drone + echoing water
    // drips + a low airy rumble bed.
    cave: {
        pad: { freqs: [65.4, 98.0, 130.8], type: 'sine', gain: 0.26, lfo: 0.035, wobble: 0.3 },
        events: [
            { scale: [1046.5, 1244.5, 1568.0, 1864.7], type: 'sine', rate: [1.6, 4.2], dur: 0.5, gain: 0.16, slideTo: 0.5 }, // drips
            { scale: [523.3, 659.3, 784.0], type: 'sine', rate: [5.0, 9.0], dur: 2.6, gain: 0.13, attack: 0.9 }, // distant echo tone
        ],
        noise: { freq: 240, q: 0.6, gain: 0.055 },
    },
};

/* ------------------------------------------------------------
   Internal state
   ------------------------------------------------------------ */
const M = {
    master: null,       // master gain -> destination
    slotA: null,        // crossfade slot gains
    slotB: null,
    ensembleA: null,    // live voice ensembles per slot
    ensembleB: null,
    activeSlot: 'A',
    currentMood: null,
    pollTimer: null,
    active: false,      // gesture-gated + not paused/solved
    stopped: false,     // solve/destroy: permanent
};

function ensureGraph() {
    if (!state.audio || M.master) return !!M.master;
    try {
        const ctx = state.audio;
        M.master = ctx.createGain();
        M.master.gain.value = MASTER_GAIN;
        M.master.connect(ctx.destination);
        M.slotA = ctx.createGain(); M.slotA.gain.value = 0; M.slotA.connect(M.master);
        M.slotB = ctx.createGain(); M.slotB.gain.value = 0; M.slotB.connect(M.master);
        return true;
    } catch (e) { return false; }
}

// Looping noise buffer (soft filtered wind/water bed)
function makeNoiseSource(ctx, spec) {
    const len = Math.floor(ctx.sampleRate * 1.6);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const xf = Math.floor(ctx.sampleRate * 0.1);
    for (let i = 0; i < xf; i++) {
        const k = i / xf;
        data[len - xf + i] = data[len - xf + i] * (1 - k) + data[i] * k;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = spec.freq; bp.Q.value = spec.q;
    const g = ctx.createGain(); g.gain.value = spec.gain;
    src.connect(bp).connect(g);
    return { src, out: g };
}

/* ------------------------------------------------------------
   Voice ensemble — everything one mood keeps alive.
   ------------------------------------------------------------ */
function startEnsemble(moodId, slotGain) {
    const ctx = state.audio;
    const mood = MOODS[moodId] || MOODS.meadow;
    const nodes = [];   // stoppable sources
    const timers = [];
    const t0 = ctx.currentTime;

    // --- pad chord ---
    const padOut = ctx.createGain();
    padOut.gain.value = mood.pad.gain;
    let padDest = padOut;
    if (mood.pad.lp) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = mood.pad.lp;
        lp.connect(padOut);
        padDest = lp;
    }
    padOut.connect(slotGain);
    for (const f of mood.pad.freqs) {
        for (const det of [1, 1.004]) {
            const osc = ctx.createOscillator();
            osc.type = mood.pad.type;
            osc.frequency.value = f * det;
            if (mood.pad.wobble) { // slow pitch wobble (swamp/mushroom character)
                const lfo = ctx.createOscillator();
                lfo.frequency.value = 0.1 + Math.random() * 0.1;
                const lg = ctx.createGain(); lg.gain.value = f * 0.004 * mood.pad.wobble;
                lfo.connect(lg).connect(osc.frequency);
                lfo.start(t0); nodes.push(lfo);
            }
            const og = ctx.createGain();
            og.gain.value = 0.5 / mood.pad.freqs.length;
            osc.connect(og).connect(padDest);
            osc.start(t0);
            nodes.push(osc);
        }
    }
    // pad breathing LFO
    const breath = ctx.createOscillator();
    breath.frequency.value = mood.pad.lfo;
    const bg = ctx.createGain(); bg.gain.value = mood.pad.gain * 0.35;
    breath.connect(bg).connect(padOut.gain);
    breath.start(t0);
    nodes.push(breath);

    // --- noise bed ---
    if (mood.noise) {
        const n = makeNoiseSource(ctx, mood.noise);
        n.out.connect(slotGain);
        n.src.start(t0);
        nodes.push(n.src);
    }

    // --- sparse melodic events ---
    let dead = false;
    for (const ev of mood.events) {
        const schedule = () => {
            if (dead) return;
            const wait = (ev.rate[0] + Math.random() * (ev.rate[1] - ev.rate[0])) * 1000;
            const id = setTimeout(() => { playEvent(ev); schedule(); }, wait);
            timers.push(id);
        };
        const playEvent = (spec) => {
            if (dead || M.stopped || !M.active) return;
            try {
                const t = ctx.currentTime;
                const f = spec.scale[Math.floor(Math.random() * spec.scale.length)];
                const osc = ctx.createOscillator();
                osc.type = spec.type;
                osc.frequency.setValueAtTime(f, t);
                if (spec.slideTo) osc.frequency.exponentialRampToValueAtTime(f * spec.slideTo, t + spec.dur * 0.8);
                let dest = slotGain;
                if (spec.lp) {
                    const lp = ctx.createBiquadFilter();
                    lp.type = 'lowpass'; lp.frequency.value = spec.lp;
                    lp.connect(slotGain); dest = lp;
                }
                const g = ctx.createGain();
                const atk = spec.attack || 0.02;
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(spec.gain, t + atk);
                g.gain.exponentialRampToValueAtTime(0.001, t + spec.dur);
                osc.connect(g).connect(dest);
                osc.start(t);
                osc.stop(t + spec.dur + 0.1);
            } catch (e) {}
        };
        schedule();
    }

    return {
        stop(fade) {
            dead = true;
            for (const id of timers) clearTimeout(id);
            const stopAt = ctx.currentTime + fade + 0.3;
            for (const n of nodes) { try { n.stop(stopAt); } catch (e) {} }
        },
    };
}

/* ------------------------------------------------------------
   Crossfade to a mood (or start it cold on the free slot).
   ------------------------------------------------------------ */
function crossfadeTo(moodId) {
    if (!ensureGraph()) return;
    const ctx = state.audio;
    const t = ctx.currentTime;
    const toA = M.activeSlot !== 'A';
    const inSlot = toA ? M.slotA : M.slotB;
    const outSlot = toA ? M.slotB : M.slotA;
    const outEns = toA ? M.ensembleB : M.ensembleA;

    const ens = startEnsemble(moodId, inSlot);
    if (toA) M.ensembleA = ens; else M.ensembleB = ens;

    inSlot.gain.cancelScheduledValues(t);
    inSlot.gain.setValueAtTime(inSlot.gain.value, t);
    inSlot.gain.linearRampToValueAtTime(1, t + XFADE);
    outSlot.gain.cancelScheduledValues(t);
    outSlot.gain.setValueAtTime(outSlot.gain.value, t);
    outSlot.gain.linearRampToValueAtTime(0, t + XFADE);
    if (outEns) outEns.stop(XFADE);
    if (toA) M.ensembleB = null; else M.ensembleA = null;

    M.activeSlot = toA ? 'A' : 'B';
    M.currentMood = moodId;
}

function killEnsembles(fade) {
    if (M.ensembleA) { M.ensembleA.stop(fade); M.ensembleA = null; }
    if (M.ensembleB) { M.ensembleB.stop(fade); M.ensembleB = null; }
    if (state.audio && M.slotA) {
        const t = state.audio.currentTime;
        for (const s of [M.slotA, M.slotB]) {
            try {
                s.gain.cancelScheduledValues(t);
                s.gain.setValueAtTime(s.gain.value, t);
                s.gain.linearRampToValueAtTime(0, t + fade);
            } catch (e) {}
        }
    }
    M.currentMood = null;
}

/* ------------------------------------------------------------
   Which mood belongs at the player's position? A cave interior
   overrides the underlying zone's mood (same crossfader).
   ------------------------------------------------------------ */
function moodAtPlayer() {
    const p = state.camera.position;
    return caveAt(p.x, p.z) ? 'cave' : zoneAt(p.x, p.z).music;
}

/* ------------------------------------------------------------
   Poll: which zone/cave is the player standing in?
   ------------------------------------------------------------ */
function poll() {
    if (M.stopped || !M.active || !state.camera) return;
    if (!state.controls || !state.controls.isLocked || state.isPaused || state.isCaptchaSolved) return;
    try {
        const moodId = moodAtPlayer();
        if (moodId !== M.currentMood) crossfadeTo(moodId);
    } catch (e) {}
}

/* ------------------------------------------------------------
   Public API
   ------------------------------------------------------------ */
// Called once from init; harmless without audio.
export function initMusic() {
    M.stopped = false;
    M.active = false;
    if (M.pollTimer) clearInterval(M.pollTimer);
    M.pollTimer = setInterval(poll, POLL_MS);
}

// Gesture gate + pause handling: (true) after pointer lock,
// (false) on unlock/pause. Fades rather than cutting.
export function musicSetActive(on) {
    if (M.stopped) return;
    M.active = !!on;
    if (on) {
        if (!ensureGraph()) return;
        try { if (state.audio.state === 'suspended') state.audio.resume(); } catch (e) {}
        poll(); // start the current zone/cave mood immediately
        if (!M.currentMood && state.camera) {
            try { crossfadeTo(moodAtPlayer()); } catch (e) {}
        }
    } else {
        killEnsembles(0.6);
    }
}

// Solve: stop for good (success chime should own the stage).
export function stopMusic() {
    M.stopped = true;
    M.active = false;
    killEnsembles(1.2);
}

// Test-rig introspection (read-only; used by the ?probe hook only)
export function musicCurrentMood() { return M.currentMood; }

// Teardown (game destroy)
export function disposeMusic() {
    stopMusic();
    if (M.pollTimer) { clearInterval(M.pollTimer); M.pollTimer = null; }
    if (M.master) {
        try { M.master.disconnect(); } catch (e) {}
        M.master = null; M.slotA = null; M.slotB = null;
    }
}
