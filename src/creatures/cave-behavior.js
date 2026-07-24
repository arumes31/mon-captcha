/* ============================================================
   Cave Creature Behavior — Phase 2j (items 65–76)
   ------------------------------------------------------------
   The movement/reaction engine for the cave-EXCLUSIVE types
   (cave-bestiary.js). behavior.js dispatches any creature whose
   def carries `caveBehavior` here; updateCaveCreature fully drives
   it and returns true (behavior.js then skips its standard path).

   Every recipe is a DISTINCT locomotion (the hard "unique movement"
   rule). Confinement + grounding reuse the SAME field queries the
   player and surface creatures use, so cave creatures never wander
   out onto the surface or into rock, never sink, and captures work
   the same as everywhere else:
     - caveConfine  keeps walkers/fliers inside the passage walls
     - caveCeilingAt clamps fliers under the vault
     - getGroundY    stands walkers on the rendered voxel floor
     - isWaterAt + a hard pool clamp keep the glowfish shoal in-pool

   CULL (2e spirit): a cave creature is only ACTIVE when the player
   is inside a cave or within ACT of it — otherwise it is hidden and
   its per-frame work is skipped, so it costs nothing out in the open.
   ============================================================ */

import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { getGroundY, isWaterAt, caveConfine, caveCeilingAt, sampleCave } from '../heightfield.js';
import { collidesObstacle } from '../player.js';
import { spawnParticleBurst } from '../particles.js';
import { animateCreature } from './animate.js';
import { updateLegendaryPresence } from './smart.js';
import { playBatScatter, playEchoCall } from '../audio.js';

const WS = CONFIG.CREATURE_WANDER_SPEED;
const ACT = 34;                 // activation radius (world units) when the player is NOT in a cave
const ACT2 = ACT * ACT;
const SCATTER_R = 7.5;          // bat colony scatter trigger
const LANTERN_REACH = 9.0;      // how close the lantern lights a creature (item 69/73)

/* ------------------------------------------------------------
   Shared helpers.
   ------------------------------------------------------------ */
// Nearest node of a cave (used to steer a stray dweller back inward).
function nearestNode(cave, x, z) {
    let best = null, bd = Infinity;
    for (const path of cave.paths) for (const n of path) {
        const d = (n.x - x) ** 2 + (n.z - z) ** 2;
        if (d < bd) { bd = d; best = n; }
    }
    return best;
}

// HARD cave leash (item: cave creatures never wander out onto the surface).
// caveConfine leaves the MOUTHS open (right for the player), so on top of it we
// keep a dweller tethered to its HOME cave: while it is inside we remember the
// last safe interior point; the moment it reaches a mouth / drifts out we turn it
// back inward and, if it actually left, snap it to that last safe point.
function keepInCave(c) {
    if (c.caveRef === undefined) {
        const cf0 = sampleCave(c.pos.x, c.pos.z);
        c.caveRef = cf0 ? cf0.cave : null;
    }
    const cave = c.caveRef;
    if (!cave) return;
    const cf = sampleCave(c.pos.x, c.pos.z);
    if (cf && cf.cave === cave && cf.lat < cf.hw) { c._safe = { x: c.pos.x, z: c.pos.z }; return; }
    const n = nearestNode(cave, c.pos.x, c.pos.z);
    c.heading = Math.atan2(n.z - c.pos.z, n.x - c.pos.x);   // steer back inward
    if (!cf || cf.cave !== cave) {                          // actually outside — pull back in
        if (c._safe) { c.pos.x = c._safe.x; c.pos.z = c._safe.z; }
        else { c.pos.x = n.x; c.pos.z = n.z; }
        c.inCave = true;
    }
}

