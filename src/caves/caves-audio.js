/* ============================================================
   Cave AUDIO (Phase 2l, items 86–91)
   ------------------------------------------------------------
   All of this is CAVE audio — it must stay OUT of the surface
   soundscape. Everything is gated two ways:
     1. gesture + pause: caveAudioSetActive(true) fires from the
        first pointer lock (onLock) like the music; unlock/pause
        ducks it; solving stops it for good; destroy disposes it.
     2. in-cave state: gains are driven by state.caveFx.inside /
        .depth (set by caves-atmos.js every frame) + proximity to
        real cave water/drip points — so out in the open every
        cave voice sits at gain 0 (bypassed), and the render is
        byte-identical to before this phase.

   Items:
     86 REVERB — a convolver (synthesized cave impulse) fed by the
        shared SFX bus (audio.js) + the cave beds; the wet return
        is opened by caveFx.inside so cave SFX (and the capture
        pops) get an echo tail inside, none outdoors.
     87 DRIPS — a small POOL of positional drip voices placed at
        the real drip points (state.caveDripData — the ones that
        spawn ripples over pools), panned + attenuated by distance
        from the player, only a few firing at a time.
     88 RUMBLE — a very-low drone + faint air-movement noise bed
        whose gain deepens with cave depth (fades in going deeper,
        out on leaving).
     89 FOOTSTEPS — surface-varied (rock / rubble / wet) footfalls
        triggered by grounded movement inside caves; cadence rides
        the walk speed; silent standing still or airborne.
     90 BAT SCATTER — the wing-flutter+squeak (audio.js playBatScatter)
        already fires from the colony scatter event; it now routes
        through the SFX bus, so it picks up the in-cave reverb.
     91 TRICKLE — a gentle wet babble bed that rises near cave water
        and fades with distance.

   Master gains are kept LOW (the music master is ~0.16). Voices
   are pooled/capped — no unbounded oscillator spawning.
   ============================================================ */

import * as THREE from 'three';
import { state } from '../state.js';
import { CAVES, caveAt, isWaterAt, caveSlippery } from '../heightfield.js';

/* ---- tuning (all deliberately quiet) ---- */
const CAVE_MASTER = 0.85;   // dry cave-bed bus level
const REVERB_MAX = 0.40;    // wet reverb return when fully inside
const REVERB_SECONDS = 1.9; // synthesized cave impulse length
const RUMBLE_MAX = 0.09;    // low drone + air bed peak
const TRICKLE_MAX = 0.06;   // wet babble peak near water
const DRIP_GAIN = 0.075;    // per drip plink (pre distance attenuation)
const FOOT_GAIN = 0.085;    // per footfall
const DRIP_RADIUS = 15;     // drips beyond this are inaudible
const TRICKLE_NEAR = 2.6;   // full trickle within this of cave water
const TRICKLE_FAR = 12;     // trickle silent beyond this
const STRIDE_LEN = 1.7;     // world units per footfall (tempo ~ walk speed)
const FOOT_MIN_SPEED = 0.7; // below this the player is "standing still"

/* Per-tier drip voice cap (item 100 spirit — cheaper on low, richer on high). */
function dripVoiceCap() {
    return state.qualityLevel === 'low' ? 2 : state.qualityLevel === 'medium' ? 3 : 4;
}

const A = {
    built: false,
    stopped: false,
    active: false,       // gesture-gated + not paused/solved
    gate: 0,             // smoothed 0..1 master gate
    master: null,        // caveMaster gain -> destination (+ reverb send)
    reverbInput: null,   // send bus -> convolver
    convolver: null,
    reverbWet: null,     // wet return gain (driven by caveFx.inside)
    rumbleGain: null,
    trickleGain: null,
    rumbleNodes: [],     // stoppable sources for teardown
    dripSlots: [],       // [{ timer }] — bounded emitter slots
    strideAcc: 0,        // footstep distance accumulator
    lastFootFoot: 0,     // alternate L/R
};

