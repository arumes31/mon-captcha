/* ============================================================
   Audio Synthesizer
   ============================================================ */

import { state } from './state.js';

// All discrete one-shot SFX route through this shared bus (instead of straight
// to ctx.destination) so the cave audio layer (caves-audio.js) can tap it for
// the in-cave reverb send — silent/bypassed outdoors, so surface audio is
// byte-identical. The looping waterfall surface bed deliberately stays on the
// raw destination (it is not a cave sound). Falls back to the raw destination
// if the bus was never created (partial audio-init failure).
function sfxOut(ctx) { return state.sfxBus || ctx.destination; }

export function initAudio() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        state.audio = ctx;

        // Shared SFX bus (see sfxOut above) — created first so every SFX helper
        // has it, and caves-audio.js can tap it for the reverb send.
        state.sfxBus = ctx.createGain();
        state.sfxBus.gain.value = 1;
        state.sfxBus.connect(ctx.destination);

        // Synth pop buffer for catching
        const sr = ctx.sampleRate;
        const len = Math.floor(sr * 0.12);
        const buf = ctx.createBuffer(1, len, sr);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
            const t = i / len;
            data[i] = Math.sin(2 * Math.PI * (600 + 800 * t) * (i / sr)) * (1 - t) * 0.45;
        }
        state.popBuffer = buf;
    } catch (e) {
        console.warn('[captcha] Audio Context failed to load', e);
        state.audio = null;
    }
}

export function playPop() {
    if (!state.audio || !state.popBuffer) return;
    try {
        if (state.audio.state === 'suspended') state.audio.resume();
        const src = state.audio.createBufferSource();
        src.buffer = state.popBuffer;
        const gain = state.audio.createGain();
        gain.gain.value = 0.4;
        src.connect(gain).connect(sfxOut(state.audio));
        src.start();
    } catch (e) {}
}

export function playThump() {
    if (!state.audio) return;
    try {
        if (state.audio.state === 'suspended') state.audio.resume();
        const osc = state.audio.createOscillator();
        const gain = state.audio.createGain();
        osc.connect(gain).connect(sfxOut(state.audio));

        osc.frequency.setValueAtTime(120, state.audio.currentTime);
        osc.frequency.exponentialRampToValueAtTime(10, state.audio.currentTime + 0.18);
        gain.gain.setValueAtTime(0.25, state.audio.currentTime);
        gain.gain.linearRampToValueAtTime(0.001, state.audio.currentTime + 0.18);

        osc.start();
        osc.stop(state.audio.currentTime + 0.18);
    } catch (e) {}
}

// Throw whoosh — a breathy bandpass noise sweep rising with the arm
export function playThrow() {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const len = Math.floor(ctx.sampleRate * 0.22);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
            const t = i / len;
            data[i] = (Math.random() * 2 - 1) * Math.sin(t * Math.PI) * 0.6; // swell + fade
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 1.1;
        filter.frequency.setValueAtTime(340, ctx.currentTime);
        filter.frequency.exponentialRampToValueAtTime(2600, ctx.currentTime + 0.18);
        const gain = ctx.createGain();
        gain.gain.value = 0.18;
        src.connect(filter).connect(gain).connect(sfxOut(ctx));
        src.start();
    } catch (e) {}
}

// Wobble tick — a woody knock: bright transient over a low body knock
export function playWobbleTick() {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        const click = ctx.createOscillator();
        click.type = 'triangle';
        click.frequency.setValueAtTime(760, t0);
        click.frequency.exponentialRampToValueAtTime(420, t0 + 0.07);
        const cg = ctx.createGain();
        cg.gain.setValueAtTime(0.22, t0);
        cg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);
        click.connect(cg).connect(sfxOut(ctx));
        click.start(t0);
        click.stop(t0 + 0.09);
        const body = ctx.createOscillator();
        body.frequency.setValueAtTime(190, t0);
        body.frequency.exponentialRampToValueAtTime(95, t0 + 0.08);
        const bg = ctx.createGain();
        bg.gain.setValueAtTime(0.14, t0);
        bg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);
        body.connect(bg).connect(sfxOut(ctx));
        body.start(t0);
        body.stop(t0 + 0.09);
    } catch (e) {}
}