// Lateral wall confinement: slide inside the passage; update inCave flag.
function latConfine(c, radius) {
    const conf = caveConfine(c.pos.x, c.pos.z, radius, c.inCave);
    if (conf) {
        if (conf.x !== c.pos.x || conf.z !== c.pos.z) {
            c.pos.x = conf.x; c.pos.z = conf.z;
            c.heading += (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 3);
        }
        c.inCave = conf.inside;
    } else {
        c.inCave = false;
    }
}

// A grounded walker step: advance along heading (dodging obstacles), confine to
// the passage, stand on the rendered floor. `hopY` lifts hoppers mid-arc.
function walkStep(c, dt, mul, hopY) {
    if (mul > 0.001) {
        const spd = WS * c.def.speed * mul;
        const nx = c.pos.x + Math.cos(c.heading) * spd * dt;
        const nz = c.pos.z + Math.sin(c.heading) * spd * dt;
        const bodyR = Math.min(0.9, c.hitRadius);
        if (!collidesObstacle(nx, nz, bodyR)) { c.pos.x = nx; c.pos.z = nz; }
        else c.heading += Math.PI / 2;
        latConfine(c, Math.min(0.8, c.hitRadius));
        keepInCave(c);
    }
    c.pos.y = getGroundY(c.pos.x, c.pos.z) + (hopY || 0);
    c.group.rotation.y = -c.heading + Math.PI / 2 + (c.meta.face || 0);
    c._mul = mul;
}

// A flier step: advance along heading, confine laterally, hover under the vault.
function flyStep(c, dt, mul, hover, bobK) {
    if (mul > 0.001) {
        const spd = WS * c.def.speed * mul;
        c.pos.x += Math.cos(c.heading) * spd * dt;
        c.pos.z += Math.sin(c.heading) * spd * dt;
        latConfine(c, 0.55);
        keepInCave(c);
    }
    const gy = getGroundY(c.pos.x, c.pos.z);
    let y = gy + Math.max(0.4, hover) + (bobK || 0);
    const ceil = caveCeilingAt(c.pos.x, c.pos.z);
    if (isFinite(ceil)) y = Math.min(y, ceil - 0.4);
    c.pos.y = Math.max(y, gy + 0.3);
    c.group.rotation.y = -c.heading + Math.PI / 2 + (c.meta.face || 0);
    c._mul = mul;
}

// How strongly the player's lantern (or daylight near a mouth) lights a creature.
function litLevel(c, dp) {
    const p = state.player;
    if (!p || !p.inCave) return 0;                    // player not in this cave -> dark for the dweller
    const inside = state.caveFx ? state.caveFx.inside : 1;
    return Math.max(0, 1 - dp / LANTERN_REACH) * inside;
}

/* ------------------------------------------------------------
   65 — ROOST: colony bats hang on the vault, SCATTER on approach.
   ------------------------------------------------------------ */
function roost(c, dt, elapsed, playerPos, dp) {
    const R = c.roost, home = c.roostHome;
    if (dp < SCATTER_R) {
        R.alarmUntil = elapsed + 3.0 + Math.random() * 1.6;
        if (elapsed > (R.soundAt || 0)) { R.soundAt = elapsed + 1.6; if (!state.isPaused) playBatScatter(); }
    }
    if (elapsed < R.alarmUntil) {                     // ---- scattering: frantic flight ----
        if (Math.random() < 0.14) c.heading += (Math.random() * 2 - 1) * 1.9;
        const hx = c.pos.x - home.x, hz = c.pos.z - home.z;
        if (hx * hx + hz * hz > 42) c.heading = Math.atan2(home.z - c.pos.z, home.x - c.pos.x);
        c.group.rotation.x += (0 - c.group.rotation.x) * Math.min(1, dt * 6);
        flyStep(c, dt, 2.6, 1.6, Math.sin(elapsed * 7 + c.phase) * 0.5);
    } else {                                          // ---- re-roosting: return + hang ----
        const dx = home.x - c.pos.x, dz = home.z - c.pos.z, d = Math.hypot(dx, dz);
        if (d > 0.3) {
            c.heading = Math.atan2(dz, dx);
            const spd = WS * c.def.speed * 1.2;
            c.pos.x += Math.cos(c.heading) * spd * dt;
            c.pos.z += Math.sin(c.heading) * spd * dt;
            latConfine(c, 0.5);
            c.pos.y += (home.y - c.pos.y) * Math.min(1, dt * 3);
            c.group.rotation.x += (0 - c.group.rotation.x) * Math.min(1, dt * 6);
            c.group.rotation.y = -c.heading + Math.PI / 2;
            c._mul = 0.8;
        } else {                                      // hang inverted from the ceiling
            c.pos.set(home.x, home.y, home.z);
            c.group.rotation.x += (Math.PI - c.group.rotation.x) * Math.min(1, dt * 5);
            c.group.rotation.z = Math.sin(elapsed * 1.3 + c.phase) * 0.12;
            c._mul = 0.04;
        }
    }
}

