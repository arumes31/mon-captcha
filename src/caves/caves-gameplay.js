/* ============================================================
   Cave GAMEPLAY & capture — Phase 2k (items 77–85)
   ------------------------------------------------------------
   The bonus cave-capture layer. Everything here is REWARD, never a
   gate: the surface 6-point win is fed entirely by the surface deck
   (spawn.js) and none of these mechanics touch it. Two hard rules
   are enforced from this module:

     * NO 100% CAPTURE. Every capture modifier (item 78 dead-end
       corner bonus, item 83 grotto-ball boost, item 85 tunnel
       back-lean) is ADDITIVE into the single capped roll in
       capture.js and previewed in the same capped readout in
       targeting.js — both do min(base + …, CONFIG.CAPTURE_MAX_CHANCE),
       so nothing ever reaches a guaranteed catch. This module only
       supplies the extra chance + the readout tags; it never rolls.

     * The base flow is untouched. Ricochet (79) only fires on real
       cave-interior wall/ceiling contact for balls physically inside
       a passage; outdoor throws + the ground/water impact + despawn
       are unchanged. A bounced ball can still capture.

   Contents:
     - caveCaptureBonus / tunnelBackDot / captureUiTags : the capped
       modifier inputs shared by capture.js + targeting.js (78/83/85)
     - caveRicochet                : cave wall/ceiling bounce (79)
     - caveThrowUpAngle            : flatter lob under low ceilings (80)
     - caveDeadEnds / caveDeepPoint: geometry the cave-spawn deep/
       alcove rewards use (77/81)
     - addFloorTracks              : theme-hook floor-print decor (84)
     - grotto-ball pickup          : optional cave capture ball (83)
     - triggerCaveCollapse         : timed cosmetic rock-fall drama (82)
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { CAVES, sampleCave, caveCeilingAt, getGroundY } from '../heightfield.js';
import { spawnParticleBurst } from '../particles.js';
import { playRicochet, playRockRumble, playCaveBallPickup } from '../audio.js';
import { makeCaptureBall, makeFlashSprite, removeBall } from '../ball.js';
import { showHintToast } from '../ui.js';
import { triggerScreenShake } from '../camera-shake.js';

const DUST = 0xb59a72;

/* ============================================================
   Dead-end registry (items 78 / 81). A dead-end pocket is a capped
   branch tip (caves-data makeBranch sets node.cap) or a designated
   alcove (cave._alcove, set by cave-spawn). Built once per world.
   ============================================================ */
let _deadEnds = null;
function ensureDeadEnds() {
    if (_deadEnds) return _deadEnds;
    _deadEnds = [];
    for (const c of CAVES) {
        for (const path of c.paths) for (const n of path) {
            if (n.cap) _deadEnds.push({ x: n.x, z: n.z, r: Math.max(n.hw, 1.0) });
        }
        if (c._alcove) _deadEnds.push({ x: c._alcove.x, z: c._alcove.z, r: c._alcove.r || 1.4 });
    }
    return _deadEnds;
}

// Cornered in a dead-end pocket? (used by the capture bonus + UI tag)
export function atDeadEnd(x, z) {
    if (!CAVES.length) return false;
    const ds = ensureDeadEnds();
    for (const d of ds) { const dx = x - d.x, dz = z - d.z; if (dx * dx + dz * dz < d.r * d.r) return true; }
    return false;
}

// Is the creature standing in a genuine tight TUNNEL node (not a chamber, mouth
// flare or the open outdoors)? A tunnel creature can't circle, so a back approach
// is both easy and worth surfacing (item 85).
function inTunnel(creature) {
    if (!creature || !creature.inCave || !CAVES.length) return false;
    const cf = sampleCave(creature.pos.x, creature.pos.z);
    return !!(cf && cf.lat < cf.hw && cf.hw < CONFIG.CAVE_TUNNEL_MAX_HW);
}

/* ============================================================
   Capped capture modifiers (items 78 / 83 / 85)
   ============================================================ */

// Extra capture chance for this creature BEFORE the cap. Folded into the single
// roll (capture.js) and the preview (targeting.js), both of which clamp to
// CONFIG.CAPTURE_MAX_CHANCE — so this can never produce a guaranteed catch.
export function caveCaptureBonus(creature) {
    let bonus = 0;
    if (state.caveBall) bonus += CONFIG.CAVE_BALL_BONUS;              // item 83
    if (creature && creature.inCave && atDeadEnd(creature.pos.x, creature.pos.z)) {
        bonus += CONFIG.CAVE_DEADEND_BONUS;                          // item 78
    }
    return bonus;
}

