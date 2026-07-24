/* ============================================================
   Catch Sequence — Palworld-style capture flow
   ------------------------------------------------------------
   A connected ball starts a per-creature state machine:
     suck     creature spirals + stretches into the ball (~0.35s)
     fall     the closed ball drops, bounces once and settles
     settle   a held beat before the wobbles start
     wobble   3 rocking wobbles with dust + tick sounds; a failed
              roll breaks out at a random wobble instead
     success  golden click: star burst + chime + toast; the
              capture counter and security hash fold ONLY here
     restore  (breakout) the creature re-grows and bolts away
   The chance is rolled once, on connect (tier base + back
   bonus). Everything runs off the game loop clock — sequences
   keep finishing while paused/solved, mirroring the old pop
   tween — and destroy() can interrupt any phase safely.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { getGroundY, isWaterAt, getWaterLevelAt, findDryLand, caveAt } from './heightfield.js';
import { spawnParticleBurst, spawnTrailMote, spawnWaterRipple } from './particles.js';
import { playPop, playThump, playSplash, playWobbleTick, playSuccessChime, playBreakout } from './audio.js';
import { stopMusic } from './music.js';
import { stopCaveAudio } from './caves/caves-audio.js';
import { foldCapture, validateCaptureHash, generateToken } from './security.js';
import { showCaptureToast, updateCounterUI, showSuccessModal } from './ui.js';
import { makeFlashSprite, removeBall } from './ball.js';
import { caveCaptureBonus, maybeCollapse } from './caves/caves-gameplay.js';

const DUST = 0xcaa87a;              // sandy puff for ground wobbles
const GOLD = 0xffd75e;              // success stars
const scratch = new THREE.Vector3();

/* ------------------------------------------------------------
   Entry point — called by projectiles.js when a ball connects.
   The projectile's own ball mesh is handed over and lives on as
   the catch ball. Roll the capture chance right here, once.
   ------------------------------------------------------------ */
export function beginCatchSequence(creature, index, dist, backHit, ball, impactVel) {
    if (!creature.alive || creature.capturing) return;
    creature.alive = false;      // untargetable by other balls & the hover ray
    creature.capturing = true;

    const base = CONFIG.CAPTURE_RATE_BY_TIER[creature.def.tier] !== undefined
        ? CONFIG.CAPTURE_RATE_BY_TIER[creature.def.tier] : CONFIG.CAPTURE_MAX_CHANCE;
    // SINGLE roll site: the effective chance is capped so nothing is ever
    // guaranteed — not even a common struck from behind, in a dead-end, with the
    // grotto ball (base + back + cave modifiers would exceed 1.0). The Phase 2k
    // cave modifiers (item 78 dead-end corner, item 83 grotto ball) are additive
    // INTO this one clamp; item 85's tunnel back-lean only widened the cone that
    // decided `backHit` upstream — the bonus amount is still CAPTURE_BACK_BONUS.
    const chance = Math.min(
        CONFIG.CAPTURE_MAX_CHANCE,
        base + (backHit ? CONFIG.CAPTURE_BACK_BONUS : 0) + caveCaptureBonus(creature)
    );
    const success = Math.random() < chance;

    // connect feedback: white flash + type-colored burst + pop
    spawnFlash(ball.position.x, ball.position.y, ball.position.z, 0xffffff, 0.5, 1.7, 0.2);
    spawnParticleBurst(ball.position.x, ball.position.y, ball.position.z, creature.def.particle, 14);
    playPop();

    // the ball soaks up the impact: most momentum dies, a soft pop upward
    const vel = new THREE.Vector3(impactVel.x * 0.12, 2.3, impactVel.z * 0.12);

    state.captureSeqs.push({
        c: creature,
        index, dist, chance, backHit, success,
        breakAt: success ? -1 : 1 + Math.floor(Math.random() * CONFIG.CATCH_WOBBLE_COUNT),
        ball, vel,
        phase: 'suck',
        t: 0,
        start: creature.pos.clone(),         // suck-in origin
        spiralPhase: Math.random() * Math.PI * 2,
        bounces: 0,
        wobbles: 0,
        wobbleAnimT: null,
        wobbleDir: 1,
        done: false,
    });
}

