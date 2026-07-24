/* ============================================================
   Creature Behavior — movement engine
   ------------------------------------------------------------
   Gaits / steering / reactions / specials (blink teleports, koi
   leaps, dive swoops), aerial altitude patterns, water
   containment for swimmers (pond AND river), water avoidance
   for walkers, plus the intelligence layer (smart.js) and the
   per-archetype animation (animate.js).
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state, reuse } from '../state.js';
import { getTerrainHeight, getGroundY, isWaterAt, riverTangent, riverSpan, riverPointAt, caveConfine, caveAt, caveCeilingAt } from '../heightfield.js';
import { collidesObstacle } from '../player.js';
import { spawnParticleBurst, spawnTrailMote, spawnWaterRipple } from '../particles.js';
import { animateCreature, resetPose } from './animate.js';
import { creatureLod } from '../lod.js';
import { updateDodge, coverHeading, keepDistance, alarmFrom, updateLegendaryPresence } from './smart.js';
import { updateCaveCreature } from './cave-behavior.js';
import { zoneAt } from '../zones/zones.js';

// Is the player camera looking (roughly) at this creature?
function playerLookingAt(c) {
    if (!state.camera) return false;
    state.camera.getWorldDirection(reuse.tmpVec3b);
    reuse.tmpVec3.set(c.pos.x, c.pos.y + c.centerY, c.pos.z)
        .sub(state.camera.position).normalize();
    return reuse.tmpVec3.dot(reuse.tmpVec3b) > 0.92;
}

// Projectile impacts frighten nearby skittish/panicky creatures; alarmed
// species (smart.js) then relay the panic to their kin.
export function scareCreatures(x, z) {
    const nowS = performance.now() / 1000;
    for (const c of state.creatures) {
        if (!c.alive) continue;
        const dx = c.pos.x - x, dz = c.pos.z - z;
        if (dx * dx + dz * dz < 12.25) {
            c.scaredUntil = nowS + 1.3;
            alarmFrom(c, nowS);
        }
    }
}

// Ghost blink: shrink out, teleport a few meters, grow back in
function startBlink(c, elapsed) {
    c.blinkT = 0.5;
    c.blinkJumped = false;
    c.blinkCd = elapsed + 2.5;
}

function updateBlink(c, dt) {
    c.blinkT -= dt;
    if (!c.blinkJumped && c.blinkT <= 0.25) {
        c.blinkJumped = true;
        const range = (c.def.special && c.def.special.range) || 4;
        const halfArena = CONFIG.ARENA_SIZE / 2 - CONFIG.CREATURE_BOUNDARY_MARGIN;
        spawnParticleBurst(c.pos.x, c.pos.y + c.centerY, c.pos.z, c.def.particle, 4);
        for (let tries = 0; tries < 12; tries++) {
            const a = Math.random() * Math.PI * 2;
            const d = 2.5 + Math.random() * range;
            const nx = THREE.MathUtils.clamp(c.pos.x + Math.cos(a) * d, -halfArena, halfArena);
            const nz = THREE.MathUtils.clamp(c.pos.z + Math.sin(a) * d, -halfArena, halfArena);
            if (!c.def.hover && isWaterAt(nx, nz, 1.2)) continue;
            c.pos.x = nx; c.pos.z = nz;
            break;
        }
        const groundY = Math.max(getGroundY(c.pos.x, c.pos.z), CONFIG.POND_WATER_LEVEL);
        c.pos.y = c.def.hover ? groundY + c.def.hover : getGroundY(c.pos.x, c.pos.z);
        c.inCave = !c.def.aquatic && !!caveAt(c.pos.x, c.pos.z); // blink may cross a wall
        spawnParticleBurst(c.pos.x, c.pos.y + c.centerY, c.pos.z, c.def.particle, 4);
    }
    const sc = c.blinkT > 0.25 ? (c.blinkT - 0.25) / 0.25 : 1 - Math.max(0, c.blinkT) / 0.25;
    c.group.scale.setScalar(Math.max(0.02, c.def.scale * sc));
    if (c.blinkT <= 0) {
        c.blinkT = 0;
        c.group.scale.setScalar(c.def.scale);
    }
}

export function updateCreatures(dt, elapsed) {
    const frozen = state.isPaused || state.isCaptchaSolved;
    const halfArena = CONFIG.ARENA_SIZE / 2 - CONFIG.CREATURE_BOUNDARY_MARGIN;
    const playerPos = state.controls ? state.controls.getObject().position : null;
    state.creatureFrame = ((state.creatureFrame || 0) + 1) | 0;

    for (let ci = 0; ci < state.creatures.length; ci++) {
        const c = state.creatures[ci];

        // creatures in a catch sequence are driven entirely by capture.js
        if (c.capturing) continue;
        if (!c.alive || frozen) continue;

        const def = c.def;

        // Phase 2j: cave-exclusive types run their own unique movement engine
        // (roost/wyrm/blind/school/emerge/sleep/guard/swarm/lantern/skitter/echo).
        // It fully drives + confines + grounds the creature and gates it on player
        // proximity (free when the player is out in the open), then returns true.
        if (def.caveBehavior) { updateCaveCreature(c, dt, elapsed, playerPos); continue; }

        const g = def.gait;
        const s = def.steer;
        const r = def.react;
        const p = c.pos;

        // ---- blink teleport in progress ----
        if (c.blinkT > 0) { updateBlink(c, dt); continue; }
        // periodic blink special (Misty Ghost)
        if (def.special && def.special.t === 'blink' && def.special.period > 0 && elapsed > c.nextSpecial) {
            c.nextSpecial = elapsed + def.special.period * (0.7 + Math.random() * 0.6);
            startBlink(c, elapsed);
            continue;
        }

        // ---- gait: speed pulse over time ----
        let mul = 1;
        let hopK = 0;
        if (g.t === 'hop') {
            const cyc = 1 / g.rate;
            const total = cyc + g.pause;
            const tt = (elapsed + c.phase) % total;
            if (tt < cyc) { hopK = Math.sin((tt / cyc) * Math.PI); mul = 1.6; }
            else mul = 0;
        } else if (g.t === 'stopgo' || g.t === 'dash') {
            c.gaitT -= dt;
            if (c.gaitT <= 0) {
                c.gaitOn = !c.gaitOn;
                c.gaitT = (c.gaitOn ? g.on : g.off) * (0.7 + Math.random() * 0.6);
                if (c.gaitOn && g.t === 'dash') c.heading = Math.random() * Math.PI * 2;
            }
            mul = c.gaitOn ? g.mul : 0;
        } else if (g.t === 'pulse') {
            const k = Math.max(0, Math.sin(elapsed * g.freq * Math.PI + c.phase));
            mul = Math.pow(k, 1.5) * g.mul;
            c.pulseK = Math.pow(k, 1.5);
        } else {
            mul = g.mul || 1;
        }

        // ---- koi leap special: launch, arc, splash back in ----
        c.leapK = 0;
        let leapY = 0;
        if (def.special && def.special.t === 'leap') {
            if (c.leapT > 0) {
                c.leapT -= dt;
                const k = 1 - Math.max(0, c.leapT) / def.special.dur;
                c.leapK = k;
                leapY = Math.sin(k * Math.PI) * def.special.h;
                mul = Math.max(mul, 1.7); // carries forward through the arc
                if (c.leapT <= 0) { // re-entry splash
                    spawnWaterRipple(p.x, p.z);
                    spawnParticleBurst(p.x, CONFIG.POND_WATER_LEVEL + 0.08, p.z, 0xbfe8ff, 8);
                }
            } else if (elapsed > c.nextSpecial) {
                c.nextSpecial = elapsed + def.special.period * (0.6 + Math.random() * 0.8);
                if (isWaterAt(p.x, p.z, -1.0)) { // only leap from open water
                    c.leapT = def.special.dur;
                    spawnWaterRipple(p.x, p.z);
                    spawnParticleBurst(p.x, CONFIG.POND_WATER_LEVEL + 0.08, p.z, 0xbfe8ff, 6);
                }
            }
        }

        // ---- steering: heading evolution ----
        if (s.t === 'wander') {
            if (Math.random() < s.jit) c.heading += (Math.random() * 2 - 1) * s.turn;
        } else if (s.t === 'zigzag') {
            if (Math.random() < 0.02) c.heading += (Math.random() * 2 - 1) * 1.2;
        } else if (s.t === 'sine') {
            c.heading += Math.sin(elapsed * s.freq + c.phase) * s.amp * dt;
        } else if (s.t === 'spiral') {
            c.heading += s.rate * dt;
        } else if (s.t === 'orbit' || s.t === 'ring') {
            const hx = s.t === 'ring' ? 0 : c.home.x;
            const hz = s.t === 'ring' ? 0 : c.home.z;
            const ox = p.x - hx, oz = p.z - hz;
            const od = Math.sqrt(ox * ox + oz * oz) || 0.001;
            const err = THREE.MathUtils.clamp((od - s.r) * 0.6, -1, 1);
            c.heading = Math.atan2(oz, ox) + Math.PI / 2 + err;
        } else if (s.t === 'channel') {
            // river patrol: swim the channel tangent (either way), gently
            // pulled to the centerline; turn around at the falls / mid-pond
            const tan = riverTangent();
            const span = riverSpan();
            const u = p.x * tan.x + p.z * tan.z;
            if (u > span.uMax) c.swimDir = -1;
            else if (u < span.uMin - 2.5) c.swimDir = 1;
            else if (Math.random() < 0.0035) c.swimDir *= -1; // occasional whim
            const mid = riverPointAt(Math.max(u, span.uMin + 0.5), 0);
            const nx = -tan.z, nz = tan.x;
            const latErr = THREE.MathUtils.clamp(((p.x - mid.x) * nx + (p.z - mid.z) * nz) * 0.55, -1, 1);
            c.heading = Math.atan2(tan.z * c.swimDir - nz * latErr, tan.x * c.swimDir - nx * latErr);
        } else if (s.t === 'waypoint') {
            if (c.restT > 0) {
                c.restT -= dt;
                mul = 0;
            } else {
                if (!c.wayActive) {
                    // dart tree-to-tree when trees exist, else roam wide
                    const trees = state.treeList;
                    if (trees && trees.length && Math.random() < 0.75) {
                        const t = trees[Math.floor(Math.random() * trees.length)];
                        c.wayX = t.x + (Math.random() - 0.5) * 3;
                        c.wayZ = t.z + (Math.random() - 0.5) * 3;
                    } else {
                        c.wayX = (Math.random() * 2 - 1) * (halfArena - 1);
                        c.wayZ = (Math.random() * 2 - 1) * (halfArena - 1);
                    }
                    // ground types never pick waypoints in the water network
                    if (!def.hover && isWaterAt(c.wayX, c.wayZ, 1.5)) continue;
                    c.wayActive = true;
                }
                const dxw = c.wayX - p.x, dzw = c.wayZ - p.z;
                if (dxw * dxw + dzw * dzw < 0.4) {
                    c.wayActive = false;
                    c.restT = s.pause * (0.6 + Math.random() * 0.8);
                } else {
                    c.heading = Math.atan2(dzw, dxw);
                }
            }
        }
        // zigzag weave rides on top of the base heading (movement + facing)
        let headingMove = c.heading;
        if (s.t === 'zigzag') headingMove += Math.sin(elapsed * s.freq + c.phase) * s.amp;

        // ---- reaction to the player ----
        c.taunting = false;
        c.lookFrozen = false;
        let fleeing = false;
        let dp = 1e9;
        if (playerPos) {
            const dxp = p.x - playerPos.x, dzp = p.z - playerPos.z;
            dp = Math.sqrt(dxp * dxp + dzp * dzp);
            if (r.t === 'flee') {
                if (dp < r.r) {
                    c.heading = Math.atan2(dzp, dxp);
                    headingMove = c.heading;
                    mul = Math.max(mul, 1) * (r.boost || 1.6);
                    fleeing = true;
                }
            } else if (r.t === 'curious') {
                if (dp < r.near) { // too close — bolt!
                    c.heading = Math.atan2(dzp, dxp);
                    headingMove = c.heading;
                    mul = Math.max(mul, 1) * 1.8;
                    fleeing = true;
                } else if (dp < r.far) { // sidle slowly toward the player
                    c.heading = Math.atan2(-dzp, -dxp);
                    headingMove = c.heading;
                    mul = Math.min(mul, 0.55);
                }
            } else if (r.t === 'freeze') {
                if (dp < r.r && playerLookingAt(c)) { mul = 0; c.lookFrozen = true; }
            } else if (r.t === 'taunt') {
                if (dp > r.r) { mul = 0; c.taunting = true; }
            } else if (r.t === 'hide') {
                if (dp < r.r) { mul = 0; c.hideK = Math.min(1, c.hideK + dt * 4); }
                else c.hideK = Math.max(0, c.hideK - dt * 2);
            } else if (r.t === 'blinkflee') {
                if (dp < r.r && elapsed > c.blinkCd) { startBlink(c, elapsed); continue; }
            }
            // panic burst after a projectile lands nearby (skittish types too)
            if (c.scaredUntil > elapsed && (r.t === 'panic' || r.t === 'flee')) {
                mul = Math.max(mul, 1) * 2.1;
                if (Math.random() < 0.25) c.heading += (Math.random() * 2 - 1) * 2.4;
                headingMove = c.heading;
                fleeing = true;
            }
        }

        // ---- items 313/318: "noticed you" alert tell ----
        // Smoothed 0..1 fed into animateCreature for a quick ear-perk/eye-widen
        // BEFORE a creature actually bolts — from the player closing inside
        // CAPTURE_RANGE (item 313), or from a skittish flinch when another
        // creature wanders very close (item 318's ambient ecosystem touch).
        // The peer scan is throttled (every 4th frame) and only walks the
        // REST of the array per creature, so it's a bounded, cheap O(n^2/4)
        // math loop — no new geometry/draw calls involved.
        let alertTarget = (playerPos && dp < CONFIG.CAPTURE_RANGE && !fleeing) ? 1 : 0;
        if (!alertTarget && (state.creatureFrame + ci) % 4 === 0) {
            for (let oj = ci + 1; oj < state.creatures.length; oj++) {
                const o = state.creatures[oj];
                if (!o.alive || o.capturing) continue;
                const odx = p.x - o.pos.x, odz = p.z - o.pos.z;
                if (odx * odx + odz * odz < 1.7) {
                    alertTarget = 1;
                    o.alertK = Math.max(o.alertK || 0, 0.6);
                    break;
                }
            }
        }
        c.alertK = (c.alertK || 0) + (alertTarget - (c.alertK || 0)) * Math.min(1, dt * 5);

        // ---- intelligence layer (smart.js): dodge > cover > range ----
        if (def.int) {
            if (updateDodge(c, elapsed)) {
                headingMove = c.heading;
                mul = Math.max(mul, 2.2 + (def.int.dodge || 0));
            } else if (playerPos) {
                if (def.int.cover && fleeing) {
                    const ch = coverHeading(c, playerPos, elapsed);
                    if (ch !== null) { c.heading = ch; headingMove = ch; }
                } else if (def.int.keep && !fleeing && c.scaredUntil < elapsed) {
                    const kd = keepDistance(c, dp, playerPos);
                    if (kd) {
                        c.heading = kd.heading;
                        headingMove = kd.heading;
                        mul = Math.max(mul, kd.mul);
                    }
                }
            }
        }

        // breakout adrenaline — freshly escaped creatures bolt, whatever
        // their usual temperament (capture.js sets breakoutUntil)
        if (c.breakoutUntil > elapsed) {
            mul = Math.max(mul, 1) * CONFIG.BREAKOUT_SPEED_MUL;
            if (Math.random() < 0.15) c.heading += (Math.random() * 2 - 1) * 2.2;
            headingMove = c.heading;
        }

        // ---- environmental steering: water network & arena walls ----
        if (def.aquatic) {
            // swimmers stay in the water (pond AND river): probe ahead, then
            // try left/right, else turn around
            const px2 = p.x + Math.cos(headingMove) * 0.9;
            const pz2 = p.z + Math.sin(headingMove) * 0.9;
            if (!isWaterAt(px2, pz2, -0.5)) {
                const lft = headingMove + Math.PI / 2;
                const rgt = headingMove - Math.PI / 2;
                if (isWaterAt(p.x + Math.cos(lft) * 1.1, p.z + Math.sin(lft) * 1.1, -0.5)) c.heading = lft;
                else if (isWaterAt(p.x + Math.cos(rgt) * 1.1, p.z + Math.sin(rgt) * 1.1, -0.5)) c.heading = rgt;
                else c.heading = headingMove + Math.PI + (Math.random() - 0.5) * 0.6;
                headingMove = c.heading;
            }
        } else if (!def.hover) {
            // land walkers never wade: steer along the driest probe
            const px2 = p.x + Math.cos(headingMove) * 1.1;
            const pz2 = p.z + Math.sin(headingMove) * 1.1;
            if (isWaterAt(px2, pz2, 1.0)) {
                const lft = headingMove + Math.PI / 2;
                const rgt = headingMove - Math.PI / 2;
                if (!isWaterAt(p.x + Math.cos(lft) * 1.4, p.z + Math.sin(lft) * 1.4, 1.0)) c.heading = lft;
                else if (!isWaterAt(p.x + Math.cos(rgt) * 1.4, p.z + Math.sin(rgt) * 1.4, 1.0)) c.heading = rgt;
                else c.heading = headingMove + Math.PI;
                headingMove = c.heading;
            }
        }
        if (Math.abs(p.x) > halfArena - 1 || Math.abs(p.z) > halfArena - 1) {
            c.heading = Math.atan2(-p.z, -p.x);
            headingMove = c.heading;
        }

        // ---- move ----
        if (mul > 0.001) {
            const spd = CONFIG.CREATURE_WANDER_SPEED * def.speed * mul;
            const nx = p.x + Math.cos(headingMove) * spd * dt;
            const nz = p.z + Math.sin(headingMove) * spd * dt;
            const bodyR = Math.min(1.2, c.hitRadius); // big bodies shoulder wider
            if (def.hover || def.aquatic || !collidesObstacle(nx, nz, bodyR)) {
                p.x = nx; p.z = nz;
            } else {
                c.heading += Math.PI / 2;
            }
            p.x = THREE.MathUtils.clamp(p.x, -halfArena, halfArena);
            p.z = THREE.MathUtils.clamp(p.z, -halfArena, halfArena);
            if (def.aquatic && c.leapK === 0 && !isWaterAt(p.x, p.z, -0.4)) {
                // hard containment: never beach a swimmer
                p.x -= Math.cos(headingMove) * spd * dt;
                p.z -= Math.sin(headingMove) * spd * dt;
                c.heading += Math.PI * (0.75 + Math.random() * 0.5);
            }
            // cave walls: dwellers inside slide along the rock (and turn along
            // the passage), outsiders can't wander in through a wall
            if (!def.aquatic) {
                const conf = caveConfine(p.x, p.z, Math.min(0.8, c.hitRadius), c.inCave);
                if (conf) {
                    if (conf.x !== p.x || conf.z !== p.z) {
                        p.x = conf.x; p.z = conf.z;
                        c.heading += (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 3);
                    }
                    c.inCave = conf.inside;
                } else {
                    c.inCave = false;
                }
            }
        }

        // ---- vertical placement ----
        if (def.aquatic) {
            // float on the water surface with a gentle bob (+ leap arcs)
            p.y = CONFIG.POND_WATER_LEVEL - 0.02 + Math.sin(elapsed * 1.7 + c.phase) * 0.03 + leapY;
        } else if (def.hover) {
            let hov = def.hover;
            if (def.flight) { // per-type aerial altitude patterns
                const f = def.flight.t;
                if (f === 'dart') {           // dragonfly: hold, then snap to a new level
                    if (c.lastGaitOn !== c.gaitOn) { c.lastGaitOn = c.gaitOn; c.dartAlt = 0.55 + Math.random() * 0.95; }
                    c.altK += (c.dartAlt - c.altK) * Math.min(1, dt * 5);
                    hov *= c.altK;
                } else if (f === 'glide') {   // owl: high perch line, swooping low mid-flight
                    hov *= 0.8 + 0.3 * Math.sin(elapsed * 0.5 + c.phase);
                    hov -= Math.min(mul, 1) * 0.9;
                } else if (f === 'jitter') {  // bat: fluttery double-sine wobble
                    hov += Math.sin(elapsed * 7.3 + c.phase) * 0.4 + Math.sin(elapsed * 13.7 + c.phase * 2) * 0.25;
                } else if (f === 'hoverdash') { // hummingbird: locked hover, pops up to dash
                    hov += (c.gaitOn ? 0.55 : 0) + Math.sin(elapsed * 21 + c.phase) * 0.07;
                } else if (f === 'soar') {    // phoenix: grand slow rise and fall
                    hov += Math.sin(elapsed * 0.4 + c.phase) * 1.0;
                }
            }
            if (def.special && def.special.t === 'dive') { // swooping dives
                hov *= 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(elapsed * def.special.freq * Math.PI * 2 + c.phase));
            }
            const groundY = Math.max(getGroundY(p.x, p.z), CONFIG.POND_WATER_LEVEL);
            p.y = groundY + Math.max(0.4, hov) + Math.sin(elapsed * 1.6 + c.phase) * 0.18;
            // cave-flying types (bats, ghosts) stay under the vault (never forced
            // below the floor if the ceiling sample resolves an overlapping passage)
            if (c.inCave) p.y = Math.min(p.y, Math.max(caveCeilingAt(p.x, p.z) - 0.4, groundY + 0.3));
        } else {
            const hopY = g.t === 'hop' ? hopK * g.h * def.scale : 0;
            p.y = getGroundY(p.x, p.z) + hopY; // rendered voxel-surface height
        }

        // items 309/325: a dabbling duck ("dip cycle" — see animate.js's duck
        // case) is briefly head/tail-under the surface; a ripple + a few pale
        // bubbles right as it tips over is the "splash-down" / water-response
        // read for an amphibious surface swimmer, without any new geometry.
        if (def.plan === 'duck' && def.aquatic) {
            const dabbling = ((elapsed * 0.14 + c.phase) % 1) < 0.12;
            if (dabbling && !c._dabbling) {
                spawnWaterRipple(p.x, p.z);
                spawnParticleBurst(p.x, CONFIG.POND_WATER_LEVEL + 0.05, p.z, 0xdff2ff, 4);
            }
            c._dabbling = dabbling;
        }

        // ---- facing ----
        c.group.rotation.y = -headingMove + Math.PI / 2 + (c.meta.face || 0);

        // ---- secondary animation (distance LOD, lod.js item 344): amortized
        //      beyond the anim ring, dropped past the simplify ring; the same
        //      call drops the creature's shadow past the tier's shadow ring ----
        const lc = playerPos ? creatureLod(c, p.distanceToSquared(playerPos)) : 0;
        if (lc === 2) {
            // item 321: settle into a clean rest pose ONCE on the transition
            // into the simplified tier, instead of freezing on whatever
            // mid-stride/mid-lean frame it happened to cross the ring on.
            if (!c._lodSimplified) { c._lodSimplified = true; resetPose(c); }
        } else {
            c._lodSimplified = false;
            if (lc === 0 || (lc === 1 && (state.creatureFrame + ci) % 3 === 0)) {
                animateCreature(c, elapsed, mul, hopK, c.alertK || 0);
            }
        }

        // item 316: a quick "shake it off" body wiggle right as a breakout
        // begins — distinct from the sustained BREAKOUT_PANIC_TIME bolt above.
        // Additive (not overwritten by whatever the per-plan animation just
        // set group.rotation.z to), so it reads on every archetype.
        if (c.breakoutUntil > elapsed) {
            const sinceBreak = CONFIG.BREAKOUT_PANIC_TIME - (c.breakoutUntil - elapsed);
            if (sinceBreak >= 0 && sinceBreak < 0.35) {
                c.group.rotation.z += Math.sin(sinceBreak * 40) * 0.22 * (1 - sinceBreak / 0.35);
            }
        }

        // rare/legendary sparkle trail (bloom catches these motes)
        if (def.sparkle && Math.random() < dt * 3) {
            spawnParticleBurst(
                p.x + (Math.random() - 0.5) * 0.5,
                p.y + c.centerY + Math.random() * 0.4,
                p.z + (Math.random() - 0.5) * 0.5,
                def.particle, 1
            );
        } else if (def.tier === 'uncommon' || def.tier === 'rare') {
            // item 303: a faint ambient tier tell for creatures that AREN'T
            // hand-flagged `sparkle` — so uncommon/rare read at a glance
            // before the targeting UI confirms it. Legendaries already get
            // the richer aura in updateLegendaryPresence below.
            const rate = CONFIG.CREATURE_TIER_TRAIL_RATE[def.tier] || 0;
            if (rate && Math.random() < dt * rate) {
                spawnTrailMote(p.x, p.y + c.centerY, p.z, def.particle);
            }
        }
        // items 312/320: ground-based creatures kick up a puff colored to
        // their OWN species (the bestiary's `particle` field is already
        // theme/zone-matched per species) when moving fast — dashing/fleeing
        // reads as kicking up the local ground, not just running in place.
        if (!def.hover && !def.aquatic && state.qualityLevel !== 'low' && mul > 1.3 && Math.random() < dt * 5) {
            spawnTrailMote(
                p.x - Math.cos(headingMove) * 0.25,
                p.y + 0.05,
                p.z - Math.sin(headingMove) * 0.25,
                def.particle
            );
        }
        // item 308: Frostwing puffs visible breath-vapor while over a cold zone
        if (def.id === 'frostwing' && Math.random() < dt * 2.2) {
            const z = zoneAt(p.x, p.z);
            if (z && (z.id === 'ice' || z.id === 'snow' || z.id === 'alpine')) {
                spawnTrailMote(
                    p.x + Math.cos(headingMove) * 0.3,
                    p.y + c.centerY + 0.1,
                    p.z + Math.sin(headingMove) * 0.3,
                    0xeaf7ff
                );
            }
        }
        // phoenix ember wake trailing behind the flight line
        if (def.ember && state.qualityLevel !== 'low' && Math.random() < dt * 16) {
            spawnTrailMote(
                p.x - Math.cos(headingMove) * 0.7 + (Math.random() - 0.5) * 0.5,
                p.y + c.centerY * 0.8 + (Math.random() - 0.5) * 0.4,
                p.z - Math.sin(headingMove) * 0.7 + (Math.random() - 0.5) * 0.5,
                Math.random() < 0.5 ? 0xff7a1f : 0xffc21f
            );
        }
        // legendary presence: aura motes, size pulse, proximity sting
        if (def.tier === 'legendary') {
            updateLegendaryPresence(c, dt, elapsed, playerPos);
        }
    }
}