// The "from behind" dot threshold to use for this creature — widened (a broader
// back cone) for a tunnel-bound creature so the existing back bonus reads readily
// (item 85). Same value used by the roll (projectiles) and the preview (targeting).
export function tunnelBackDot(creature) {
    return inTunnel(creature) ? CONFIG.CAVE_TUNNEL_BACK_DOT : CONFIG.BACK_BONUS_DOT;
}

// Readable modifier tags for the targeting readout (never changes the odds — those
// come from caveCaptureBonus + the capped roll; this only names what's active).
export function captureUiTags(creature, behind) {
    const tags = [];
    if (behind) tags.push(inTunnel(creature) ? 'Tunnel Back' : 'Back');
    if (creature && creature.inCave && atDeadEnd(creature.pos.x, creature.pos.z)) tags.push('Cornered');
    if (state.caveBall) tags.push('Grotto Ball');
    return tags;
}

/* ============================================================
   Ball ricochet off cave walls / ceiling (item 79)
   ------------------------------------------------------------
   Scoped to balls physically INSIDE a cave passage: reflect off a
   side wall (radial normal) or the vault ceiling, up to a bounce
   cap, losing energy each bounce. The floor + water keep the
   existing impact/despawn (handled by projectiles.js), and a
   bounced ball is still live so it can capture on a later substep.
   Returns true if it handled a bounce this substep.
   ============================================================ */
export function caveRicochet(p) {
    if (!CAVES.length) return false;
    if (p.bounces === undefined) p.bounces = 0;
    if (p.bounces >= CONFIG.CAVE_BALL_MAX_BOUNCES) return false;

    const cf = sampleCave(p.pos.x, p.pos.z);
    if (!cf || cf.lat >= cf.hw) return false;          // not inside a passage horizontally
    const ceil = caveCeilingAt(p.pos.x, p.pos.z);
    if (!isFinite(ceil)) return false;
    const R = p.radius;
    // must be within the cave interior envelope (not flying over the shell outdoors)
    if (p.pos.y > ceil + R || p.pos.y < cf.floorY - R) return false;

    // ceiling bounce — deflect a rising ball back down off the vault
    if (p.vel.y > 0 && p.pos.y >= ceil - R) {
        p.pos.y = ceil - R - 0.02;
        p.vel.y = -p.vel.y * CONFIG.CAVE_BALL_RESTITUTION;
        p.vel.x *= 0.9; p.vel.z *= 0.9;
        p.bounces++;
        ricochetFx(p);
        return true;
    }

    // side-wall bounce — reflect the horizontal velocity off the radial wall normal
    if (cf.lat > cf.hw - R) {
        let nx = p.pos.x - cf.projX, nz = p.pos.z - cf.projZ;
        const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
        const vn = p.vel.x * nx + p.vel.z * nz;        // component heading OUT into the wall
        if (vn > 0) {
            p.vel.x -= 2 * vn * nx; p.vel.z -= 2 * vn * nz;   // mirror
            p.vel.x *= CONFIG.CAVE_BALL_RESTITUTION;
            p.vel.z *= CONFIG.CAVE_BALL_RESTITUTION;
            p.vel.y *= 0.92;
            const inside = Math.max(0.05, cf.hw - R - 0.04); // reseat just inside the wall
            p.pos.x = cf.projX + nx * inside;
            p.pos.z = cf.projZ + nz * inside;
            p.bounces++;
            ricochetFx(p);
            return true;
        }
    }
    return false;
}

function ricochetFx(p) {
    if (state.qualityLevel !== 'low') spawnParticleBurst(p.pos.x, p.pos.y, p.pos.z, DUST, 4);
    playRicochet();
}

/* ============================================================
   Cramped-ceiling flatter throw (item 80)
   ------------------------------------------------------------
   In a low tunnel, reduce the upward lob so the ball doesn't bonk
   the ceiling — subtle, and only when the thrower is actually under
   a low cave vault (caveCeilingAt finite). Outdoors it's a no-op.
   ============================================================ */
export function caveThrowUpAngle(x, z, y, baseUp) {
    if (!CAVES.length) return baseUp;
    const ceil = caveCeilingAt(x, z);
    if (!isFinite(ceil)) return baseUp;
    const head = ceil - y;
    if (head >= CONFIG.CAVE_LOW_CEIL) return baseUp;
    return baseUp * Math.max(0.12, head / CONFIG.CAVE_LOW_CEIL);
}