/* ------------------------------------------------------------
   Per-frame driver — called unconditionally from the game loop
   (sequences must finish even when the win modal is up).
   ------------------------------------------------------------ */
export function updateCaptureSequences(dt) {
    updateFlashes(dt);
    if (state.captureSeqs.length === 0) return;

    for (const seq of state.captureSeqs) {
        if (seq.done) continue;
        seq.t += dt;
        switch (seq.phase) {
            case 'suck': updateSuck(seq, dt); break;
            case 'fall': updateFall(seq, dt); break;
            case 'settle': updateSettle(seq, dt); break;
            case 'wobble': updateWobble(seq, dt); break;
            case 'success': updateSuccess(seq, dt); break;
            case 'restore': updateRestore(seq, dt); break;
        }
    }
    state.captureSeqs = state.captureSeqs.filter(s => !s.done);
}

/* ---- phase: suck — shrink + spiral + stretch into the ball ---- */
function updateSuck(seq, dt) {
    const c = seq.c;
    const ball = seq.ball;
    const k = Math.min(1, seq.t / CONFIG.CATCH_SUCK_TIME);

    // the ball drifts on damped gravity so it hangs near the hit point
    seq.vel.y += CONFIG.BALL_GRAVITY * 0.25 * dt;
    ball.position.addScaledVector(seq.vel, dt);
    ball.rotation.y += dt * 6;

    // creature spirals in: eased lerp toward the ball + shrinking orbit
    const e = k * k;
    const ang = seq.spiralPhase + k * 13;
    const orbit = (1 - k) * 0.55;
    scratch.copy(seq.start).lerp(ball.position, e);
    c.pos.set(
        scratch.x + Math.cos(ang) * orbit,
        scratch.y + Math.sin(ang * 0.7) * orbit * 0.4,
        scratch.z + Math.sin(ang) * orbit
    );
    const s = Math.max(0.001, c.def.scale * (1 - e));
    c.group.scale.set(s * (1 - k * 0.35), s * (1 + k * 1.7), s * (1 - k * 0.35)); // stretch toward the ball
    c.group.rotation.y += dt * 24;

    // streak motes tracing the pull (extras skipped on the low tier)
    if (state.qualityLevel !== 'low' && Math.random() < dt * 42) {
        spawnTrailMote(c.pos.x, c.pos.y + c.centerY * (1 - k), c.pos.z, c.def.particle);
    }

    if (k >= 1) {
        state.scene.remove(c.group);
        c.group.scale.setScalar(c.def.scale); // clean transform for a possible breakout
        c.group.rotation.x = 0;
        c.group.rotation.z = 0;
        spawnFlash(ball.position.x, ball.position.y, ball.position.z, c.def.particle, 0.35, 1.1, 0.16);
        seq.phase = 'fall';
        seq.t = 0;
    }
}