// Success chime — a warm rising two-note (C5 -> G5), gently detuned
export function playSuccessChime() {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        const master = ctx.createGain();
        master.gain.value = 0.2;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 3200;
        master.connect(lp).connect(sfxOut(ctx));
        const notes = [[523.25, 0], [784, 0.13]]; // C5 then G5
        for (const [freq, at] of notes) {
            for (const det of [1, 1.004]) { // pair of slightly detuned sines = warmth
                const osc = ctx.createOscillator();
                osc.frequency.value = freq * det;
                const g = ctx.createGain();
                g.gain.setValueAtTime(0.0001, t0 + at);
                g.gain.exponentialRampToValueAtTime(0.5, t0 + at + 0.015);
                g.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.5);
                osc.connect(g).connect(master);
                osc.start(t0 + at);
                osc.stop(t0 + at + 0.55);
            }
        }
    } catch (e) {}
}

// Breakout burst — a detuned pop dropping fast, with an air puff
export function playBreakout() {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        for (const f of [310, 328]) { // beating detune reads as a burst
            const osc = ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.setValueAtTime(f, t0);
            osc.frequency.exponentialRampToValueAtTime(68, t0 + 0.26);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.09, t0);
            g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.26);
            osc.connect(g).connect(sfxOut(ctx));
            osc.start(t0);
            osc.stop(t0 + 0.26);
        }
        const len = Math.floor(ctx.sampleRate * 0.14);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
            const t = i / len;
            data[i] = (Math.random() * 2 - 1) * (1 - t) * 0.5;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 900;
        const ng = ctx.createGain();
        ng.gain.value = 0.16;
        src.connect(hp).connect(ng).connect(sfxOut(ctx));
        src.start();
    } catch (e) {}
}

/* ------------------------------------------------------------
   Waterfall rush — a looping filtered-noise bed started once;
   mountain.js drives its gain from the player's distance to the
   falls every frame (0 when far, soft wash up close).
   ------------------------------------------------------------ */
export function startWaterfallLoop() {
    if (!state.audio || state.waterfallGain) return;
    try {
        const ctx = state.audio;
        const len = Math.floor(ctx.sampleRate * 2.0);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        let brown = 0;
        for (let i = 0; i < len; i++) { // brownish noise reads as rushing water
            brown = (brown + (Math.random() * 2 - 1) * 0.14) * 0.985;
            data[i] = brown * 2.4 + (Math.random() * 2 - 1) * 0.18;
        }
        // seamless loop: crossfade the tail into the head
        const xf = Math.floor(ctx.sampleRate * 0.15);
        for (let i = 0; i < xf; i++) {
            const k = i / xf;
            data[len - xf + i] = data[len - xf + i] * (1 - k) + data[i] * k;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        const gain = ctx.createGain();
        gain.gain.value = 0; // driven by distance in mountain.js
        src.connect(lp).connect(gain).connect(ctx.destination); // surface bed — never reverbed
        src.start();
        state.waterfallGain = gain;
        state.waterfallSrc = src;
    } catch (e) {}
}

export function setWaterfallVolume(v) {
    if (!state.waterfallGain || !state.audio) return;
    try {
        state.waterfallGain.gain.setTargetAtTime(v, state.audio.currentTime, 0.25);
    } catch (e) {}
}

// Legendary proximity sting — a soft, airy minor-third shimmer
export function playLegendarySting() {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        const master = ctx.createGain();
        master.gain.value = 0.11;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2600;
        master.connect(lp).connect(sfxOut(ctx));
        const notes = [[659.25, 0], [783.99, 0.22], [987.77, 0.44]]; // E5-G5-B5 rising
        for (const [freq, at] of notes) {
            for (const det of [1, 0.996]) {
                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = freq * det;
                const g = ctx.createGain();
                g.gain.setValueAtTime(0.0001, t0 + at);
                g.gain.exponentialRampToValueAtTime(0.4, t0 + at + 0.06);
                g.gain.exponentialRampToValueAtTime(0.001, t0 + at + 1.1);
                osc.connect(g).connect(master);
                osc.start(t0 + at);
                osc.stop(t0 + at + 1.2);
            }
        }
    } catch (e) {}
}

