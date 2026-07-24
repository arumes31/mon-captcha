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
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state, reuse } from './state.js';
import { getGroundY, isWaterAt, getWaterLevelAt } from './heightfield.js';
import { scareCreatures } from './creatures/behavior.js';
import { spawnParticleBurst, spawnWaterRipple, spawnTrailMote } from './particles.js';
import { playThrow, playThump, playSplash } from './audio.js';
import { makeCaptureBall, makeBallGlowSprite, removeBall } from './ball.js';
import { requestThrow } from './viewmodel.js';
import { beginCatchSequence } from './capture.js';
import { showBackBonusFlourish } from './targeting.js';
import { caveRicochet, caveThrowUpAngle, tunnelBackDot } from './caves-gameplay.js';

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
    });
    playThrow();
}

export function updateProjectiles(dt) {
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

        // sparkle/streak trail (extras are skipped on the 'low' tier)
        if (state.qualityLevel !== 'low') {
            p.trailAcc += dt * CONFIG.BALL_TRAIL_RATE;
            while (p.trailAcc >= 1) {
                p.trailAcc -= 1;
                // amber-gold motes stay readable against both sky and grass
                spawnTrailMote(p.pos.x, p.pos.y, p.pos.z, Math.random() < 0.5 ? 0xffb84d : 0xffd98a);
            }
        }

        p.age += dt;
        if (p.age > CONFIG.BALL_DESPAWN_TIME) {
            p.active = false;
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

            // struck from behind? (ball travel dir vs creature facing). Phase 2k
            // item 85: in a tight tunnel the creature can't circle, so the "from
            // behind" cone is widened (tunnelBackDot) — the bonus AMOUNT is
            // unchanged (still CAPTURE_BACK_BONUS, still capped in capture.js).
            const bl = Math.sqrt(p.vel.x * p.vel.x + p.vel.z * p.vel.z) || 1;
            const backHit =
                (Math.cos(c.heading) * (p.vel.x / bl) + Math.sin(c.heading) * (p.vel.z / bl))
                > tunnelBackDot(c);
            if (backHit) showBackBonusFlourish();

            // the ball lives on as the catch ball — no removal here
            beginCatchSequence(c, i, Math.sqrt(distSq), backHit, p.mesh, p.vel);
            return;
        }
    }

    // Phase 2k item 79: inside a cave, bounce off a side wall / vault ceiling
    // (limited count) for tight-space trick shots. Handled BEFORE the boundary/
    // ground/water despawn so a wall hit ricochets instead of ending the flight;
    // the floor + water keep their existing impact + despawn below. Outdoors and
    // on the arena walls this is a no-op (the ball isn't inside a passage).
    if (caveRicochet(p)) { p.mesh.position.copy(p.pos); return; }

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

        if (hitWater && !hitWall) {
            // Proper water splash: blue droplets, pale spray, expanding ring
            spawnParticleBurst(p.pos.x, waterLevel + 0.05, p.pos.z, 0x4fc3f7, 16);
            spawnParticleBurst(p.pos.x, waterLevel + 0.1, p.pos.z, 0xe3f6ff, 8);
            spawnWaterRipple(p.pos.x, p.pos.z, waterLevel);
            playSplash();
        } else {
            spawnParticleBurst(p.pos.x, p.pos.y, p.pos.z, 0xdddddd, 12);
            playThump();
        }

        // near misses frighten skittish/panicky creatures nearby
        scareCreatures(p.pos.x, p.pos.z);

        removeBall(p.mesh);
    }
}