const _fwd = new THREE.Vector3();

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/* ------------------------------------------------------------
   Synthesized cave impulse response — exponentially decaying
   noise (stereo), a touch of pre-delay sparseness so it reads as
   a rock chamber rather than a plate.
   ------------------------------------------------------------ */
function makeCaveIR(ctx) {
    const len = Math.floor(ctx.sampleRate * REVERB_SECONDS);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) {
            const t = i / len;
            // decaying noise; slight early sparseness (fewer taps up front)
            const env = Math.pow(1 - t, 2.6);
            const tap = (Math.random() * 2 - 1);
            d[i] = tap * env * (i < ctx.sampleRate * 0.02 ? 0.35 : 1);
        }
    }
    return ir;
}

/* Looping filtered-noise source (air bed / trickle babble). */
function makeNoiseLoop(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    // seamless loop: crossfade the tail into the head
    const xf = Math.floor(ctx.sampleRate * 0.1);
    for (let i = 0; i < xf; i++) { const k = i / xf; data[len - xf + i] = data[len - xf + i] * (1 - k) + data[i] * k; }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    return src;
}

/* ------------------------------------------------------------
   Build the persistent cave-audio graph (lazy: only the first
   time the layer goes active AFTER a pointer lock — so nothing
   sounds, and nothing is even created, before the gesture).
   ------------------------------------------------------------ */
function build() {
    if (A.built || !state.audio) return;
    const ctx = state.audio;
    try {
        const t0 = ctx.currentTime;

        // ---- dry cave-bed bus + reverb send/return (item 86) ----
        A.master = ctx.createGain();
        A.master.gain.value = CAVE_MASTER;
        A.master.connect(ctx.destination);

        A.reverbInput = ctx.createGain();
        A.reverbInput.gain.value = 1;
        A.convolver = ctx.createConvolver();
        A.convolver.buffer = makeCaveIR(ctx);
        A.reverbWet = ctx.createGain();
        A.reverbWet.gain.value = 0;                 // opened by caveFx.inside
        A.reverbInput.connect(A.convolver).connect(A.reverbWet).connect(ctx.destination);
        // the cave beds AND the shared one-shot SFX bus both send to the reverb
        A.master.connect(A.reverbInput);
        if (state.sfxBus) state.sfxBus.connect(A.reverbInput);

        // ---- rumble / air-movement bed (item 88) ----
        // chain: sines+air -> lowpass -> breath (base 1.0, LFO ±0.3, always
        // positive) -> rumbleGain (MY driven level, 0..RUMBLE_MAX) -> master.
        // Keeping the breathing on a separate node means my per-frame
        // setTargetAtTime never fights the LFO and the output gain is never
        // driven negative.
        A.rumbleGain = ctx.createGain();
        A.rumbleGain.gain.value = 0;
        A.rumbleGain.connect(A.master);
        const breath = ctx.createGain();
        breath.gain.value = 1.0;
        breath.connect(A.rumbleGain);
        const rlp = ctx.createBiquadFilter();
        rlp.type = 'lowpass'; rlp.frequency.value = 120;
        rlp.connect(breath);
        for (const f of [31.5, 41.8]) {             // two detuned sub sines
            const osc = ctx.createOscillator();
            osc.type = 'sine'; osc.frequency.value = f;
            const g = ctx.createGain(); g.gain.value = 0.5;
            osc.connect(g).connect(rlp);
            osc.start(t0); A.rumbleNodes.push(osc);
        }
        // faint moving-air layer (very low bandpassed noise) under the sines
        const air = makeNoiseLoop(ctx, 2.2);
        const abp = ctx.createBiquadFilter();
        abp.type = 'bandpass'; abp.frequency.value = 90; abp.Q.value = 0.6;
        const ag = ctx.createGain(); ag.gain.value = 0.5;
        air.connect(abp).connect(ag).connect(rlp);
        air.start(t0); A.rumbleNodes.push(air);
        // slow breathing so the bed "moves" — stays in [0.7, 1.3], never negative
        const rl = ctx.createOscillator(); rl.frequency.value = 0.06;
        const rlg = ctx.createGain(); rlg.gain.value = 0.3;
        rl.connect(rlg).connect(breath.gain);
        rl.start(t0); A.rumbleNodes.push(rl);

        // ---- wet-pool trickle bed (item 91) ----
        A.trickleGain = ctx.createGain();
        A.trickleGain.gain.value = 0;
        A.trickleGain.connect(A.master);
        const trickle = makeNoiseLoop(ctx, 2.4);
        const tbp = ctx.createBiquadFilter();
        tbp.type = 'bandpass'; tbp.frequency.value = 850; tbp.Q.value = 0.5;
        const tlp = ctx.createBiquadFilter();
        tlp.type = 'lowpass'; tlp.frequency.value = 1600;
        trickle.connect(tbp).connect(tlp).connect(A.trickleGain);
        trickle.start(t0); A.rumbleNodes.push(trickle);

        // ---- drip emitter slots (item 87) — bounded pool ----
        A.dripSlots = [];
        for (let i = 0; i < 4; i++) A.dripSlots.push({ timer: 0.4 + Math.random() * 1.6 });

        A.built = true;
        publishStats();
    } catch (e) {
        // leave A.built false; the layer simply stays silent
    }
}