// Alarm chirp — a bright, quick two-peep call (alerted creatures)
export function playAlarmChirp() {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        for (const at of [0, 0.09]) {
            const osc = ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(2100, t0 + at);
            osc.frequency.exponentialRampToValueAtTime(2900, t0 + at + 0.05);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t0 + at);
            g.gain.exponentialRampToValueAtTime(0.08, t0 + at + 0.012);
            g.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.07);
            osc.connect(g).connect(sfxOut(ctx));
            osc.start(t0 + at);
            osc.stop(t0 + at + 0.08);
        }
    } catch (e) {}
}

// Thunder — a delayed low rumble: a filtered noise body under a slow low-sine
// swell, tail length + brightness scaled by how far the strike was (delay).
export function playThunder(distance = 0.5) {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        const far = Math.min(1, distance);           // 0 near (crack), 1 far (deep boom)
        const dur = 1.4 + far * 2.2;
        // rumbling filtered-noise body
        const len = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        let brown = 0;
        for (let i = 0; i < len; i++) {
            const t = i / len;
            brown = (brown + (Math.random() * 2 - 1) * 0.16) * 0.986;
            // amplitude swell then long decay; crackle up front for near strikes
            const env = Math.min(1, t * 12) * Math.pow(1 - t, 1.6);
            const crack = (1 - far) * (Math.random() * 2 - 1) * Math.max(0, 1 - t * 8) * 0.5;
            data[i] = (brown * 2.6 + crack) * env;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 320 - far * 160;        // farther = duller
        const g = ctx.createGain();
        g.gain.value = 0.32 * (1 - far * 0.45);
        src.connect(lp).connect(g).connect(sfxOut(ctx));
        src.start(t0);
        // sub-bass swell under it
        const sub = ctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(58 - far * 18, t0);
        sub.frequency.exponentialRampToValueAtTime(28, t0 + dur * 0.7);
        const sg = ctx.createGain();
        sg.gain.setValueAtTime(0.0001, t0);
        sg.gain.exponentialRampToValueAtTime(0.22 * (1 - far * 0.4), t0 + 0.12);
        sg.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        sub.connect(sg).connect(sfxOut(ctx));
        sub.start(t0);
        sub.stop(t0 + dur + 0.1);
    } catch (e) {}
}

// Crystal chime — a quiet glassy bell ping when a ball strikes near a crystal.
// Pentatonic pitch (seeded per crystal) + a soft fifth = a clean, pretty ting
// that reads as struck glass; short bright decay so a flurry of hits sparkles.
const CHIME_SCALE = [659.25, 739.99, 880, 987.77, 1174.66, 1318.51]; // E5 F#5 A5 B5 D6 E6
export function playCrystalChime(pick = Math.random()) {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        const master = ctx.createGain();
        master.gain.value = 0.09;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 6000;
        master.connect(lp).connect(sfxOut(ctx));
        const root = CHIME_SCALE[Math.floor(pick * CHIME_SCALE.length) % CHIME_SCALE.length];
        for (const [mult, amp, dur] of [[1, 0.5, 0.9], [1.5, 0.24, 0.6], [2.005, 0.14, 0.4]]) {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = root * mult;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(amp, t0 + 0.006);
            g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
            osc.connect(g).connect(master);
            osc.start(t0);
            osc.stop(t0 + dur + 0.05);
        }
    } catch (e) {}
}

