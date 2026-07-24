/* ============================================================
   Creature Intelligence & Legendary Presence
   ------------------------------------------------------------
   A composable "smarts" layer on top of the movement recipes,
   driven by each type's `int` profile in the bestiary:
     dodge : sidestep inbound capture balls. The check only runs
             while balls are in flight; a tier-scaled reaction
             delay is the readable tell, a cooldown leaves a
             punish window, and balls thrown from BEHIND are
             never dodged (the back-bonus line stays the answer).
     cover : fleeing types pick headings that put a tree/rock
             between themselves and the player.
     keep  : preferred range band — back away when crowded,
             creep closer when the player retreats.
     alarm : a panicking creature alerts nearby same-species
             (chirp + scatter). Wired via alarmFrom().
   Also owns the legendary aura (orbiting sparkle motes + subtle
   presence pulse) and the proximity sting cue.
   ============================================================ */

import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { spawnTrailMote, spawnParticleBurst } from '../particles.js';
import { playAlarmChirp, playLegendarySting } from '../audio.js';

/* ------------------------------------------------------------
   Ball dodging. Returns true while the creature is actively
   dodging (its heading already points along the escape line).
   ------------------------------------------------------------ */
export function updateDodge(c, elapsed) {
    const skill = c.def.int ? (c.def.int.dodge || 0) : 0;
    if (skill <= 0) return false;

    // mid-dodge burst
    if (elapsed < c.dodgeUntil) {
        c.heading = c.dodgeDir;
        return true;
    }

    // reaction pending — the "tell" window before the sidestep fires
    if (c.dodgePendingAt > 0) {
        if (elapsed >= c.dodgePendingAt) {
            c.dodgePendingAt = 0;
            c.dodgeUntil = elapsed + 0.34;
            c.dodgeCdUntil = elapsed + 1.5 + (1 - skill) * 1.3; // punish window
            c.heading = c.dodgeDir;
            return true;
        }
        return false;
    }

    if (elapsed < c.dodgeCdUntil || state.projectiles.length === 0) return false;

    // scan inbound balls (usually 0-1 in flight)
    for (let i = 0; i < state.projectiles.length; i++) {
        const p = state.projectiles[i];
        if (!p.active) continue;
        const dx = c.pos.x - p.pos.x;
        const dy = (c.pos.y + c.centerY) - p.pos.y;
        const dz = c.pos.z - p.pos.z;
        const v = p.vel;
        const v2 = v.lengthSq() || 1;
        const tc = (dx * v.x + dy * v.y + dz * v.z) / v2; // closest-approach time
        if (tc < 0.05 || tc > 0.55) continue;             // not closing / still far out
        const mx = dx - v.x * tc, my = dy - v.y * tc, mz = dz - v.z * tc;
        const R = c.hitRadius + 0.55;
        if (mx * mx + my * my + mz * mz > R * R) continue; // clean miss anyway

        // it can't dodge what it can't see: ignore balls from behind
        const bl = Math.hypot(v.x, v.z) || 1;
        if (Math.cos(c.heading) * (v.x / bl) + Math.sin(c.heading) * (v.z / bl) > CONFIG.BACK_BONUS_DOT) continue;

        // schedule the sidestep after a tier-scaled reaction delay
        c.dodgePendingAt = elapsed + Math.max(0.06, 0.3 - skill * 0.24);
        const missLen = Math.hypot(mx, mz);
        c.dodgeDir = missLen > 0.05
            ? Math.atan2(mz / missLen, mx / missLen)           // widen the miss line
            : Math.atan2(v.x, -v.z) + (Math.random() < 0.5 ? 0 : Math.PI); // dead-on: random side
        return false;
    }
    return false;
}

/* ------------------------------------------------------------
   Cover-seeking flee heading (recomputed at most ~1.6x/sec):
   run for the point just BEHIND the nearest obstacle, seen from
   the player, so the trunk blocks the throwing line.
   ------------------------------------------------------------ */
export function coverHeading(c, playerPos, elapsed) {
    if (elapsed < c.coverNextT) return c.coverHeading;
    c.coverNextT = elapsed + 0.6;
    c.coverHeading = null;
    let best = null, bd = 100;
    for (let i = 0; i < state.obstacles.length; i++) {
        const o = state.obstacles[i];
        const dx = o.x - c.pos.x, dz = o.z - c.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 1.2 && d2 < bd) { bd = d2; best = o; }
    }
    if (!best) return null;
    let ax = best.x - playerPos.x, az = best.z - playerPos.z;
    const al = Math.hypot(ax, az) || 1;
    const tx = best.x + (ax / al) * (best.r + 1.3);
    const tz = best.z + (az / al) * (best.r + 1.3);
    c.coverHeading = Math.atan2(tz - c.pos.z, tx - c.pos.x);
    return c.coverHeading;
}