/* ------------------------------------------------------------
   A single soft drip "plink" at a world point, panned + gained
   by the player's distance/facing. Transient nodes (GC'd after
   stop) but only ever a few concurrently (slot-capped).
   ------------------------------------------------------------ */
function playDrip(x, y, z, gain, pan) {
    const ctx = state.audio;
    if (!ctx || !A.master) return;
    try {
        const t0 = ctx.currentTime;
        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        const out = ctx.createGain();
        out.gain.value = 1;
        if (panner) { panner.pan.value = pan; out.connect(panner).connect(A.master); }
        else out.connect(A.master);
        // a quick high sine ping (the drop) + a tiny lowpassed tick (the plip)
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        const f = 900 + Math.random() * 700;
        osc.frequency.setValueAtTime(f, t0);
        osc.frequency.exponentialRampToValueAtTime(f * 0.55, t0 + 0.12);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0004, t0 + 0.22);
        osc.connect(g).connect(out);
        osc.start(t0); osc.stop(t0 + 0.26);
    } catch (e) {}
}

/* ------------------------------------------------------------
   Item 79 — a splash cue fired DIRECTLY on the exact frame a real
   ceiling drip lands on a pool (caves.js's updateCaves already spawns
   the visual ripple ring at that moment; this is its audio partner),
   genuinely audio-visual SYNCED — unlike the ambient item-87 drip
   cadence above, which is a slot-based approximation, not tied to any
   single visible drop.
   ------------------------------------------------------------ */
export function dripLandingSplash(x, y, z) {
    if (!A.built || A.gate < 0.3) return;
    const ctx = state.audio;
    if (!ctx || !A.master) return;
    const cam = state.camera && state.camera.position;
    if (!cam) return;
    const dist = Math.hypot(x - cam.x, z - cam.z);
    if (dist > DRIP_RADIUS) return;
    const fx = state.caveFx;
    const inside = fx ? Math.max(0, Math.min(1, fx.inside)) : 0;
    if (inside < 0.03) return;
    const atten = Math.pow(Math.max(0, 1 - dist / DRIP_RADIUS), 1.6);
    const gain = DRIP_GAIN * 1.3 * atten * inside * A.gate; // a touch brighter than the ambient cadence
    if (gain < 0.0006) return;
    state.camera.getWorldDirection(_fwd); _fwd.y = 0; if (_fwd.lengthSq() > 0) _fwd.normalize();
    const rx = -_fwd.z, rz = _fwd.x;
    const dirx = (x - cam.x) / (dist || 1), dirz = (z - cam.z) / (dist || 1);
    const pan = Math.max(-1, Math.min(1, dirx * rx + dirz * rz));
    playDrip(x, y, z, gain, pan);
}