// Singing crystal — a soft, sustained glassy chord that swells and fades as the
// player nears the rare tuned crystal. Slow attack/release, gentle vibrato, low
// gain so it hangs in the air under the ambience rather than over it.
export function playSingingCrystal() {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        const master = ctx.createGain();
        master.gain.setValueAtTime(0.0001, t0);
        master.gain.exponentialRampToValueAtTime(0.06, t0 + 0.4);
        master.gain.exponentialRampToValueAtTime(0.0008, t0 + 2.0);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 3000;
        master.connect(lp).connect(sfxOut(ctx));
        // slow vibrato shared across the chord for a "singing" shimmer
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 5.2;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 2.4;
        lfo.connect(lfoGain);
        lfo.start(t0); lfo.stop(t0 + 2.2);
        for (const freq of [523.25, 783.99, 1046.5]) { // C5 G5 C6 — open, crystalline
            for (const det of [1, 1.003]) {
                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = freq * det;
                lfoGain.connect(osc.frequency);
                const g = ctx.createGain();
                g.gain.value = 0.34;
                osc.connect(g).connect(master);
                osc.start(t0);
                osc.stop(t0 + 2.2);
            }
        }
    } catch (e) {}
}

// Spore poof — a very soft breathy pop when a puffball bursts (short lowpassed
// noise puff, quiet so it never competes with the catch SFX).
export function playSporePoof() {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const len = Math.floor(ctx.sampleRate * 0.2);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
            const t = i / len;
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.2) * 0.5;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(1200, ctx.currentTime);
        lp.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.18);
        const g = ctx.createGain();
        g.gain.value = 0.12;
        src.connect(lp).connect(g).connect(sfxOut(ctx));
        src.start();
    } catch (e) {}
}

// Bat scatter (Phase 2j item 65) — a burst of leathery wing flutter (fast
// filtered-noise flaps) under a couple of thin squeaks as the colony explodes off
// the vault. Quiet + short so a scatter reads without stepping on the catch SFX.
export function playBatScatter() {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        // wing-flutter: amplitude-modulated noise (the "flap flap flap")
        const len = Math.floor(ctx.sampleRate * 0.5);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
            const t = i / len;
            const flap = 0.5 + 0.5 * Math.sin(2 * Math.PI * 12 * t); // ~12 Hz wingbeat
            data[i] = (Math.random() * 2 - 1) * flap * Math.pow(1 - t, 1.3) * 0.5;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.Q.value = 0.8; bp.frequency.value = 900;
        const g = ctx.createGain();
        g.gain.value = 0.14;
        src.connect(bp).connect(g).connect(sfxOut(ctx));
        src.start(t0);
        // thin squeaks
        for (const at of [0.02, 0.13]) {
            const osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(3600 + Math.random() * 700, t0 + at);
            osc.frequency.exponentialRampToValueAtTime(2200, t0 + at + 0.08);
            const sg = ctx.createGain();
            sg.gain.setValueAtTime(0.0001, t0 + at);
            sg.gain.exponentialRampToValueAtTime(0.05, t0 + at + 0.01);
            sg.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.1);
            osc.connect(sg).connect(sfxOut(ctx));
            osc.start(t0 + at); osc.stop(t0 + at + 0.12);
        }
    } catch (e) {}
}

// Echo call (Phase 2j item 76) — a single sonar-style ping that reveals the
// echo-locator: a quick down-chirp with a short reverberant tail (delay feedback),
// low gain so it hangs in the cave air like a returned echo.
export function playEchoCall() {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        const out = ctx.createGain();
        out.gain.value = 0.12;
        // a short echo tail via a feedback delay
        const delay = ctx.createDelay();
        delay.delayTime.value = 0.16;
        const fb = ctx.createGain();
        fb.gain.value = 0.42;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 2600;
        out.connect(sfxOut(ctx));
        out.connect(delay); delay.connect(lp); lp.connect(fb); fb.connect(delay); delay.connect(sfxOut(ctx));
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1560, t0);
        osc.frequency.exponentialRampToValueAtTime(760, t0 + 0.14);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.9, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2);
        osc.connect(g).connect(out);
        osc.start(t0); osc.stop(t0 + 0.22);
    } catch (e) {}
}