/* ============================================================
   Geometry helpers for the deep/alcove rewards (items 77 / 81).
   Pure reads over the final cave data — used by creatures/cave-spawn.js.
   ============================================================ */

// Capped branch tips (classic dead-end side pockets) in a cave.
export function caveDeadEnds(cave) {
    const out = [];
    for (const path of cave.paths) for (const n of path) {
        if (n.cap) out.push({ x: n.x, z: n.z, r: Math.max(n.hw, 1.0), node: n });
    }
    return out;
}

// The deepest interior node — the one whose nearest mouth is furthest away.
export function caveDeepPoint(cave) {
    const path0 = cave.paths[0];
    let best = path0[Math.floor(path0.length / 2)], bd = -1;
    for (const path of cave.paths) for (const n of path) {
        let md = Infinity;
        for (const e of cave.entrances) md = Math.min(md, Math.hypot(n.x - e.x, n.z - e.z));
        if (md > bd) { bd = md; best = n; }
    }
    return { x: best.x, z: best.z, node: best };
}

/* ============================================================
   Floor tracks / footprints (item 84) — static decor pushed through
   the 2e theme decorate hook (via the DecorKit), so it rides the
   culled per-cave layer for free. A short zig-zag line of dark,
   flat prints along the tunnel floor hinting a creature passed by.
   ============================================================ */
export function addFloorTracks(kit, cave, ctx) {
    const { rng, profile } = ctx, ds = profile.densityScale;
    const path = cave.paths[0];
    if (!path || path.length < 4) return;
    const nTrails = Math.max(1, Math.round(2 * ds));
    for (let s = 0; s < nTrails; s++) {
        const i0 = 1 + Math.floor(rng() * (path.length - 2));
        const n = path[i0], prev = path[Math.max(0, i0 - 1)];
        let tx = n.x - prev.x, tz = n.z - prev.z; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const px = -tz, pz = tx;                      // lateral (left/right foot axis)
        const dir = rng() < 0.5 ? 1 : -1;
        const prints = 4 + Math.floor(rng() * 4);
        let cx = n.x + px * (rng() * 2 - 1) * Math.max(0, n.hw - 0.9);
        let cz = n.z + pz * (rng() * 2 - 1) * Math.max(0, n.hw - 0.9);
        const heading = Math.atan2(tz, tx);
        for (let k = 0; k < prints; k++) {
            const foot = (k % 2 === 0 ? 1 : -1) * 0.17;
            const fx = cx + px * foot, fz = cz + pz * foot;
            kit.rock(fx, getGroundY(fx, fz) + 0.02, fz, 0.17, 0.05, 0.26, k % 2 ? 0x221a12 : 0x2a2016, 0, heading, 0);
            cx += tx * dir * 0.44; cz += tz * dir * 0.44;
        }
    }
}

/* ============================================================
   Grotto-ball pickup (item 83) — an OPTIONAL cave-found capture ball.
   Deterministic per seed: one nicer ball rests deep in one cave. On
   pickup the player keeps it (state.caveBall) for a modest, still-
   capped chance boost. The base ball is always in hand, so the
   captcha never depends on finding it.
   ============================================================ */
const _pickups = [];
const SHOW_R2 = 55 * 55;   // only draw the pickup when reasonably near (perf)
const GRAB_R = 1.9;

function buildPickups() {
    if (!CAVES.length || !state.scene) return;
    const cave = CAVES[CONFIG.WORLD_SEED % CAVES.length];    // seeded, deterministic
    const dp = caveDeepPoint(cave);
    const x = dp.x, z = dp.z, gy = getGroundY(x, z);
    const group = new THREE.Group();
    const ball = makeCaptureBall({ variant: 'cave', shadow: true });
    ball.scale.setScalar(1.35);
    group.add(ball);
    const glow = makeFlashSprite(0x6ff0e0, CONFIG.BALL_RADIUS * 7.5);
    glow.material.opacity = 0.5;
    group.add(glow);
    group.position.set(x, gy + 0.55, z);
    state.scene.add(group);
    _pickups.push({ group, glow, x, z, baseY: gy + 0.55, phase: Math.random() * 6.28, collected: false });
}