/* ------------------------------------------------------------
   66 — WYRM: cathedral legendary, slow serpentine vault patrol.
   ------------------------------------------------------------ */
function wyrm(c, dt, elapsed, playerPos, dp) {
    const home = c.roostHome;
    c._orbit = (c._orbit || 0) + dt * 0.42 * c.def.speed;
    const wob = Math.sin(elapsed * 0.8 + c.phase) * 0.8;
    const rr = (c.orbitR || 3.6) + wob;
    const tx = home.x + Math.cos(c._orbit) * rr;
    const tz = home.z + Math.sin(c._orbit) * rr;
    c.heading = Math.atan2(tz - c.pos.z, tx - c.pos.x);
    flyStep(c, dt, 1.0, c.def.hover, Math.sin(elapsed * 0.9 + c.phase) * 0.4);
    updateLegendaryPresence(c, dt, elapsed, playerPos); // aura motes + presence pulse + sting
}

/* ------------------------------------------------------------
   67 — BLIND: slow eyeless creep; freeze + tremble when sensed;
   startle-dart when a ball lands nearby (scaredUntil).
   ------------------------------------------------------------ */
function blind(c, dt, elapsed, playerPos, dp) {
    let mul;
    if (c.scaredUntil > elapsed) {                    // startled — brief blind bolt
        if (Math.random() < 0.12) c.heading += (Math.random() * 2 - 1) * 2.0;
        mul = 2.0;
    } else if (dp < 3.0) {                             // senses the player close: freeze + shiver
        mul = 0;
        c.group.rotation.z = Math.sin(elapsed * 22) * 0.05;
    } else {
        if (Math.random() < 0.02) c.heading += (Math.random() * 2 - 1) * 1.2;
        c.group.rotation.z = 0;
        mul = 1;
    }
    walkStep(c, dt, mul, 0);
}

/* ------------------------------------------------------------
   68 — SCHOOL: glowfish shoal darting inside a cave water pool.
   ------------------------------------------------------------ */
function school(c, dt, elapsed, playerPos, dp) {
    const pool = c.poolRef;
    if (Math.random() < 0.05) c.heading += (Math.random() * 2 - 1) * 2.2;
    let mul = 1.0;
    const dcx = c.pos.x - pool.x, dcz = c.pos.z - pool.z;
    if (Math.hypot(dcx, dcz) > pool.r * 0.7) c.heading = Math.atan2(pool.z - c.pos.z, pool.x - c.pos.x) + (Math.random() - 0.5) * 0.6;
    if (dp < 4.5 && playerPos) { c.heading = Math.atan2(c.pos.z - playerPos.z, c.pos.x - playerPos.x); mul = 1.9; } // flee dart
    const spd = WS * c.def.speed * mul;
    const nx = c.pos.x + Math.cos(c.heading) * spd * dt;
    const nz = c.pos.z + Math.sin(c.heading) * spd * dt;
    if (isWaterAt(nx, nz, -0.3)) { c.pos.x = nx; c.pos.z = nz; }
    else c.heading += Math.PI * (0.7 + Math.random() * 0.6);
    // hard pool containment (never let a shoal fish leave its basin)
    const ex = c.pos.x - pool.x, ez = c.pos.z - pool.z, ed = Math.hypot(ex, ez);
    if (ed > pool.r - 0.2) { const k = (pool.r - 0.2) / ed; c.pos.x = pool.x + ex * k; c.pos.z = pool.z + ez * k; }
    c.pos.y = (pool.level != null ? pool.level : CONFIG.POND_WATER_LEVEL) - 0.02 + Math.sin(elapsed * 1.7 + c.phase) * 0.03;
    c.group.rotation.y = -c.heading + Math.PI / 2;
    c._mul = mul;
}

