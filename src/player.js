/* ============================================================
   Player Controller & Height Traversal
   ------------------------------------------------------------
   WASD/arrows to move, Space to jump (single jump, gravity via
   PLAYER_GRAVITY, lands back on getTerrainHeight). Wading in
   the pond or river slows the run speed a touch. All of it is
   disabled while paused/solved, like the rest of the sim.

   Backlog items folded in here (world-graphics-improvements.md):
     258/342  footfalls (while grounded and moving) kick up a small
              surface-matched dust/splash puff behind the player,
              denser while sprinting — one stride-accumulator system
              covers both ideas.
     329      landing after a fall spawns a dust puff scaled by the
              impact speed.
     330      a speed-scaled first-person camera view-bob (previously
              only the held-ball viewmodel bobbed; the camera itself
              never did). Applied as a purely cosmetic offset AFTER
              this frame's authoritative ground/ceiling physics are
              resolved (state.player.baseY), so it can never feed back
              into next frame's collision math.
     333/340  a soft screen-edge tint wobbles while wading and fades
              out over WADE_OVERLAY_FADE_TIME after climbing out,
              reading as a lingering droplet/lens effect on emerging.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state, reuse } from './state.js';
import { getTerrainHeight, getGroundY, isWaterAt, getWaterLevelAt, caveConfine, caveCeilingAt, caveSlippery } from './heightfield.js';
import { spawnParticleBurst } from './particles.js';
import { zoneAt } from './zones/zones.js';

// item 333/340 — a single lazily-created DOM singleton (this module has no
// dispose hook wired into game.js's teardown, unlike targeting.js/viewmodel.js,
// so it's built ONCE and reused/toggled across destroy()/init() cycles rather
// than recreated, the same way engine.js reuses window.__globalRenderer).
let wadeOverlayEl = null;
function ensureWadeOverlay() {
    if (wadeOverlayEl) return wadeOverlayEl;
    if (!state.container) return null;
    const el = document.createElement('div');
    el.style.cssText = [
        'position:absolute', 'left:0', 'right:0', 'bottom:0', 'height:38%',
        'pointer-events:none', 'z-index:23', 'opacity:0',
        'transition:opacity ' + CONFIG.WADE_OVERLAY_FADE_TIME + 's ease',
        'background:radial-gradient(120% 90% at 50% 100%, rgba(140,200,225,0.22), rgba(140,200,225,0.05) 55%, transparent 75%)',
        'mix-blend-mode:soft-light',
    ].join(';');
    state.container.appendChild(el);
    wadeOverlayEl = el;
    return el;
}

// items 258/342/329 — surface-read dust/splash color at a point on the ground.
function surfaceFootColor(x, z) {
    const zone = zoneAt(x, z);
    if (!zone) return 0xcccccc;
    if (zone.id === 'ice' || zone.id === 'snow' || (zone.particle && zone.particle.kind === 'snow')) return 0xf5faff;
    if (zone.id === 'desert') return 0xe0c890;
    return zone.dirt || 0xcccccc;
}

export function setupPlayer() {
    state.player.velocity = new THREE.Vector3();
    state.player.keys = {};
    state.player.analogMove = null;
    state.player.vy = 0;          // vertical velocity (jump/gravity)
    state.player.grounded = true; // single jump: only from the ground
    state.player.inCave = false;  // cave-passage confinement state
    state.player.eyeHeight = CONFIG.PLAYER_EYE_HEIGHT; // eased down while crouching

    // Reset the cosmetic-only additions below on every fresh session — baseY
    // in particular MUST start undefined, or a stale value from a previous
    // session would snap the freshly-spawned camera's Y on the first frame.
    state.player.baseY = undefined;
    state.player.bobT = 0;
    state.player.footAcc = 0;
    state.player.wasWading = false;

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
    // item 330: restore last frame's clean, physics-authoritative Y before
    // touching anything — the view-bob added at the very end of this function
    // is cosmetic-only and must never leak into this frame's ground/ceiling math.
    if (state.player.baseY !== undefined) pos.y = state.player.baseY;

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
                // item 329: landing dust, scaled by how hard the fall was
                if (-p.vy > CONFIG.LANDING_FALL_MIN_SPEED && state.qualityLevel !== 'low') {
                    const fallK = THREE.MathUtils.clamp(-p.vy / 14, 0.3, 2.2);
                    spawnParticleBurst(pos.x, landY, pos.z, surfaceFootColor(pos.x, pos.z), Math.round(6 * fallK), 0x2c2a26);
                }
                p.vy = 0;
                p.grounded = true;
            }
        }
    } else {
        // Step off a ledge into a pit / shaft / lower gallery -> a real fall so
        // you land ON the lower floor (which getGroundY returns), never through it.
        //
        // The threshold MUST stay above CONFIG.VOXEL_SIZE. getGroundY returns
        // `base + k * VOXEL_SIZE + VOXEL_SIZE/2` — the top face of a voxel
        // column — so ordinary sloping ground descends in hard 0.85-unit
        // steps. With the old hard-coded 0.55 every single one of those steps
        // was deeper than the threshold, so simply walking downhill kicked the
        // player into free-fall and back onto the floor over and over. That
        // bypassed the smooth terraced-height lerp in the else-branch below
        // (which exists precisely to absorb these steps) and showed up as a
        // constant vertical judder while moving — a second, independent
        // contributor to "the screen shakes all the time" alongside the
        // camera-shake bus bug. PLAYER_LEDGE_DROP clears one voxel step with
        // margin, so a terrace is smoothed and only a genuine drop still falls.
        if (feetY < (pos.y - p.eyeHeight) - CONFIG.PLAYER_LEDGE_DROP) {
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

    // items 258/342: footstep dust/splash, matched to the surface directly
    // beneath the player, denser (and kicked up a touch behind the player)
    // while sprinting. A stride accumulator, same technique caves-audio.js
    // already uses for footstep SOUND cadence, just driving VFX instead.
    // item 465: inside a cave, use the SAME stride length caves-audio.js's
    // footstep SOUND cadence uses (CONFIG.CAVE_FOOTSTEP_STRIDE_LEN) instead of
    // this file's own FOOTSTEP_STRIDE_LEN — both accumulators add the identical
    // state.player.velocity.length()*dt each frame and reset the same way
    // (subtract the stride length, keep the remainder), so once the stride
    // length agrees too the dust and the footfall sound land on the same
    // frame instead of slowly drifting in and out of phase over a long walk.
    // Outdoors there's no footstep AUDIO cue at all to sync to, so the
    // surface cadence is untouched.
    if (p.grounded && !crouching && state.qualityLevel !== 'low') {
        const moveSpeed = v.length();
        const strideLen = p.inCave ? CONFIG.CAVE_FOOTSTEP_STRIDE_LEN : CONFIG.FOOTSTEP_STRIDE_LEN;
        if (moveSpeed > 0.15) {
            p.footAcc += moveSpeed * dt;
            if (p.footAcc >= strideLen) {
                p.footAcc -= strideLen;
                const sprinting = moveSpeed > CONFIG.PLAYER_MAX_SPEED * CONFIG.FOOTSTEP_SPRINT_FRACTION;
                const kickBack = sprinting ? 0.35 : 0.12;
                const fx = pos.x - reuse.moveDir.x * kickBack;
                const fz = pos.z - reuse.moveDir.z * kickBack;
                if (wading) {
                    spawnParticleBurst(fx, feetY + 0.03, fz, 0xbfe8ff, sprinting ? 8 : 4);
                } else {
                    spawnParticleBurst(fx, feetY + 0.02, fz, surfaceFootColor(fx, fz), sprinting ? 7 : 3, 0x2c2a26);
                }
            }
        } else {
            p.footAcc = Math.min(p.footAcc, strideLen * 0.5);
        }
    }

    // item 330: speed-scaled camera view-bob — grounded only, and applied
    // AFTER saving this frame's clean authoritative Y, so it never feeds back
    // into next frame's ground/ceiling physics above.
    state.player.baseY = pos.y;
    if (p.grounded && !crouching) {
        const bobK = Math.min(1, v.length() / CONFIG.PLAYER_MAX_SPEED);
        if (bobK > 0.02) {
            p.bobT = (p.bobT || 0) + dt * (CONFIG.VIEW_BOB_FREQ_BASE + bobK * CONFIG.VIEW_BOB_FREQ_SPEED);
            pos.y += Math.sin(p.bobT) * CONFIG.VIEW_BOB_AMPLITUDE * bobK;
        }
    }

    // items 333/340: a soft wade tint that wobbles while wading and, because
    // its own CSS opacity transition is multi-second, keeps fading for a
    // while after climbing back out — reading as a lingering droplet/lens
    // effect on emerging rather than a hard cut.
    const overlay = ensureWadeOverlay();
    if (overlay) {
        if (wading) {
            overlay.style.opacity = '1';
            const t = performance.now() / 1000;
            overlay.style.transform = 'scale(' + (1 + Math.sin(t * 2.2) * 0.015) + ', 1)';
            p.wasWading = true;
        } else if (p.wasWading || overlay.style.opacity !== '0') {
            overlay.style.opacity = '0';
            p.wasWading = false;
        }
    }
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