/* Nearest cave-water distance (pools/stream anchors) to a point, or Infinity. */
function nearestCaveWater(x, z) {
    let best = Infinity;
    for (const c of CAVES) {
        if (!c.pools) continue;
        for (const p of c.pools) {
            if (p.kind === 'ice') continue;      // frozen slab: no trickle
            const d = Math.hypot(x - p.x, z - p.z) - p.r;
            if (d < best) best = d;
        }
    }
    return best;
}

/* Footstep surface under a point: 'wet' | 'rubble' | 'rock'. */
function footSurface(x, z) {
    if (isWaterAt(x, z) || caveSlippery(x, z)) return 'wet';
    const cave = caveAt(x, z);
    if (cave) {
        // nearest path node — talus slope / choke rubble read as loose ground
        let best = null, bd = Infinity;
        for (const path of cave.paths) for (const n of path) {
            const d = (n.x - x) ** 2 + (n.z - z) ** 2;
            if (d < bd) { bd = d; best = n; }
        }
        if (best && (best.talus || best.choke)) return 'rubble';
        const t = cave.topo;                     // fallen breakdown blocks nearby
        if (t && t.fallen) for (const f of t.fallen) { if ((f.x - x) ** 2 + (f.z - z) ** 2 < 4) return 'rubble'; }
    }
    return 'rock';
}

/* One footfall of the given surface, low gain, routed through the cave bus
   (so it gets the in-cave reverb). rock = short thud; rubble = gritty crunch;
   wet = splashy slap. */
function playFootstep(surface, foot) {
    const ctx = state.audio;
    if (!ctx || !A.master) return;
    try {
        const t0 = ctx.currentTime;
        const dur = surface === 'wet' ? 0.16 : surface === 'rubble' ? 0.13 : 0.1;
        const len = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
            const t = i / len;
            // rubble is grittier (slower decay + gravel rattle); wet is softer
            const env = surface === 'rubble' ? Math.pow(1 - t, 1.6) : Math.pow(1 - t, 2.6);
            let s = (Math.random() * 2 - 1) * env;
            if (surface === 'rubble') s += (Math.random() * 2 - 1) * Math.max(0, 0.5 - t) * 0.5;
            data[i] = s * 0.6;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = surface === 'wet' ? 900 : surface === 'rubble' ? 2400 : 520;
        const g = ctx.createGain();
        g.gain.value = FOOT_GAIN * (foot ? 1 : 0.86) * (surface === 'wet' ? 1.05 : 1);
        src.connect(lp).connect(g).connect(A.master);
        src.start(t0);
        if (surface === 'wet') { // a little splashy tick on top
            spawnFootTick(ctx, t0, 1300, 0.03);
        } else if (surface === 'rock') {
            spawnFootTick(ctx, t0, 180, 0.05); // low body knock
        }
    } catch (e) {}
}

function spawnFootTick(ctx, t0, freq, amp) {
    try {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t0);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t0 + 0.05);
        const g = ctx.createGain();
        g.gain.setValueAtTime(amp, t0);
        g.gain.exponentialRampToValueAtTime(0.0004, t0 + 0.06);
        osc.connect(g).connect(A.master);
        osc.start(t0); osc.stop(t0 + 0.07);
    } catch (e) {}
}

/* ------------------------------------------------------------
   Small readable snapshot for the ?probe rig (plain numbers, so
   verification never depends on the AudioContext clock advancing).
   ------------------------------------------------------------ */
function publishStats(extra) {
    state.caveAudio = Object.assign({
        built: A.built,
        active: A.active,
        stopped: A.stopped,
        gate: A.gate,
        reverbWet: 0, rumble: 0, trickle: 0,
        dripVoices: 0, dripCap: dripVoiceCap(),
        footstepsThisFrame: 0,
        sfxBusTapped: !!(A.reverbInput && state.sfxBus),
        // live node handles for deeper introspection
        nodes: A.built ? { master: A.master, reverbWet: A.reverbWet, rumbleGain: A.rumbleGain, trickleGain: A.trickleGain } : null,
    }, extra || {});
}

/* ------------------------------------------------------------
   Public API
   ------------------------------------------------------------ */