/* ------------------------------------------------------------
   69 — EMERGE: hides (retracts) under the lantern, out in the dark.
   ------------------------------------------------------------ */
function emerge(c, dt, elapsed, playerPos, dp) {
    const lit = litLevel(c, dp);
    if (c._hide == null) c._hide = lit > 0.4 ? 1 : 0;
    const target = lit > 0.35 ? 1 : 0;
    c._hide += (target - c._hide) * Math.min(1, dt * (target > c._hide ? 5 : 1.6));
    c.group.scale.setScalar(c.def.scale * (1 - c._hide * 0.72)); // shrink into a crevice
    let mul = 0;
    if (c._hide < 0.45) {
        if (Math.random() < 0.02) c.heading += (Math.random() * 2 - 1) * 1.4;
        mul = (c.scaredUntil > elapsed ? 1.6 : 0.9) * (1 - c._hide);
    }
    walkStep(c, dt, mul, 0);
}

/* ------------------------------------------------------------
   70 — SLEEP: slumbers until the player is loud/close, then BOLTS.
   ------------------------------------------------------------ */
function sleep(c, dt, elapsed, playerPos, dp) {
    if (c._awake && elapsed > c._calmAt && dp > 12) c._awake = false;
    const loud = state.projectiles.some(p => p.active);
    if (!c._awake && (dp < 4.5 || (loud && dp < 12))) {
        c._awake = true;
        c._calmAt = elapsed + 4.5 + Math.random() * 2;
        c.heading = playerPos ? Math.atan2(c.pos.z - playerPos.z, c.pos.x - playerPos.x) : Math.random() * Math.PI * 2;
    }
    let mul = 0;
    if (c._awake) {
        if (dp < 20 && playerPos) c.heading = Math.atan2(c.pos.z - playerPos.z, c.pos.x - playerPos.x);
        if (Math.random() < 0.08) c.heading += (Math.random() * 2 - 1) * 0.8;
        mul = 2.4;
        c.group.scale.setScalar(c.def.scale);
    } else {
        c.group.scale.setScalar(c.def.scale * (1 + Math.sin(elapsed * 0.9 + c.phase) * 0.02)); // slow breathing
    }
    walkStep(c, dt, mul, 0);
}

/* ------------------------------------------------------------
   71 — GUARD: territorial warden — charges intruders, holds its post.
   ------------------------------------------------------------ */
function guard(c, dt, elapsed, playerPos, dp) {
    const post = c.roostHome, TERR = c.guardR || 6.5;
    const dHome = Math.hypot(c.pos.x - post.x, c.pos.z - post.z);
    const inTerr = playerPos && Math.hypot(playerPos.x - post.x, playerPos.z - post.z) < TERR;
    let mul;
    if (inTerr && dp > 1.6) {                          // charge the intruder
        c.heading = Math.atan2(playerPos.z - c.pos.z, playerPos.x - c.pos.x);
        mul = 1.9;
    } else if (dHome > TERR) {                          // return to post
        c.heading = Math.atan2(post.z - c.pos.z, post.x - c.pos.x);
        mul = 1.3;
    } else {                                            // patrol a slow ring around the post
        c._patrol = (c._patrol || Math.random() * 6.283) + dt * 0.7;
        const tx = post.x + Math.cos(c._patrol) * TERR * 0.6, tz = post.z + Math.sin(c._patrol) * TERR * 0.6;
        c.heading = Math.atan2(tz - c.pos.z, tx - c.pos.x);
        mul = 0.7;
    }
    walkStep(c, dt, mul, 0);
}

