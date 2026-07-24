/* ============================================================
   Throwing Projectiles (Ball Flight & Impact)
   ------------------------------------------------------------
   A click winds up the viewmodel; at release the detailed
   voxel capture ball (shared asset from ball.js) leaves the
   hand tumbling end-over-end with a sparkle trail + soft glow.
   Impacts keep the original physics: wall/ground dust-thump,
   pond splash-and-ripple. Connecting with a living creature
   rolls the capture chance (tier base + back bonus) and hands
   the ball over to the catch sequence in capture.js.

   Backlog items folded in here (world-graphics-improvements.md):
     247/343  a linear motion-blur streak + a spin-blur disc trail
              the ball in flight, on top of the existing sparkle motes.
     248/262  ground-miss dust is tinted by the local zone surface
              (snow/desert/dirt) and reads as a dulled "fizzle" burst,
              distinct from the golden capture-success burst in capture.js.
     254      water-splash particle count scales with impact speed
              (a stand-in for "fall height" on the object this file owns).
     338/347  a cave-wall/ceiling ricochet gets its own energy-scaled
              spark burst and tints the ongoing trail "hot", reading
              distinct from a clean open-air throw.
     344      the sparkle trail reddens as BALL_DESPAWN_TIME approaches.
     350      a capture roll that the CAPTURE_MAX_CHANCE ceiling actually
              clipped gets a distinct quick "sting" flash on connect.
     351      trail density ramps with proximity to the live targeting
              hover (state.targetHover), rewarding a well-aimed throw.
     352      a ground decal (scorch/dust/splash ring) marks a miss's
              final rest point, tinted per surface.
     353      a big ricochet chain (hits CAVE_BALL_MAX_BOUNCES) gives a
              subtle camera-roll screen-shake to sell the trick shot.
     354      a throw that grazes just outside the catch radius gets a
              small "whiff" spark instead of nothing.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state, reuse } from './state.js';
import { getGroundY, isWaterAt, getWaterLevelAt } from './heightfield.js';
import { scareCreatures } from './creatures/behavior.js';
import { spawnParticleBurst, spawnWaterRipple, spawnTrailMote, spawnGroundDecal } from './particles.js';
import { playThrow, playThump, playSplash } from './audio.js';
import { makeCaptureBall, makeBallGlowSprite, makeFlashSprite, makeBallStreak, makeSpinBlurRing, removeBall } from './ball.js';
import { requestThrow } from './viewmodel.js';
import { beginCatchSequence } from './capture.js';
import { showBackBonusFlourish } from './targeting.js';
import { caveRicochet, caveThrowUpAngle, tunnelBackDot, caveCaptureBonus } from './caves/caves-gameplay.js';
import { zoneAt } from './zones/zones.js';
import { triggerScreenShake, updateScreenShake } from './camera-shake.js';

// Scratch objects — reused every frame so streak/ring orientation never allocates.
const _unitZ = new THREE.Vector3(0, 0, 1);
const _dirScratch = new THREE.Vector3();
const _lerpColA = new THREE.Color();
const _lerpColB = new THREE.Color();

function lerpHexColor(hexA, hexB, t) {
    _lerpColA.set(hexA);
    _lerpColB.set(hexB);
    _lerpColA.lerp(_lerpColB, t);
    return _lerpColA.getHex();
}

export function tryCapture() {
    if (state.isCaptchaSolved || state.isPaused) return;
    if (!state.controls.isLocked) return;
    // the viewmodel gates throws (empty hand during cooldown) and calls
    // back at the top of its swing so the ball leaves with the hand
    requestThrow(spawnBall);
}

function spawnBall() {
    // re-check guards: the wind-up takes ~0.1s and the game may have paused
    if (state.isCaptchaSolved || state.isPaused || !state.controls.isLocked) return;

    // Phase 2k item 83: throw the nicer grotto ball once it's been found
    const ball = makeCaptureBall(state.caveBall ? { variant: 'cave' } : undefined);
    if (state.qualityLevel !== 'low') ball.add(makeBallGlowSprite());

    // Throwing offsets from camera — from the hand side, slightly low-right
    state.camera.getWorldPosition(reuse.rayOrigin);
    state.camera.getWorldDirection(reuse.rayDir);
    reuse.tmpVec3.set(-reuse.rayDir.z, 0, reuse.rayDir.x).normalize(); // camera-right
    reuse.rayOrigin.addScaledVector(reuse.rayDir, 0.6);
    reuse.rayOrigin.addScaledVector(reuse.tmpVec3, 0.16);
    reuse.rayOrigin.y -= 0.08;
    ball.position.copy(reuse.rayOrigin);
    state.scene.add(ball);

    // Initial velocity vector
    const velocity = reuse.rayDir.clone().multiplyScalar(CONFIG.BALL_SPEED);
    // Phase 2k item 80: flatten the lob under a low cave ceiling so throws don't
    // bonk the vault (no-op outdoors / under a tall vault).
    velocity.y += caveThrowUpAngle(reuse.rayOrigin.x, reuse.rayOrigin.z, reuse.rayOrigin.y, CONFIG.BALL_UP_ANGLE);

    // end-over-end tumble axis: perpendicular to the throw direction
    const spinAxis = new THREE.Vector3(0, 1, 0).cross(reuse.rayDir).normalize();
    if (spinAxis.lengthSq() < 0.01) spinAxis.set(1, 0, 0);

    // items 247/343: a linear motion-blur streak + a spin-blur disc, tracked as
    // separate scene objects (not ball children) so they never tag along into
    // the catch sequence when the ball hands off to capture.js.
    let streak = null, ring = null;
    if (state.qualityLevel !== 'low') {
        streak = makeBallStreak(state.caveBall ? 0x9ffff0 : 0xffcf8a);
        ring = makeSpinBlurRing(state.caveBall ? 0xd8fffa : 0xfff3d0);
        state.scene.add(streak);
        state.scene.add(ring);
    }

    state.projectiles.push({
        mesh: ball,
        pos: ball.position,
        vel: velocity,
        spinAxis,
        trailAcc: 0,
        active: true,
        age: 0,
        radius: CONFIG.BALL_RADIUS,
        bounces: 0,             // Phase 2k item 79: cave wall/ceiling ricochet count
        streak, ring,
        ringSpin: 0,
        hot: false,             // item 347: tints trail once this ball has ricocheted
        whiffed: false,         // item 354: at most one close-whiff spark per throw
    });
    playThrow();
}

// items 247/343: dispose the per-ball streak/ring the moment its flight ends —
// whether by despawn, wall/ground/water impact, or hand-off to the catch
// sequence (which must never inherit flight-only VFX).
function disposeProjectileFx(p) {
    if (p.streak) {
        if (state.scene) state.scene.remove(p.streak);
        try { p.streak.material.dispose(); } catch (e) {}
        p.streak = null;
    }
    if (p.ring) {
        if (state.scene) state.scene.remove(p.ring);
        try { p.ring.material.dispose(); } catch (e) {}
        p.ring = null;
    }
}

// items 248/262/352 — surface read at a ground-miss point: snow/ice zones puff
// pale and soft, deserts kick up sandy dust, everything else takes its tint
// from the local zone's dirt palette. Kept a plain lookup (no new state) so it
// costs one zoneAt() call per impact, not per frame.
function surfaceImpactColors(x, z) {
    const zone = zoneAt(x, z);
    if (!zone) return { dust: 0xdddddd, decal: 0x999999 };
    if (zone.id === 'ice' || zone.id === 'snow' || (zone.particle && zone.particle.kind === 'snow')) {
        return { dust: 0xf5faff, decal: 0xdcebf7 };
    }
    if (zone.id === 'desert') return { dust: 0xe0c890, decal: 0xc8a860 };
    return { dust: zone.dirt || 0xcccccc, decal: zone.dirt || 0x8a8a8a };
}

export function updateProjectiles(dt) {
    updateScreenShake(dt); // item 353 (runs even with zero projectiles, to decay)

    for (const p of state.projectiles) {
        if (!p.active) continue;

        // Integrate in substeps: a ball covers ~0.4u per 60fps frame (more on
        // slow frames), enough to tunnel straight through a small body —
        // sub-sampling keeps every collision window hit at any framerate
        const travel = p.vel.length() * dt;
        const steps = Math.max(1, Math.min(8, Math.ceil(travel / 0.22)));
        const h = dt / steps;
        for (let s = 0; s < steps && p.active; s++) {
            p.vel.y += CONFIG.BALL_GRAVITY * h;
            p.pos.addScaledVector(p.vel, h);
            collideProjectile(p);
        }
        if (!p.active) continue;

        p.mesh.position.copy(p.pos);
        p.mesh.rotateOnWorldAxis(p.spinAxis, CONFIG.BALL_SPIN_RATE * dt); // tumble

        // items 247/343: orient the linear streak along the velocity vector and
        // the spin-blur disc perpendicular to the tumble axis.
        if (p.streak || p.ring) {
            const speed = p.vel.length();
            if (p.streak) {
                _dirScratch.copy(p.vel).normalize();
                const len = Math.max(0.05, CONFIG.BALL_RADIUS * CONFIG.BALL_STREAK_LEN_MUL * speed * 0.12);
                const width = CONFIG.BALL_RADIUS * CONFIG.BALL_STREAK_WIDTH_MUL;
                p.streak.scale.set(width, width, len);
                p.streak.quaternion.setFromUnitVectors(_unitZ, _dirScratch);
                p.streak.position.copy(p.pos).addScaledVector(_dirScratch, -len * 0.5);
                p.streak.material.opacity = THREE.MathUtils.clamp(speed / CONFIG.BALL_SPEED, 0.12, 0.5);
            }
            if (p.ring) {
                p.ringSpin += dt * CONFIG.BALL_SPIN_RATE * 2;
                p.ring.position.copy(p.pos);
                p.ring.quaternion.setFromUnitVectors(_unitZ, p.spinAxis);
                p.ring.rotateZ(p.ringSpin);
                p.ring.scale.setScalar(CONFIG.BALL_RADIUS * 2.4);
            }
        }

        // sparkle/streak trail (extras are skipped on the 'low' tier)
        if (state.qualityLevel !== 'low') {
            // item 344: ramp trail color toward a warning red as the ball nears
            // BALL_DESPAWN_TIME, so an about-to-vanish miss reads clearly first.
            const nearEnd = p.age / CONFIG.BALL_DESPAWN_TIME;
            const warnStart = 1 - CONFIG.BALL_TRAIL_WARN_FRACTION;
            const warn = nearEnd > warnStart ? Math.min(1, (nearEnd - warnStart) / CONFIG.BALL_TRAIL_WARN_FRACTION) : 0;

            // item 351: denser trail the closer the ball gets to the creature
            // the player is currently hovering/aiming at.
            let trailMul = 1;
            const th = state.targetHover;
            if (th && th.alive && !th.capturing) {
                const d = p.pos.distanceTo(th.pos);
                if (d < CONFIG.CAPTURE_RANGE) trailMul += (1 - d / CONFIG.CAPTURE_RANGE) * CONFIG.BALL_PROXIMITY_TRAIL_BOOST;
            }

            p.trailAcc += dt * CONFIG.BALL_TRAIL_RATE * trailMul * (1 + warn * 0.8);
            while (p.trailAcc >= 1) {
                p.trailAcc -= 1;
                const base = p.hot ? (Math.random() < 0.5 ? 0xfff3c4 : 0xffffff) : (Math.random() < 0.5 ? 0xffb84d : 0xffd98a);
                const col = warn > 0 ? lerpHexColor(base, 0xff3b30, warn) : base;
                spawnTrailMote(p.pos.x, p.pos.y, p.pos.z, col);
            }
        }

        p.age += dt;
        if (p.age > CONFIG.BALL_DESPAWN_TIME) {
            p.active = false;
            disposeProjectileFx(p);
            removeBall(p.mesh);
        }
    }

    state.projectiles = state.projectiles.filter(p => p.active);
}

// One collision pass at the ball's current position. Creatures are tested
// FIRST so a ball can pluck a floating duck the instant before it would
// splash; then walls, water and terrain end the flight.
function collideProjectile(p) {
    // Proximity checks against creature bodies — per-type body center
    // offset and per-creature hit radius (small types are harder to hit)
    for (let i = 0; i < state.creatures.length; i++) {
        const c = state.creatures[i];
        if (!c.alive || c.capturing) continue;

        reuse.tmpVec3.set(c.pos.x, c.pos.y + c.centerY, c.pos.z);

        const distSq = p.pos.distanceToSquared(reuse.tmpVec3);
        const catchRadius = c.hitRadius + p.radius;
        if (distSq < catchRadius * catchRadius) {
            p.active = false;
            p.mesh.position.copy(p.pos);
            disposeProjectileFx(p); // items 247/343: flight VFX end here, before hand-off

            // struck from behind? (ball travel dir vs creature facing). Phase 2k
            // item 85: in a tight tunnel the creature can't circle, so the "from
            // behind" cone is widened (tunnelBackDot) — the bonus AMOUNT is
            // unchanged (still CAPTURE_BACK_BONUS, still capped in capture.js).
            const bl = Math.sqrt(p.vel.x * p.vel.x + p.vel.z * p.vel.z) || 1;
            const backHit =
                (Math.cos(c.heading) * (p.vel.x / bl) + Math.sin(c.heading) * (p.vel.z / bl))
                > tunnelBackDot(c);
            if (backHit) showBackBonusFlourish();

            // item 350: mirror capture.js's own capped roll (read-only echo of the
            // same formula, purely for a distinct "you hit the ceiling" sting —
            // the actual roll/points still happen exactly once, in capture.js).
            if (state.qualityLevel !== 'low') {
                const base = CONFIG.CAPTURE_RATE_BY_TIER[c.def.tier] !== undefined
                    ? CONFIG.CAPTURE_RATE_BY_TIER[c.def.tier] : CONFIG.CAPTURE_MAX_CHANCE;
                const uncapped = base + (backHit ? CONFIG.CAPTURE_BACK_BONUS : 0) + caveCaptureBonus(c);
                if (uncapped > CONFIG.CAPTURE_MAX_CHANCE + 0.001) {
                    const sting = makeFlashSprite(0xffffff, 0.12);
                    sting.position.copy(p.pos);
                    sting.renderOrder = 6;
                    state.scene.add(sting);
                    state.captureFlashes.push({ sprite: sting, age: 0, life: 0.12, from: 0.12, to: 0.85 });
                }
            }

            // the ball lives on as the catch ball — no removal here
            beginCatchSequence(c, i, Math.sqrt(distSq), backHit, p.mesh, p.vel);
            return;
        }

        // item 354: a close whiff — just outside the catch radius, once per
        // throw — softens the "why didn't that count" feeling on a near-miss.
        if (!p.whiffed && state.qualityLevel !== 'low') {
            const whiffR = catchRadius * CONFIG.WHIFF_RADIUS_MUL;
            if (distSq < whiffR * whiffR) {
                p.whiffed = true;
                spawnParticleBurst(p.pos.x, p.pos.y, p.pos.z, 0xfff3c4, CONFIG.WHIFF_SPARK_COUNT, 0x9a8a6a);
            }
        }
    }

    // Phase 2k item 79: inside a cave, bounce off a side wall / vault ceiling
    // (limited count) for tight-space trick shots. Handled BEFORE the boundary/
    // ground/water despawn so a wall hit ricochets instead of ending the flight;
    // the floor + water keep their existing impact + despawn below. Outdoors and
    // on the arena walls this is a no-op (the ball isn't inside a passage).
    if (caveRicochet(p)) {
        p.mesh.position.copy(p.pos);
        // items 338/347/353: energy-scaled spark distinct from a clean open-air
        // throw, a "hot" trail tint for the rest of this ball's flight, and a
        // subtle screen-shake once the ball has used up its LAST allowed bounce
        // (a maxed-out chain — the trick-shot payoff moment).
        if (state.qualityLevel !== 'low') {
            const energyK = THREE.MathUtils.clamp(p.vel.length() / CONFIG.BALL_SPEED, 0.15, 1);
            spawnParticleBurst(p.pos.x, p.pos.y, p.pos.z, 0xfff3c4, Math.round(CONFIG.RICOCHET_SPARK_BASE * energyK), 0xff8a3c);
        }
        p.hot = true;
        if (p.bounces >= CONFIG.CAVE_BALL_MAX_BOUNCES) {
            triggerScreenShake(CONFIG.RICOCHET_SHAKE_MAG, CONFIG.RICOCHET_SHAKE_TIME);
        }
        return;
    }

    // Boundary collision bounds check
    const halfArena = CONFIG.ARENA_SIZE / 2 - CONFIG.WALL_THICKNESS;
    const hitWall = Math.abs(p.pos.x) >= halfArena || Math.abs(p.pos.z) >= halfArena;

    // Splash/impact height checks — over the water network (pond, river,
    // spring basin) the ball splashes at that surface's level, everywhere
    // else it thumps on the terrain surface
    const waterLevel = getWaterLevelAt(p.pos.x, p.pos.z);
    const hitWater = isWaterAt(p.pos.x, p.pos.z) && p.pos.y <= waterLevel + p.radius;
    const terrainH = getGroundY(p.pos.x, p.pos.z);
    const hitGround = p.pos.y <= terrainH + p.radius;

    if (hitWall || hitGround || hitWater) {
        p.active = false;
        disposeProjectileFx(p); // items 247/343

        if (hitWater && !hitWall) {
            // item 254: splash size/count scales with impact speed (this file's
            // stand-in for "fall height" — the object it actually owns).
            const impactSpeed = THREE.MathUtils.clamp(Math.abs(p.vel.y) / 9 + 0.4, 0.4, 1.6);
            spawnParticleBurst(p.pos.x, waterLevel + 0.05, p.pos.z, 0x4fc3f7, Math.round(16 * impactSpeed));
            spawnParticleBurst(p.pos.x, waterLevel + 0.1, p.pos.z, 0xe3f6ff, Math.round(8 * impactSpeed));
            spawnWaterRipple(p.pos.x, p.pos.z, waterLevel);
            playSplash();
        } else {
            // items 248/262/352: surface-tinted "fizzle" dust (a dulled fade,
            // distinct from capture.js's golden success burst) + a fading
            // ground decal at the rest point.
            const surf = surfaceImpactColors(p.pos.x, p.pos.z);
            spawnParticleBurst(p.pos.x, p.pos.y, p.pos.z, surf.dust, 12, 0x35322c);
            spawnGroundDecal(p.pos.x, terrainH, p.pos.z, surf.decal);
            playThump();
        }

        // near misses frighten skittish/panicky creatures nearby
        scareCreatures(p.pos.x, p.pos.z);

        removeBall(p.mesh);
    }
}
