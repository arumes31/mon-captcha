/* ============================================================
   Player Controller & Height Traversal
   ------------------------------------------------------------
   WASD/arrows to move, Space to jump (single jump, gravity via
   PLAYER_GRAVITY, lands back on getTerrainHeight). Wading in
   the pond or river slows the run speed a touch. All of it is
   disabled while paused/solved, like the rest of the sim.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state, reuse } from './state.js';
import { getTerrainHeight, getGroundY, isWaterAt, getWaterLevelAt, caveConfine, caveCeilingAt, caveSlippery } from './heightfield.js';

export function setupPlayer() {
    state.player.velocity = new THREE.Vector3();
    state.player.keys = {};
    state.player.analogMove = null;
    state.player.vy = 0;          // vertical velocity (jump/gravity)
    state.player.grounded = true; // single jump: only from the ground
    state.player.inCave = false;  // cave-passage confinement state
    state.player.eyeHeight = CONFIG.PLAYER_EYE_HEIGHT; // eased down while crouching

    window.addEventListener('keydown', onKeyDown, false);
    window.addEventListener('keyup', onKeyUp, false);
}

export function onKeyDown(e) {
    state.player.keys[e.code] = true;
}
export function onKeyUp(e) {
    state.player.keys[e.code] = false;
}

export function updatePlayer(dt) {
    if (!state.controls.isLocked || state.isPaused || state.isCaptchaSolved) return;

    const k = state.player.keys;
    const analog = state.player.analogMove;
    // Touch joystick reports an analog {fwd, strafe} pair (magnitude 0..1);
    // fall back to the binary WASD/arrow read when it's not active, so the
    // desktop path is untouched.
    const fwd = analog ? analog.fwd : (k['KeyW'] || k['ArrowUp'] ? 1 : 0) - (k['KeyS'] || k['ArrowDown'] ? 1 : 0);
    const strafe = analog ? analog.strafe : (k['KeyD'] || k['ArrowRight'] ? 1 : 0) - (k['KeyA'] || k['ArrowLeft'] ? 1 : 0);
    const crouching = !!(k['ControlLeft'] || k['ControlRight'] || k['KeyC']); // belly-crawl

    // Flat camera orientation basis
    state.camera.getWorldDirection(reuse.playerForward);
    reuse.playerForward.y = 0;
    reuse.playerForward.normalize();
    reuse.playerRight.set(-reuse.playerForward.z, 0, reuse.playerForward.x);

    reuse.moveDir.set(0, 0, 0);
    reuse.moveDir.addScaledVector(reuse.playerForward, fwd);
    reuse.moveDir.addScaledVector(reuse.playerRight, strafe);
    // Clamp (rather than always normalizing) so an analog joystick's
    // magnitude below 1 survives as a walk — only keyboard's diagonal
    // (length sqrt(2)) actually needs capping back down to 1.
    if (reuse.moveDir.lengthSq() > 1) reuse.moveDir.normalize();

    const v = state.player.velocity;
    v.addScaledVector(reuse.moveDir, CONFIG.PLAYER_ACCEL * dt);

    const obj = state.controls.getObject();
    const pos = obj.position;

    // Wading: standing below the local water surface drags the top speed down.
    // Uses getWaterLevelAt so an elevated cave pool (up a mountain flank) wades
    // correctly, not just the y=0 pond/river network.
    const wading = isWaterAt(pos.x, pos.z) &&
        getTerrainHeight(pos.x, pos.z) < getWaterLevelAt(pos.x, pos.z) - 0.05;
    let maxSpeed = wading ? CONFIG.PLAYER_MAX_SPEED * CONFIG.PLAYER_WADE_SLOWDOWN : CONFIG.PLAYER_MAX_SPEED;
    if (crouching) maxSpeed *= CONFIG.PLAYER_CROUCH_SLOWDOWN;

    // Slippery footing (Phase 2i item 44): standing (not wading) on the wet rim
    // of a cave pool / stream bank loosens grip a touch — subtle, not broken.
    const wetEdge = !wading && state.player.inCave && caveSlippery(pos.x, pos.z);

    // Friction decay
    const speed = v.length();
    if (speed > 0) {
        const friction = CONFIG.PLAYER_FRICTION * (wetEdge ? 0.4 : 1) * dt;
        if (speed <= friction) v.set(0, 0, 0);
        else v.multiplyScalar(1 - friction / speed);
    }
    if (speed > maxSpeed) v.multiplyScalar(maxSpeed / speed);

    const halfArena = CONFIG.ARENA_SIZE / 2 - CONFIG.WALL_THICKNESS - CONFIG.PLAYER_RADIUS;

    // Movement collision constraints
    let nx = pos.x + v.x * dt;
    if (nx > halfArena) nx = halfArena;
    if (nx < -halfArena) nx = -halfArena;
    if (!collidesObstacle(nx, pos.z)) pos.x = nx;

    let nz = pos.z + v.z * dt;
    if (nz > halfArena) nz = halfArena;
    if (nz < -halfArena) nz = -halfArena;
    if (!collidesObstacle(pos.x, nz)) pos.z = nz;

    // Cave walls: solid from outside (except at the mouths), and inside a
    // passage the player slides along the wall instead of clipping through
    const conf = caveConfine(pos.x, pos.z, CONFIG.PLAYER_RADIUS, state.player.inCave);
    if (conf) {
        pos.x = conf.x;
        pos.z = conf.z;
        state.player.inCave = conf.inside;
    } else {
        state.player.inCave = false;
    }

    // ---- vertical: crouch, jump impulse + gravity, ground on the terrain ----
    const p = state.player;
    // Ease the eye height toward standing / crouched. The cave head-bump below is
    // an ABSOLUTE ceiling clamp, so crouch only ducks the camera under low rock —
    // it can never let the camera climb up through the vault (item 10).
    const eyeTarget = crouching ? CONFIG.PLAYER_CROUCH_EYE_HEIGHT : CONFIG.PLAYER_EYE_HEIGHT;
    p.eyeHeight += (eyeTarget - p.eyeHeight) * Math.min(1, dt * 10);
    const feetY = getGroundY(pos.x, pos.z);
    const groundY = feetY + p.eyeHeight;
    // ceiling clamp applies whether grounded or airborne, so a low ceiling always
    // pushes the head down instead of letting it poke through the rock. Guarded to
    // never fall BELOW the feet: at a pit/junction overlap, getGroundY (column
    // sampled) and caveCeilingAt (point sampled) can resolve to different passages,
    // which would otherwise clamp the camera underground.
    const ceilLimit = p.inCave ? Math.max(caveCeilingAt(pos.x, pos.z) - 0.25, feetY + 0.35) : Infinity;

    if (k['Space'] && p.grounded && !crouching) { // no double-jump; can't jump crouched
        p.vy = CONFIG.PLAYER_JUMP_SPEED;
        p.grounded = false;
    }

    if (!p.grounded) {
        p.vy += CONFIG.PLAYER_GRAVITY * dt;
        pos.y += p.vy * dt;
        if (pos.y > ceilLimit) { pos.y = ceilLimit; if (p.vy > 0) p.vy = 0; } // head-bump
        // land on the floor OR duck under a low ceiling — whichever is lower — so a
        // jump inside a belly squeeze (where standing height > the ceiling) can never
        // snap the head back up through the rock.
        const landY = Math.min(groundY, ceilLimit);
        if (pos.y <= landY) {
            pos.y = landY;      // ride the slope even mid-ascent
            if (p.vy <= 0) {    // touched down
                p.vy = 0;
                p.grounded = true;
            }
        }
    } else {
        // Step off a ledge into a pit / shaft / lower gallery -> a real fall so
        // you land ON the lower floor (which getGroundY returns), never through it.
        if (feetY < (pos.y - p.eyeHeight) - 0.55) {
            p.grounded = false;
            p.vy = 0;
        } else {
            // Smooth terraced height transitions, clamped under any low ceiling.
            const target = Math.min(groundY, ceilLimit);
            pos.y += (target - pos.y) * 10 * dt;
        }
    }

    // Floor + ceiling safety (Phase 2m). Never let the camera sink below the floor
    // during a fast up-step — the smooth-height lerp would otherwise trail below
    // the new ground for a few frames (worst on steep mountain-cave/hill flanks) —
    // and never let it rise above a cave ceiling, not even for the single
    // transition frame when stepping off a ledge. floorMin stays under the ceiling
    // clamp so it can't fight the head-bump; both are no-ops in the common case
    // (ceilLimit is Infinity outdoors).
    const floorMin = Math.min(feetY + 0.35, ceilLimit);
    if (pos.y < floorMin) pos.y = floorMin;
    if (pos.y > ceilLimit) pos.y = ceilLimit;
}

export function collidesObstacle(x, z, r = CONFIG.PLAYER_RADIUS) {
    for (let i = 0; i < state.obstacles.length; i++) {
        const o = state.obstacles[i];
        const dx = x - o.x;
        const dz = z - o.z;
        const rr = r + o.r;
        if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
}