/* ------------------------------------------------------------
   72 — SWARM: a tight gnat cloud milling + drifting (caught as one).
   ------------------------------------------------------------ */
function swarm(c, dt, elapsed, playerPos, dp) {
    if (Math.random() < 0.03) c.heading += (Math.random() * 2 - 1) * 1.2;
    let mul = 0.7;
    if (dp < 4 && playerPos) { c.heading = Math.atan2(c.pos.z - playerPos.z, c.pos.x - playerPos.x); mul = 1.4; }
    flyStep(c, dt, mul, c.def.hover, Math.sin(elapsed * 1.4 + c.phase) * 0.35);
}

/* ------------------------------------------------------------
   73 — LANTERN: moth drawn toward the lantern, veers off if too close.
   ------------------------------------------------------------ */
function lantern(c, dt, elapsed, playerPos, dp) {
    const lit = state.player && state.player.inCave;
    let mul;
    if (lit && dp > 1.6 && dp < 15 && playerPos) {     // moth to flame — fluttery spiral in
        c.heading = Math.atan2(playerPos.z - c.pos.z, playerPos.x - c.pos.x) + Math.sin(elapsed * 3 + c.phase) * 0.8;
        mul = 1.3;
    } else if (lit && dp <= 1.6 && playerPos) {        // too close — dart away
        c.heading = Math.atan2(c.pos.z - playerPos.z, c.pos.x - playerPos.x) + (Math.random() - 0.5);
        mul = 1.8;
    } else {                                           // dark drift
        if (Math.random() < 0.04) c.heading += (Math.random() * 2 - 1) * 1.5;
        mul = 0.6;
    }
    flyStep(c, dt, mul, c.def.hover, Math.sin(elapsed * 7.3 + c.phase) * 0.3);
}

/* ------------------------------------------------------------
   75 — SKITTER: wall/ceiling crawler — hugs the rock, climbs the vault.
   ------------------------------------------------------------ */
function skitter(c, dt, elapsed, playerPos, dp) {
    if (Math.random() < 0.03) c.heading += (Math.random() * 2 - 1) * 0.8;
    let mul = 1.0;
    if (dp < 3.5 && playerPos) { c.heading = Math.atan2(c.pos.z - playerPos.z, c.pos.x - playerPos.x); mul = 1.7; }
    const spd = WS * c.def.speed * mul;
    c.pos.x += Math.cos(c.heading) * spd * dt;
    c.pos.z += Math.sin(c.heading) * spd * dt;
    keepInCave(c);                                   // never crawl out a mouth onto the surface
    const cf = sampleCave(c.pos.x, c.pos.z);
    if (cf) {
        c.inCave = cf.lat < cf.hw;
        // climb parameter oscillates floor(0) <-> vault(1)
        c._climb += dt * 0.4 * c._climbDir;
        if (c._climb > 1) { c._climb = 1; c._climbDir = -1; }
        else if (c._climb < 0) { c._climb = 0; c._climbDir = 1; }
        // ride the wall: push out toward the rock (or clamp back in if past it)
        const targetLat = cf.hw - 0.12;
        const ox = c.pos.x - cf.projX, oz = c.pos.z - cf.projZ, ol = Math.hypot(ox, oz) || 1e-4;
        if (cf.lat > cf.hw) { latConfine(c, 0.05); }
        else if (cf.lat < targetLat) {
            const nl = Math.min(targetLat, cf.lat + spd * dt);
            c.pos.x = cf.projX + (ox / ol) * nl;
            c.pos.z = cf.projZ + (oz / ol) * nl;
        }
        const floorY = getGroundY(c.pos.x, c.pos.z);
        const ceil = caveCeilingAt(c.pos.x, c.pos.z);
        const top = isFinite(ceil) ? ceil - 0.2 : floorY + 2.2;
        c.pos.y = floorY + (top - floorY) * c._climb;
        c.group.rotation.x = c._climb * 1.4;           // tilt against the wall/ceiling
    } else {
        latConfine(c, 0.4);
        c.pos.y = getGroundY(c.pos.x, c.pos.z);
        c.group.rotation.x = 0;
    }
    c.group.rotation.y = -c.heading + Math.PI / 2 + (c.meta.face || 0);
    c._mul = mul;
}