export function playSplash() {
    if (!state.audio) return;
    try {
        if (state.audio.state === 'suspended') state.audio.resume();
        const ctx = state.audio;
        // short filtered noise burst — reads as a soft "plunk" into water
        const len = Math.floor(ctx.sampleRate * 0.25);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
            const t = i / len;
            data[i] = (Math.random() * 2 - 1) * (1 - t) * (1 - t) * 0.5;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1400, ctx.currentTime);
        filter.frequency.exponentialRampToValueAtTime(280, ctx.currentTime + 0.22);
        const gain = ctx.createGain();
        gain.gain.value = 0.35;
        src.connect(filter).connect(gain).connect(sfxOut(ctx));
        src.start();
    } catch (e) {}
}

/* ============================================================
   Phase 2k — cave gameplay SFX (items 79, 82, 83)
   ============================================================ */

// Ricochet (item 79) — a short, dry rock "clack" when a thrown ball bounces off a
// cave wall/ceiling. Tiny filtered-noise tick + a quick pitch blip so a flurry of
// trick-shot bounces reads crisply without drowning the catch SFX.
export function playRicochet() {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        const len = Math.floor(ctx.sampleRate * 0.06);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) { const t = i / len; data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 5) * 0.5; }
        const src = ctx.createBufferSource(); src.buffer = buf;
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 1.1;
        const g = ctx.createGain(); g.gain.value = 0.22;
        src.connect(bp).connect(g).connect(sfxOut(ctx));
        src.start(t0);
    } catch (e) {}
}

// Collapse rumble (item 82) — a deep, brief rock-fall roar for the timed collapse
// drama after grabbing a deep prize. Purely cosmetic; a lower-passed cousin of the
// thunder body with a sub swell. Never loud enough to compete with the success chime.
export function playRockRumble() {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        const dur = 1.8;
        const len = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        let brown = 0;
        for (let i = 0; i < len; i++) {
            const t = i / len;
            brown = (brown + (Math.random() * 2 - 1) * 0.2) * 0.985;
            // fast attack (the crack of the fall) then a tumbling decay + gravel rattle
            const env = Math.min(1, t * 20) * Math.pow(1 - t, 1.5);
            const rattle = (Math.random() * 2 - 1) * Math.max(0, 0.6 - t) * 0.4;
            data[i] = (brown * 2.8 + rattle) * env;
        }
        const src = ctx.createBufferSource(); src.buffer = buf;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
        const g = ctx.createGain(); g.gain.value = 0.3;
        src.connect(lp).connect(g).connect(sfxOut(ctx));
        src.start(t0);
        const sub = ctx.createOscillator(); sub.type = 'sine';
        sub.frequency.setValueAtTime(52, t0);
        sub.frequency.exponentialRampToValueAtTime(26, t0 + dur * 0.8);
        const sg = ctx.createGain();
        sg.gain.setValueAtTime(0.0001, t0);
        sg.gain.exponentialRampToValueAtTime(0.24, t0 + 0.08);
        sg.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        sub.connect(sg).connect(sfxOut(ctx));
        sub.start(t0); sub.stop(t0 + dur + 0.1);
    } catch (e) {}
}

// Grotto-ball pickup (item 83) — a bright, glassy up-arpeggio reward flourish when
// the player collects the cave-found capture ball. Distinct from the crystal chime.
export function playCaveBallPickup() {
    if (!state.audio) return;
    try {
        const ctx = state.audio;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        const master = ctx.createGain(); master.gain.value = 0.14;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
        master.connect(lp).connect(sfxOut(ctx));
        const notes = [587.33, 783.99, 987.77, 1318.51]; // D5 G5 B5 E6 — rising, open
        notes.forEach((f, i) => {
            const st = t0 + i * 0.07;
            const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = f;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, st);
            g.gain.exponentialRampToValueAtTime(0.5, st + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0008, st + 0.5);
            osc.connect(g).connect(master);
            osc.start(st); osc.stop(st + 0.55);
        });
    } catch (e) {}
}