function updatePickups(dt, elapsed) {
    if (!_pickups.length) return;
    const cam = state.camera && state.camera.position;
    for (const pk of _pickups) {
        if (pk.collected) { pk.group.visible = false; continue; }
        const near2 = cam ? (cam.x - pk.x) ** 2 + (cam.z - pk.z) ** 2 : 1e9;
        pk.group.visible = near2 < SHOW_R2;
        if (!pk.group.visible) continue;
        pk.group.position.y = pk.baseY + Math.sin(elapsed * 1.6 + pk.phase) * 0.12;   // bob
        pk.group.rotation.y += dt * 1.3;                                              // spin
        if (cam && near2 < GRAB_R * GRAB_R && Math.abs(cam.y - pk.baseY) < 2.6) {
            pk.collected = true;
            pk.group.visible = false;
            state.caveBall = true;
            spawnParticleBurst(pk.x, pk.baseY, pk.z, 0x9ffff0, 20);
            if (!state.isPaused) playCaveBallPickup();
            // item 472: a bright glint pop exactly on the pickup sound's frame —
            // pushed straight into the shared state.captureFlashes pool (already
            // ticked unconditionally every frame by capture.js's updateFlashes(),
            // regardless of which module spawned the entry) rather than importing
            // capture.js directly, which would create a circular import (capture.js
            // already imports THIS module for maybeCollapse/caveCaptureBonus).
            const glint = makeFlashSprite(0xccfff5, 0.25);
            glint.position.set(pk.x, pk.baseY + 0.15, pk.z);
            glint.renderOrder = 6;
            if (state.scene) {
                state.scene.add(glint);
                state.captureFlashes.push({ sprite: glint, age: 0, life: 0.35, from: 0.25, to: 1.3 });
            }
            showHintToast('Grotto Ball found — steadier capture', '#6ff0e0');
        }
    }
}

/* ============================================================
   Timed collapsing passage (item 82) — a purely COSMETIC rock-fall
   after grabbing a deep prize. It changes NOTHING in the heightfield
   or confinement, so it can never trap the player or seal a route:
   the rocks are non-collidable meshes that fall, land and fade. A
   dust cloud, a screen-dust tint and a low rumble carry the drama.
   ============================================================ */
const _collapses = [];
let _rockGeo = null, _rockMat = null;

function rockAssets() {
    if (!_rockGeo) _rockGeo = new THREE.BoxGeometry(1, 1, 1);
    if (!_rockMat) _rockMat = new THREE.MeshStandardMaterial({ color: 0x4a4038, roughness: 0.96, metalness: 0.02 });
    return { geo: _rockGeo, mat: _rockMat };
}

// Called from capture.js on a HELD capture — only fires for a deep prize (item 77/
// 81 flag) or a cave legendary, so the drama stays a rare payoff.
export function maybeCollapse(creature, pos) {
    if (!creature || !creature.inCave) return;
    if (!(creature._deepPrize || creature.def.tier === 'legendary')) return;
    triggerCaveCollapse(pos.x, pos.y, pos.z);
}

export function triggerCaveCollapse(cx, cy, cz) {
    if (!state.scene) return;
    const { geo, mat } = rockAssets();
    const low = state.qualityLevel === 'low';
    const n = low ? 7 : 13;
    const rocks = [];
    for (let i = 0; i < n; i++) {
        // ring the fall a little OUT from the prize point so it never rains on the camera
        const ang = Math.random() * Math.PI * 2;
        const rr = 2.4 + Math.random() * 3.2;
        const x = cx + Math.cos(ang) * rr, z = cz + Math.sin(ang) * rr;
        const ceil = caveCeilingAt(x, z);
        const topY = (isFinite(ceil) ? ceil : cy + 3) - 0.15;
        const floorY = getGroundY(x, z);
        const s = 0.22 + Math.random() * 0.4;
        const m = new THREE.Mesh(geo, mat);
        m.scale.set(s, s * (0.7 + Math.random() * 0.5), s);
        m.position.set(x, topY, z);
        m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
        m.castShadow = false;
        state.scene.add(m);
        rocks.push({ m, x, z, y: topY, floorY: floorY + s * 0.4, vy: -0.3 - Math.random() * 0.6,
            spin: (Math.random() * 2 - 1) * 4, landed: false, s });
        if (!low) spawnParticleBurst(x, topY - 0.2, z, DUST, 3);
    }
    _collapses.push({ rocks, age: 0, dustT: 0, cx, cz });
    playRockRumble();
    // item 467: rock-rumble screen-shake, right alongside the already-synced
    // falling rocks + dust + screen-dust tint above (all fired in this one
    // synchronous call, so nothing here needed re-timing — a shake was simply
    // the one missing beat).
    triggerScreenShake(CONFIG.ROCK_RUMBLE_SHAKE_MAG, CONFIG.ROCK_RUMBLE_SHAKE_TIME);
    screenDust();
}