/* ------------------------------------------------------------
   76 — ECHO: echo-locator, visible + catchable only while CALLING.
   ------------------------------------------------------------ */
function echo(c, dt, elapsed, playerPos, dp) {
    if (c._nextCall == null) { c._nextCall = elapsed + 0.6 + Math.random() * 2.5; c._callT = 0; c._vis = 0; }
    if (elapsed >= c._nextCall && c._callT <= 0) {
        c._callT = 1.5;
        c._nextCall = elapsed + 3.4 + Math.random() * 3.0;
        spawnParticleBurst(c.pos.x, c.pos.y + c.centerY, c.pos.z, c.def.particle, 12); // sonar ring
        if (dp < 30 && !state.isPaused) playEchoCall();
    }
    let calling = false;
    if (c._callT > 0) { c._callT -= dt; calling = c._callT > 0.2; }
    const target = calling ? 1 : 0;
    c._vis += (target - c._vis) * Math.min(1, dt * (target > c._vis ? 6 : 2.5));
    // fade by scale + toggle visibility; catchable (real hit radius) only while shown
    c.group.scale.setScalar(Math.max(0.001, c.def.scale * c._vis));
    c.group.visible = c._vis > 0.02;
    c.hitRadius = c._realHitR * (c._vis > 0.5 ? 1 : 0.03);
    if (Math.random() < 0.03) c.heading += (Math.random() * 2 - 1) * 1.2;
    flyStep(c, dt, calling ? 0.9 : 0.4, c.def.hover, Math.sin(elapsed * 1.3 + c.phase) * 0.25);
}

const HANDLERS = { roost, wyrm, blind, school, emerge, sleep, guard, swarm, lantern, skitter, echo };

/* ------------------------------------------------------------
   Entry point — behavior.js calls this for every `caveBehavior`
   creature. Returns true (always) so the standard path is skipped.
   ------------------------------------------------------------ */
export function updateCaveCreature(c, dt, elapsed, playerPos) {
    const def = c.def;
    // ---- activation gate: free when the player is elsewhere ----
    let dp = 1e6;
    if (playerPos) {
        const dx = c.pos.x - playerPos.x, dz = c.pos.z - playerPos.z;
        dp = Math.sqrt(dx * dx + dz * dz);
    }
    const active = state.player && (state.player.inCave || dp * dp < ACT2);
    if (!active) { c.group.visible = false; return true; }
    if (!c.group.visible && def.caveBehavior !== 'echo') c.group.visible = true;

    const h = HANDLERS[def.caveBehavior];
    if (h) h(c, dt, elapsed, playerPos, dp);

    // ---- shared tail: secondary animation + rare/legendary sparkle ----
    animateCreature(c, elapsed, Math.min(1, c._mul || 0), 0);
    if (def.sparkle && def.caveBehavior !== 'wyrm' && Math.random() < dt * 3) {
        spawnParticleBurst(
            c.pos.x + (Math.random() - 0.5) * 0.5,
            c.pos.y + c.centerY + Math.random() * 0.4,
            c.pos.z + (Math.random() - 0.5) * 0.5,
            def.particle, 1
        );
    }
    return true;
}
