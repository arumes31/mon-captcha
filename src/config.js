/* ============================================================
   Config
   ============================================================ */

// World seed — randomized on every page load (crypto with a Date fallback)
// so no two visits share a layout. The seeded mulberry32/value-noise
// machinery keys off this one number, so a session stays internally
// consistent: terrain, flora, clouds and the river all agree.
function rollWorldSeed() {
    // Test-only pin: ?seed=N reproduces one exact world (same precedent as
    // ?probe). Zero effect on normal loads, which stay freshly randomized.
    try {
        if (typeof window !== 'undefined' && window.location) {
            const m = /[?&]seed=(\d+)/.exec(window.location.search);
            if (m) return (parseInt(m[1], 10) >>> 0);
        }
    } catch (e) { /* fall through */ }
    try {
        const a = new Uint32Array(1);
        crypto.getRandomValues(a);
        if (a[0]) return a[0] >>> 0;
    } catch (e) { /* fall through */ }
    return ((Date.now() & 0xffffffff) ^ ((Math.random() * 0xffffffff) | 0)) >>> 0;
}

export const CONFIG = {
    // Arena — Phase 2 grew the valley from 64 to 100 units so the twelve
    // themed zones each get real breathing room. Voxel size scaled in step
    // (0.55 -> 0.85) so the terrain column count — and thus the worst-case
    // instance budget (~30k) — barely moves (hidden-voxel culling keeps most
    // columns a single voxel deep).
    ARENA_SIZE: 100,
    WALL_HEIGHT: 4,
    WALL_THICKNESS: 1,

    // World seed (fresh every load; see rollWorldSeed above)
    WORLD_SEED: rollWorldSeed(),

    // Voxel resolution — scaled with the arena to hold the instance budget.
    VOXEL_SIZE: 0.85,

    // Pond (fixed structural feature — survives any seed)
    POND_RADIUS: 8.0,
    POND_WATER_LEVEL: 0.0,

    // Spawn pad geometry (fixed radius/height). The pad's LOCATION is now
    // seeded per load (heightfield.pickSpawn), preferring a gentle zone;
    // SPAWN_X/Z are only a last-resort fallback.
    SPAWN_X: 0,
    SPAWN_Z: 14,
    SPAWN_RADIUS: 3.5,
    SPAWN_HEIGHT: 0.85,

    // River (Phase 2c: the MAIN river is widened ~2x and re-sourced as a border
    // waterfall pouring in over the perimeter cliff into a plunge pool, then
    // winding to the pond hub; the old mountain cascade stays as a narrower
    // secondary tributary — see heightfield.js river courses B and M). Depth
    // range keeps it wadeable, and seeded FORDS shallow it at intervals so no
    // zone is ever cut off.
    RIVER_WIDTH: 3.4,        // main-channel half-width at full depth (±0.45 variation)
    RIVER_BANK: 3.0,         // extra half-width blending channel into terrain
    RIVER_DEPTH: 0.85,       // mean depth below the water line (±0.16)

    // Flora caps (instance budget; Phase 2c density pass raised the ceiling —
    // measured worst-case total held under ~35k instances)
    MAX_FLORA_INSTANCES: 16500,
    TREE_COUNT_HIGH: 60,
    TREE_COUNT_LOW: 28,

    // Player
    PLAYER_EYE_HEIGHT: 1.8,
    PLAYER_CROUCH_EYE_HEIGHT: 1.0, // Ctrl/C: duck under belly-crawl low squeezes (Phase 2f item 10)
    PLAYER_CROUCH_SLOWDOWN: 0.45,  // crawl speed while crouched
    PLAYER_RADIUS: 0.4,
    // Cave minimum navigable half-width (Phase 2m). Every walkable cave node is
    // clamped to at least this so the player is never forced to clip through
    // rock to progress: PLAYER_RADIUS (0.4) + a 0.9 comfort margin. A "squeeze"
    // (belly-crawl, choke) now reduces HEIGHT only (crouch) — never width below
    // this passable floor. Chambers/cathedrals still swell well above it.
    CAVE_MIN_NAV_HW: 1.3,
    PLAYER_ACCEL: 75,
    PLAYER_FRICTION: 12,
    PLAYER_MAX_SPEED: 8.0,
    PLAYER_JUMP_SPEED: 6.4,  // Space impulse (no double-jump)
    PLAYER_GRAVITY: -18.0,
    PLAYER_WADE_SLOWDOWN: 0.62, // max-speed multiplier while wading in water

    // Touch controls (mobile) — feature-detected via matchMedia('(pointer:
    // coarse)') in touch-controls.js. Look sensitivity is independent of
    // desktop mouse feel (drag distances differ); joystick radius should
    // roughly match the move-zone knob's travel room in style.css.
    TOUCH_LOOK_SENSITIVITY: 0.0045, // radians per px of drag delta
    TOUCH_JOYSTICK_RADIUS: 36,      // px the knob can travel from center before saturating
    TOUCH_JOYSTICK_DEADZONE: 0.15,  // fraction of radius ignored (thumb-rest jitter)

    // Projectile Physics
    BALL_SPEED: 25,
    BALL_UP_ANGLE: 4.5,
    BALL_GRAVITY: -14.0,
    BALL_DESPAWN_TIME: 3.5,

    // Capture ball look & flight
    BALL_RADIUS: 0.2,
    BALL_SPIN_RATE: 11,          // end-over-end tumble in flight (rad/s)
    BALL_TRAIL_RATE: 70,         // sparkle motes per second in flight (skipped on 'low')

    // Viewmodel (ball held in the hand, bottom-right of view)
    VM_WINDUP_TIME: 0.09,        // pull-back before release
    VM_THROW_TIME: 0.13,         // forward swing after release
    VM_COOLDOWN: 0.6,            // empty-hand time before the next ball returns
    VM_RETURN_TIME: 0.24,        // scale-pop of the returning ball

    // Capture chance (rolled once, when a ball connects). No tier is ever a
    // sure thing — not even a common, and not even with the back bonus.
    CAPTURE_RATE_BY_TIER: { common: 0.90, uncommon: 0.78, rare: 0.62, legendary: 0.45 },
    CAPTURE_BACK_BONUS: 0.15,    // bonus for striking from behind the creature's heading
    CAPTURE_MAX_CHANCE: 0.95,    // hard ceiling on the effective chance — never 100%
    BACK_BONUS_DOT: 0.35,        // dot(throw dir, facing) above this counts as "from behind"

    // Phase 2k — cave GAMEPLAY & capture (items 77–85). Every capture modifier
    // here is additive INTO the single capped roll (capture.js) and previewed in
    // the same capped readout (targeting.js), so nothing is ever guaranteed — the
    // effective chance is always min(…, CAPTURE_MAX_CHANCE). Cave gameplay is
    // bonus/reward: the surface 6-point win never depends on any of it.
    CAVE_DEADEND_BONUS: 0.08,    // item 78: cornering a creature in a dead-end pocket
    CAVE_BALL_BONUS: 0.06,       // item 83: the nicer cave-found "grotto ball" (still capped)
    CAVE_TUNNEL_BACK_DOT: 0.06,  // item 85: a tunnel-bound creature can't circle — widen the
                                 //          "from behind" cone so the back bonus reads readily
    CAVE_TUNNEL_MAX_HW: 1.9,     // half-width below this (not a chamber/mouth) counts as a tunnel
    CAVE_LOW_CEIL: 2.6,          // item 80: below this headroom the throw arc flattens (no ceiling bonk)
    CAVE_BALL_MAX_BOUNCES: 3,    // item 79: ricochet cap per ball (trick shots, still terminates)
    CAVE_BALL_RESTITUTION: 0.62, // energy kept per cave wall/ceiling bounce

    // Catch sequence (suck-in -> fall -> wobbles -> click / breakout)
    CATCH_SUCK_TIME: 0.35,       // creature spirals into the ball
    CATCH_SETTLE_PAUSE: 0.35,    // beat after the ball settles, before wobbling
    CATCH_WOBBLE_COUNT: 3,
    CATCH_WOBBLE_INTERVAL: 0.55, // start-to-start wobble spacing
    CATCH_SUCCESS_TIME: 0.45,    // golden click-and-fade after the last wobble
    CATCH_RESTORE_TIME: 0.28,    // breakout re-grow tween
    BREAKOUT_SPEED_MUL: 2.2,     // escaped creatures bolt for a few seconds
    BREAKOUT_PANIC_TIME: 3.5,

    // Creatures
    CAPTURES_REQUIRED: 6,        // win condition: capture POINTS (common=1, rarer tiers=2)
    POINTS_COMMON: 1,
    POINTS_SPECIAL: 2,           // uncommon / rare / legendary
    CREATURE_SPAWN_COUNT: 75,    // creatures alive in the arena (high/medium tier; Phase 2c fauna pass 58->75)
    CREATURE_SPAWN_COUNT_LOW: 34,// reduced population on the low quality tier
    CREATURE_MIN_SPACING: 2.0,   // min distance between spawns (world units)
    CREATURE_SPAWN_ATTEMPTS: 8000,
    CREATURE_WANDER_SPEED: 1.1,  // baseline; per-type speed multiplies this
    CREATURE_TURN_RATE: 1.5,
    CREATURE_BOUNDARY_MARGIN: 2.5,
    CREATURE_ANIM_LOD_DIST: 25,  // beyond this, secondary animation is amortized
    CAPTURE_RANGE: 12,

    // Particles
    PARTICLE_POOL: 320,
    PARTICLE_LIFE: 0.7,
    PARTICLE_SPEED: 5.5,

    // Idle update throttle (Phase 4b item 356): when the tab is hidden or the
    // game is paused (pointer unlocked, not solved), the loop clamps to this
    // update rate instead of the full 180 FPS ceiling — no point simulating a
    // world nobody is looking at.
    IDLE_UPDATE_FPS: 8,

    // Shadow frustum half-extent, in world units, RECENTERED ON THE PLAYER
    // every frame (see engine.js's updateSunFollow) rather than fixed at the
    // full ARENA_SIZE around world origin. A frustum this size still comfortably
    // covers everything shadow-relevant near the player (CAPTURE_RANGE=12) while
    // excluding the rest of the ~100-unit-radius arena from the shadow pass —
    // this was the single biggest per-frame draw-call cost found while
    // investigating "frame drops every few meters / at cave entrances": with a
    // static ±ARENA_SIZE frustum, virtually every shadow-casting object in the
    // whole world (all ~75 non-instanced multi-part creatures included) was
    // being resubmitted to the shadow depth pass every frame regardless of
    // camera position.
    SHADOW_FOLLOW_RADIUS: 45,

    // Quality
    SHADOW_MAP_HIGH: 2048,
    SHADOW_MAP_MED: 1024,
    SHADOW_MAP_LOW: 256,
    // Pixel-ratio cap per tier — 'high' stays at the pre-existing min(dpr,2)
    // so nothing changes visually there; medium/low step fragment/fill cost
    // down further (one of the biggest levers for a weak GPU).
    PIXEL_RATIO_HIGH: 2,
    PIXEL_RATIO_MEDIUM: 1.5,
    PIXEL_RATIO_LOW: 1,
    FPS_SAMPLE_FRAMES: 60,
    FPS_DOWN_THRESHOLD: 35,
    FPS_DOWN_FRAMES: 60,
    FPS_UP_THRESHOLD: 52,
    FPS_UP_FRAMES: 120,

    // Security
    PRIVATE_SALT: 'c4ptch4-v0x3l-r3w0rk-2026-salt',

    // ---- Cave world/graphics backlog pass (sections 5/8/9/10 — items 79-94,
    // 129-176) — a single new tunable added by that pass; everything else
    // reused existing per-module magic numbers rather than growing this file.
    CAVE_VIGNETTE_MAX: 0.4, // item 173: peak screen-vignette opacity at the cave-mouth "eyes adjusting" transient
};