// A brief translucent dust tint over the viewport — safe DOM overlay, no gameplay.
let _dustEl = null, _dustTimer = null;
function screenDust() {
    if (!state.container) return;
    if (!_dustEl) {
        _dustEl = document.createElement('div');
        _dustEl.style.cssText = [
            'position:absolute', 'inset:0', 'pointer-events:none', 'z-index:20',
            'background:radial-gradient(ellipse at 50% 40%, rgba(120,98,70,0.0), rgba(90,72,50,0.28))',
            'opacity:0', 'transition:opacity 0.18s ease',
        ].join(';');
        state.container.appendChild(_dustEl);
    }
    _dustEl.style.opacity = '1';
    if (_dustTimer) clearTimeout(_dustTimer);
    _dustTimer = setTimeout(() => { if (_dustEl) _dustEl.style.opacity = '0'; }, 700);
}

function updateCollapses(dt) {
    if (!_collapses.length) return;
    for (const col of _collapses) {
        col.age += dt;
        col.dustT -= dt;
        let allDone = true;
        for (const r of col.rocks) {
            if (!r.landed) {
                r.vy += CONFIG.PLAYER_GRAVITY * 0.9 * dt;    // reuse the world gravity constant
                r.y += r.vy * dt;
                r.m.rotation.x += r.spin * dt;
                r.m.rotation.z += r.spin * 0.6 * dt;
                if (r.y <= r.floorY) { r.y = r.floorY; r.landed = true; r.landAge = 0;
                    if (state.qualityLevel !== 'low') spawnParticleBurst(r.x, r.floorY, r.z, DUST, 4); }
                r.m.position.y = r.y;
                allDone = false;
            } else {
                r.landAge = (r.landAge || 0) + dt;
                if (r.landAge < 1.6) {                        // linger, then shrink away
                    allDone = false;
                } else if (r.m.parent) {
                    const k = Math.min(1, (r.landAge - 1.6) / 0.8);
                    r.m.scale.setScalar(r.s * (1 - k));
                    if (k >= 1) { state.scene && state.scene.remove(r.m); }
                    else allDone = false;
                }
            }
        }
        if (col.dustT <= 0 && col.age < 1.3 && state.qualityLevel !== 'low') {
            spawnParticleBurst(col.cx + (Math.random() * 4 - 2), getGroundY(col.cx, col.cz) + 0.4, col.cz + (Math.random() * 4 - 2), DUST, 3);
            col.dustT = 0.18;
        }
        col.done = allDone;
    }
    for (let i = _collapses.length - 1; i >= 0; i--) if (_collapses[i].done) _collapses.splice(i, 1);
}

/* ============================================================
   Lifecycle
   ============================================================ */
export function initCaveGameplay() {
    state.caveBall = false;
    _deadEnds = null;
    ensureDeadEnds();      // rebuild the dead-end registry for this world (incl. alcoves)
    buildPickups();
}

export function updateCaveGameplay(dt, elapsed) {
    updatePickups(dt, elapsed);
    updateCollapses(dt);
}

export function disposeCaveGameplay() {
    for (const pk of _pickups) {
        if (pk.group && pk.group.parent) pk.group.parent.remove(pk.group);
        if (pk.glow && pk.glow.material) { try { pk.glow.material.dispose(); } catch (e) {} }
    }
    _pickups.length = 0;
    for (const col of _collapses) for (const r of col.rocks) { if (r.m && r.m.parent) r.m.parent.remove(r.m); }
    _collapses.length = 0;
    if (_rockGeo) { try { _rockGeo.dispose(); } catch (e) {} _rockGeo = null; }
    if (_rockMat) { try { _rockMat.dispose(); } catch (e) {} _rockMat = null; }
    if (_dustTimer) { clearTimeout(_dustTimer); _dustTimer = null; }
    if (_dustEl) { if (_dustEl.parentNode) _dustEl.parentNode.removeChild(_dustEl); _dustEl = null; }
    _deadEnds = null;
    state.caveBall = false;
}