/* ------------------------------------------------------------
   Preferred-range keeping. Returns {heading, mul} or null.
   ------------------------------------------------------------ */
export function keepDistance(c, dp, playerPos) {
    const keep = c.def.int && c.def.int.keep;
    if (!keep) return null;
    if (dp < keep[0]) { // crowded: back off
        return { heading: Math.atan2(c.pos.z - playerPos.z, c.pos.x - playerPos.x), mul: 1.25 };
    }
    if (dp > keep[1] && dp < keep[1] + 7) { // player retreating: creep after them
        return { heading: Math.atan2(playerPos.z - c.pos.z, playerPos.x - c.pos.x), mul: 0.5 };
    }
    return null;
}

/* ------------------------------------------------------------
   Alarm calls — a panicked caller alerts nearby same-species.
   One chirp per alarm wave (globally rate-limited).
   ------------------------------------------------------------ */
export function alarmFrom(caller, nowS) {
    if (!(caller.def.int && caller.def.int.alarm)) return;
    if (nowS < (caller.alarmCdUntil || 0)) return;
    caller.alarmCdUntil = nowS + 4;
    let alerted = false;
    for (const other of state.creatures) {
        if (other === caller || !other.alive || other.capturing) continue;
        if (other.def.id !== caller.def.id) continue;
        const dx = other.pos.x - caller.pos.x, dz = other.pos.z - caller.pos.z;
        if (dx * dx + dz * dz > 121) continue; // 11u call radius
        other.scaredUntil = Math.max(other.scaredUntil, nowS + 1.4);
        other.heading += (Math.random() - 0.5) * 1.6; // scatter
        alerted = true;
    }
    if (alerted && nowS > (state.lastChirpAt || 0) + 1.2) {
        state.lastChirpAt = nowS;
        playAlarmChirp();
        // item 463: a bright "alert" burst at the CALLER, precisely on the same
        // gated frame the chirp actually fires — playAlarmChirp previously only
        // paired with a behavior change (kin scattering), with no on-screen tell
        // marking the alarm call's own onset.
        spawnParticleBurst(caller.pos.x, caller.pos.y + caller.centerY, caller.pos.z, 0xfff3c4, CONFIG.ALARM_CHIRP_BURST_COUNT, caller.def.particle);
    }
}

// Item 315: a per-legendary signature twist on the shared aura so each
// legendary reads distinctly, not just "generic tier glow". Phoenix already
// owns a dedicated ember wake (behavior.js's `def.ember` trail), so it isn't
// listed here — anything not listed keeps the plain single-tone aura.
const LEGENDARY_AURA = {
    crystalGolem: { rate: 20, altColor: true },  // dual-tone faceted sparkle
    goldenDuck: { rate: 22, altColor: false },   // brighter/faster shimmer
    gloomwyrm: { rate: 9, altColor: false },     // slow, deep cathedral drift
};

/* ------------------------------------------------------------
   Legendary presence: orbiting aura sparkles (bloom feeds on the
   additive motes), a subtle larger-than-life pulse, and a soft
   sting the first time the player closes in.
   ------------------------------------------------------------ */
export function updateLegendaryPresence(c, dt, elapsed, playerPos) {
    // aura: motes orbiting the body (skipped on the low tier)
    const sig = LEGENDARY_AURA[c.def.id];
    const rate = sig ? sig.rate : 14;
    if (state.qualityLevel !== 'low' && Math.random() < dt * rate) {
        const a = elapsed * 2.6 + c.phase * 7 + Math.random() * 0.7;
        const rr = c.hitRadius + 0.5;
        const useAlt = sig && sig.altColor && Math.floor(elapsed * 3) % 2 === 0;
        const color = useAlt ? (c.def.palette.accent2 || c.def.palette.glow || c.def.particle) : c.def.particle;
        spawnTrailMote(
            c.pos.x + Math.cos(a) * rr,
            c.pos.y + c.centerY + Math.sin(elapsed * 3.1 + c.phase) * 0.35 + 0.1,
            c.pos.z + Math.sin(a) * rr,
            color
        );
    }

    // larger-than-life: a slow presence pulse (capture/blink own the scale
    // during their phases; this only runs for free-roaming legendaries)
    if (!(c.blinkT > 0)) {
        c.group.scale.setScalar(c.def.scale * (1 + Math.sin(elapsed * 2.1 + c.phase) * 0.035));
    }

    // proximity sting: once on approach, re-armed after backing away
    if (!playerPos) return;
    const dx = c.pos.x - playerPos.x, dz = c.pos.z - playerPos.z;
    const dp2 = dx * dx + dz * dz;
    if (dp2 < 121) { // within 11u
        if (c.stingReady && elapsed > (c.stingCdUntil || 0)) {
            c.stingReady = false;
            c.stingCdUntil = elapsed + 18;
            playLegendarySting();
        }
    } else if (dp2 > 256) { // left 16u
        c.stingReady = true;
    }
}