export function initCaveAudio() {
    A.built = false;
    A.stopped = false;
    A.active = false;
    A.gate = 0;
    A.strideAcc = 0;
    publishStats();
}

// Gesture gate + pause handling, wired next to musicSetActive in game.js:
// (true) after pointer lock, (false) on unlock/pause. Builds the graph on the
// first activation so nothing exists before the first gesture.
export function caveAudioSetActive(on) {
    if (A.stopped) return;
    A.active = !!on;
    if (on) {
        if (state.audio && state.audio.state === 'suspended') { try { state.audio.resume(); } catch (e) {} }
        build();
    }
    publishStats();
}

// Solve: stop for good (the success chime owns the stage).
export function stopCaveAudio() {
    A.stopped = true;
    A.active = false;
    A.gate = 0;
    rampAll(0);
    publishStats();
}

function rampAll(v) {
    if (!state.audio) return;
    const t = state.audio.currentTime;
    for (const gn of [A.reverbWet, A.rumbleGain, A.trickleGain]) {
        if (!gn) continue;
        try { gn.gain.cancelScheduledValues(t); gn.gain.setTargetAtTime(v, t, 0.2); } catch (e) {}
    }
}

/* ------------------------------------------------------------
   Per-frame — driven from the game loop AFTER updateCaveAtmos
   (which sets state.caveFx). Also driveable directly from the
   ?probe rig (headless rAF doesn't self-tick).
   ------------------------------------------------------------ */