/* ---- phase: fall — drop, one small bounce, settle ---- */
function updateFall(seq, dt) {
    const ball = seq.ball;
    seq.vel.y += CONFIG.BALL_GRAVITY * dt;
    ball.position.addScaledVector(seq.vel, dt);
    ball.rotation.x += dt * 4 * seq.vel.length() * 0.3; // lazy tumble while airborne

    // keep the ball inside the arena walls
    const halfArena = CONFIG.ARENA_SIZE / 2 - CONFIG.WALL_THICKNESS - 0.3;
    ball.position.x = THREE.MathUtils.clamp(ball.position.x, -halfArena, halfArena);
    ball.position.z = THREE.MathUtils.clamp(ball.position.z, -halfArena, halfArena);

    const restY = ballRestHeight(ball.position.x, ball.position.z);
    const inWater = isWaterAt(ball.position.x, ball.position.z);

    if (ball.position.y <= restY) {
        if (inWater) {
            // plops onto the water and floats — ripples instead of dust
            ball.position.y = restY;
            seq.vel.set(0, 0, 0);
            spawnWaterRipple(ball.position.x, ball.position.z, getWaterLevelAt(ball.position.x, ball.position.z));
            playSplash();
            toSettle(seq);
        } else if (seq.bounces < 1 && Math.abs(seq.vel.y) > 2.4) {
            ball.position.y = restY;
            seq.vel.y = -seq.vel.y * 0.38;   // one small bounce
            seq.vel.x *= 0.45;
            seq.vel.z *= 0.45;
            seq.bounces++;
            spawnParticleBurst(ball.position.x, restY - CONFIG.BALL_RADIUS * 0.5, ball.position.z, DUST, 5);
            playThump();
        } else {
            ball.position.y = restY;
            seq.vel.set(0, 0, 0);
            spawnParticleBurst(ball.position.x, restY - CONFIG.BALL_RADIUS * 0.5, ball.position.z, DUST, 4);
            toSettle(seq);
        }
    } else if (seq.t > 3) {
        ball.position.y = restY; // safety: never fall forever
        seq.vel.set(0, 0, 0);
        toSettle(seq);
    }
}

function toSettle(seq) {
    seq.phase = 'settle';
    seq.t = 0;
}

/* ---- phase: settle — right the ball, hold a beat ---- */
function updateSettle(seq, dt) {
    const ball = seq.ball;
    // damp the tumble upright so the wobbles read cleanly
    ball.rotation.x *= Math.max(0, 1 - dt * 10);
    ball.rotation.z *= Math.max(0, 1 - dt * 10);
    if (seq.t >= CONFIG.CATCH_SETTLE_PAUSE) {
        ball.rotation.x = 0;
        ball.rotation.z = 0;
        seq.phase = 'wobble';
        seq.t = 0;
        seq.wobbles = 0;
    }
}

/* ---- phase: wobble — 3 rocking wobbles (or a breakout) ---- */
function updateWobble(seq, dt) {
    const ball = seq.ball;
    const total = CONFIG.CATCH_WOBBLE_COUNT;

    // kick off the next wobble on the interval clock
    if (seq.wobbles < total && seq.t >= seq.wobbles * CONFIG.CATCH_WOBBLE_INTERVAL) {
        seq.wobbles++;
        if (!seq.success && seq.wobbles === seq.breakAt) {
            startBreakout(seq);
            return;
        }
        seq.wobbleAnimT = 0;
        seq.wobbleDir = seq.wobbles % 2 === 0 ? -1 : 1;
        playWobbleTick();
        if (isWaterAt(ball.position.x, ball.position.z)) {
            spawnWaterRipple(ball.position.x, ball.position.z, getWaterLevelAt(ball.position.x, ball.position.z));
        } else {
            spawnParticleBurst(ball.position.x, ball.position.y - CONFIG.BALL_RADIUS * 0.4, ball.position.z, DUST, 4);
        }
    }

    // rock-and-squash animation of the current wobble
    if (seq.wobbleAnimT !== null) {
        seq.wobbleAnimT += dt;
        const k = Math.min(1, seq.wobbleAnimT / 0.42);
        const rock = Math.sin(k * Math.PI * 3) * (1 - k) * 0.5 * seq.wobbleDir;
        const squash = Math.abs(Math.sin(k * Math.PI * 3)) * (1 - k) * 0.16;
        ball.rotation.z = rock;
        ball.scale.set(1 + squash * 0.7, 1 - squash, 1 + squash * 0.7);
        if (k >= 1) {
            seq.wobbleAnimT = null;
            ball.rotation.z = 0;
            ball.scale.setScalar(1);
        }
    }

    // held it through every wobble — the click
    if (seq.wobbles >= total && seq.t >= total * CONFIG.CATCH_WOBBLE_INTERVAL) {
        startSuccess(seq);
    }
}

/* ---- success: golden click. Points + hash fold live HERE ---- */
function startSuccess(seq) {
    const c = seq.c;
    const ball = seq.ball;
    playSuccessChime();
    spawnFlash(ball.position.x, ball.position.y, ball.position.z, GOLD, 0.5, 2.3, 0.32);
    spawnFlash(ball.position.x, ball.position.y + 0.1, ball.position.z, 0xfff6dd, 0.2, 1.0, 0.18);
    spawnParticleBurst(ball.position.x, ball.position.y + 0.15, ball.position.z, GOLD, 28);
    spawnParticleBurst(ball.position.x, ball.position.y + 0.2, ball.position.z, 0xfff6dd, 12);

    // tier-weighted score: commons are 1 point, anything rarer is 2
    const points = c.def.tier === 'common' ? CONFIG.POINTS_COMMON : CONFIG.POINTS_SPECIAL;
    showCaptureToast(c.def, points);

    // Phase 2k item 82: grabbing a DEEP cave prize triggers a timed, purely
    // cosmetic collapse (dust + falling rock + rumble). It never alters the
    // heightfield/confinement, so it can't trap the player or seal a route.
    maybeCollapse(c, ball.position);

    // creature materials are shared cache entries; uniquely-owned ones only
    for (const m of c.materials) {
        if (m && m.dispose) { try { m.dispose(); } catch (e) {} }
    }

    // security metrics fold happens only on a HELD capture (never on contact)
    if (!state.isCaptchaSolved) {
        state.captureHash = foldCapture(state.captureHash, seq.index, performance.now(), seq.dist);
        state.creaturesCaught += points; // "creaturesCaught" carries POINTS (API shape unchanged)
        updateCounterUI();
        if (state.creaturesCaught >= CONFIG.CAPTURES_REQUIRED && validateCaptureHash(state.captureHash)) {
            triggerWin();
        }
    }

    seq.phase = 'success';
    seq.t = 0;
    seq.riseBase = ball.position.y;
}

function updateSuccess(seq, dt) {
    const ball = seq.ball;
    const k = Math.min(1, seq.t / CONFIG.CATCH_SUCCESS_TIME);
    ball.position.y = seq.riseBase + k * 0.35;   // rises as it dissolves
    ball.rotation.y += dt * 9;
    ball.scale.setScalar(Math.max(0.001, 1 - k));
    if (k >= 1) {
        removeBall(ball);
        seq.c.capturing = false; // caught & gone (alive stays false)
        seq.done = true;
    }
}

/* ---- breakout: the ball bursts and the creature escapes ---- */
function startBreakout(seq) {
    const c = seq.c;
    const ball = seq.ball;
    playBreakout();
    spawnFlash(ball.position.x, ball.position.y, ball.position.z, 0xffffff, 0.4, 1.6, 0.2);
    spawnParticleBurst(ball.position.x, ball.position.y, ball.position.z, c.def.particle, 18);
    spawnParticleBurst(ball.position.x, ball.position.y, ball.position.z, 0xffe9c6, 8);
    removeBall(ball); // the ball is consumed

    // reappear where the ball sat, nudged to legal ground for its habitat
    const halfArena = CONFIG.ARENA_SIZE / 2 - CONFIG.CREATURE_BOUNDARY_MARGIN;
    let x = THREE.MathUtils.clamp(ball.position.x, -halfArena, halfArena);
    let z = THREE.MathUtils.clamp(ball.position.z, -halfArena, halfArena);
    if (c.def.aquatic) {
        if (!isWaterAt(x, z, -0.8)) { // swimmers fall back to the open pond
            const dc = Math.sqrt(x * x + z * z) || 0.001;
            const maxR = CONFIG.POND_RADIUS - 1.2;
            x *= maxR / dc; z *= maxR / dc;
        }
    } else if (!c.def.hover && isWaterAt(x, z, 1.2)) {
        const dry = findDryLand(x, z, 1.2); // walkers never wade (pond OR river)
        x = THREE.MathUtils.clamp(dry.x, -halfArena, halfArena);
        z = THREE.MathUtils.clamp(dry.z, -halfArena, halfArena);
    }
    let y;
    if (c.def.aquatic) y = CONFIG.POND_WATER_LEVEL;
    else if (c.def.hover) y = Math.max(getGroundY(x, z), CONFIG.POND_WATER_LEVEL) + c.def.hover;
    else y = getGroundY(x, z);
    c.pos.set(x, y, z);
    c.inCave = !c.def.aquatic && !!caveAt(x, z); // resettle may land in/out of a cave

    c.group.rotation.set(0, c.group.rotation.y, 0);
    c.group.scale.setScalar(0.03);
    state.scene.add(c.group);

    // panic: bolt fast for a few seconds (behavior.js reads these)
    const nowS = performance.now() / 1000;
    c.scaredUntil = nowS + 2.0;
    c.breakoutUntil = nowS + CONFIG.BREAKOUT_PANIC_TIME;
    c.heading = Math.random() * Math.PI * 2;

    seq.phase = 'restore';
    seq.t = 0;
}