export function updateCaveAudio(dt, elapsed) {
    if (!state.audio) return;
    if (!isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;

    // live gate: gesture-gated AND not paused/solved
    const locked = state.controls && state.controls.isLocked;
    const wantActive = A.active && locked && !state.isPaused && !state.isCaptchaSolved && !A.stopped;
    A.gate += ((wantActive ? 1 : 0) - A.gate) * Math.min(1, dt * 6);
    if (A.gate < 0.001) A.gate = wantActive ? A.gate : 0;

    if (!A.built) { publishStats(); return; }

    const fx = state.caveFx;
    const inside = fx ? clamp01(fx.inside) : 0;   // 0 outdoors -> 1 deep inside
    const depth = fx ? clamp01(fx.depth) : 0;
    const cam = state.camera && state.camera.position;
    const ctx = state.audio;
    const now = ctx.currentTime;

    // ---- item 86: reverb wet return opens with in-cave depth ----
    const wet = REVERB_MAX * inside * A.gate;
    setGain(A.reverbWet, wet, now);

    // ---- item 88: rumble/air deepens with cave depth ----
    const rumble = RUMBLE_MAX * (0.35 * inside + 0.65 * depth) * A.gate;
    setGain(A.rumbleGain, rumble, now);

    // ---- item 91: trickle rises near cave water ----
    let trickle = 0;
    if (cam && inside > 0.02) {
        const dw = nearestCaveWater(cam.x, cam.z);
        if (isFinite(dw)) {
            const prox = 1 - clamp01((dw - TRICKLE_NEAR) / (TRICKLE_FAR - TRICKLE_NEAR));
            trickle = TRICKLE_MAX * prox * inside * A.gate;
        }
    }
    setGain(A.trickleGain, trickle, now);

    // ---- item 87: positional drip voices at real drip points ----
    let dripFired = 0;
    const cap = dripVoiceCap();
    const canDrip = A.gate > 0.4 && inside > 0.05 && cam && state.caveDripData && !state.isPaused;
    if (cam) { state.camera.getWorldDirection(_fwd); _fwd.y = 0; if (_fwd.lengthSq() > 0) _fwd.normalize(); }
    const rx = -_fwd.z, rz = _fwd.x; // camera right vector (for pan)
    for (let i = 0; i < A.dripSlots.length; i++) {
        const slot = A.dripSlots[i];
        slot.timer -= dt;
        if (slot.timer > 0) continue;
        if (i >= cap || !canDrip) { slot.timer = 0.5 + Math.random() * 0.5; continue; }
        const d = pickNearbyDrip(cam);
        if (!d) { slot.timer = 0.6 + Math.random() * 0.6; continue; }
        const dist = Math.hypot(d.x - cam.x, d.z - cam.z);
        const atten = Math.pow(clamp01(1 - dist / DRIP_RADIUS), 1.6);
        const gain = DRIP_GAIN * atten * inside * A.gate;
        if (gain > 0.0005) {
            const dirx = (d.x - cam.x) / (dist || 1), dirz = (d.z - cam.z) / (dist || 1);
            const pan = Math.max(-1, Math.min(1, dirx * rx + dirz * rz));
            playDrip(d.x, d.floorY, d.z, gain, pan);
            dripFired++;
        }
        // gentle cadence so a few drips never become a machine-gun
        slot.timer = 1.4 + Math.random() * 2.6;
    }

    // ---- item 89: surface-varied footsteps on grounded cave movement ----
    let footThisFrame = 0;
    const p = state.player;
    if (A.gate > 0.5 && p && p.inCave && p.grounded && p.velocity && cam) {
        const speed = p.velocity.length();
        if (speed > FOOT_MIN_SPEED) {
            A.strideAcc += speed * dt;
            if (A.strideAcc >= STRIDE_LEN) {
                A.strideAcc = 0;
                A.lastFootFoot ^= 1;
                playFootstep(footSurface(cam.x, cam.z), A.lastFootFoot);
                footThisFrame = 1;
            }
        } else {
            A.strideAcc = STRIDE_LEN * 0.5; // primed so the next step lands promptly
        }
    } else {
        A.strideAcc = STRIDE_LEN * 0.5;
    }

    publishStats({
        reverbWet: wet, rumble, trickle,
        dripVoices: dripFired, footstepsThisFrame: footThisFrame,
        inside, depth,
    });
}

function setGain(gn, v, now) {
    if (!gn) return;
    if (!isFinite(v) || v < 0) v = 0;
    try { gn.gain.setTargetAtTime(v, now, 0.08); } catch (e) {}
}

/* Pick a real drip point within range of the player (prefer the pool drips
   that already spawn ripples). Returns a caveDripData entry or null. */
function pickNearbyDrip(cam) {
    const list = state.caveDripData;
    if (!list || !list.length) return null;
    let pick = null, pickPool = null, seen = 0, seenPool = 0;
    for (let i = 0; i < list.length; i++) {
        const d = list[i];
        const dx = d.x - cam.x, dz = d.z - cam.z;
        if (dx * dx + dz * dz > DRIP_RADIUS * DRIP_RADIUS) continue;
        // reservoir-sample one in range, and one among the pool drips
        seen++; if (Math.random() < 1 / seen) pick = d;
        if (d.pool) { seenPool++; if (Math.random() < 1 / seenPool) pickPool = d; }
    }
    return pickPool || pick;
}

/* ------------------------------------------------------------
   Teardown (game destroy) — stop + disconnect every node BEFORE
   state.audio.close() so there are no "cannot connect after close"
   errors and no leaks.
   ------------------------------------------------------------ */
export function disposeCaveAudio() {
    A.stopped = true;
    A.active = false;
    const stopAt = state.audio ? state.audio.currentTime + 0.02 : 0;
    for (const n of A.rumbleNodes) { try { n.stop(stopAt); } catch (e) {} try { n.disconnect(); } catch (e) {} }
    A.rumbleNodes = [];
    for (const gn of [A.rumbleGain, A.trickleGain, A.reverbWet, A.convolver, A.reverbInput, A.master]) {
        if (gn) { try { gn.disconnect(); } catch (e) {} }
    }
    // the SFX bus outlives this layer (audio.js owns it); just drop our tap by
    // disconnecting reverbInput above — sfxBus.connect(reverbInput) dies with it.
    A.built = false;
    A.master = A.reverbInput = A.convolver = A.reverbWet = A.rumbleGain = A.trickleGain = null;
    A.dripSlots = [];
    state.caveAudio = null;
}

// Test-rig introspection (read-only).
export function caveAudioStats() { return state.caveAudio; }