function updateRestore(seq, dt) {
    const c = seq.c;
    const k = Math.min(1, seq.t / CONFIG.CATCH_RESTORE_TIME);
    const back = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2); // easeOutBack overshoot
    c.group.scale.setScalar(c.def.scale * Math.max(0.03, back));
    if (k >= 1) {
        c.group.scale.setScalar(c.def.scale);
        c.capturing = false;
        c.alive = true;      // targetable again, and running scared
        seq.done = true;
    }
}

/* ------------------------------------------------------------
   Win — unchanged flow, now reachable only via a held capture.
   ------------------------------------------------------------ */
async function triggerWin() {
    if (state.isCaptchaSolved) return;
    state.isCaptchaSolved = true;
    state.isPaused = false;
    stopMusic(); // ambient bows out; the success chime owns the stage
    stopCaveAudio(); // Phase 2l: cave audio stops for good on solve
    try { state.controls.unlock(); } catch (e) {}
    showSuccessModal();
    const token = await generateToken();
    state.token = token;
    if (typeof window.onCaptchaSolved === 'function') {
        try { window.onCaptchaSolved(token); } catch (e) {
            console.error('[captcha] error in solving handler callbacks', e);
        }
    }
}

/* ------------------------------------------------------------
   Flash sprites — additive glow pops (impact, click, breakout).
   Each owns its material (color/opacity animate per flash).
   ------------------------------------------------------------ */
function spawnFlash(x, y, z, color, fromScale, toScale, life) {
    if (!state.scene) return;
    const sprite = makeFlashSprite(color, fromScale);
    sprite.position.set(x, y, z);
    sprite.renderOrder = 6;
    state.scene.add(sprite);
    state.captureFlashes.push({ sprite, age: 0, life, from: fromScale, to: toScale });
}

function updateFlashes(dt) {
    if (state.captureFlashes.length === 0) return;
    for (const f of state.captureFlashes) {
        f.age += dt;
        const k = f.age / f.life;
        if (k >= 1) {
            state.scene.remove(f.sprite);
            f.sprite.material.dispose();
            f.dead = true;
            continue;
        }
        f.sprite.scale.setScalar(f.from + (f.to - f.from) * k);
        f.sprite.material.opacity = 1 - k * k;
    }
    state.captureFlashes = state.captureFlashes.filter(f => !f.dead);
}

/* ------------------------------------------------------------
   Helpers & teardown
   ------------------------------------------------------------ */
function ballRestHeight(x, z) {
    const R = CONFIG.BALL_RADIUS;
    if (isWaterAt(x, z)) return Math.max(getWaterLevelAt(x, z) + R * 0.55, getGroundY(x, z) + R);
    return getGroundY(x, z) + R;
}

// destroy() safety: drop every mid-flight sequence (creature groups are
// removed by the main teardown; ball assets die in disposeBallCaches)
export function disposeCaptureSequences() {
    for (const seq of state.captureSeqs) removeBall(seq.ball);
    state.captureSeqs = [];
    for (const f of state.captureFlashes) {
        if (state.scene) state.scene.remove(f.sprite);
        try { f.sprite.material.dispose(); } catch (e) {}
    }
    state.captureFlashes = [];
}
