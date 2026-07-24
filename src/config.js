/* ============================================================
   Config
   ------------------------------------------------------------
   item 500 (world-graphics-improvements.md, Section 30): folding
   the 500-item backlog into this file's existing "item N" comment
   convention, as a triaged record rather than a blanket done/not-done.

   Items 1-480 (Sections 1-29) were split by file-disjoint area across
   9 parallel passes and merged in; each landed constant/comment below
   cites its own item number(s) at the point of use (grep "item " in
   this file and its sibling modules for the full trail) — see each
   pass's own in-code section header comment (e.g. "Zones - Biome
   Identity pass", "Cave world/graphics backlog pass") for exactly
   which items that pass covered and which it explicitly skipped.

   Section 30 (items 481-500, meta/engineering rather than visual) was
   triaged directly rather than split out:
     - 481 dev frame-time profiler, 494 GPU timer-query profiling: not
       built — SwiftShader (this project's primary CI/test target) has
       no timer-query support, so a GPU-bound/CPU-bound split wouldn't
       be measurable in the harness that would exercise it. Deferred.
     - 482 texture/geometry leak logging, 486 buildX/disposeX audit:
       tests/leak.mjs already exists for exactly this. Used it to find
       and fix a real gap (atmosphere-fx.js's 3 meshes + fire light,
       and separately the EffectComposer + its passes, were never
       disposed in game.js's destroy() — both fixed).
     - 483 WebGPURenderer path: evaluated, not built. A renderer-backend
       swap is a large, risky change for a buildless/dependency-free
       project pinned to one CDN'd three.js version; not attempted.
     - 484 reuse render-targets across composer passes: already true
       by construction — EffectComposer allocates one ping-pong target
       pair shared by every pass added to it.
     - 485 resize-debounce: built (game.js onResize, 120ms coalesce).
       While in that code path, found and fixed a real bug: composer.
       setSize() was never called on resize at all, so post-processing
       silently rendered at the stale pre-resize resolution.
     - 487 flora-instance headroom logging, 493 draw-call budget:
       tests/perfbudget.mjs already asserts an instance-total ceiling;
       added a matching draw-call ceiling assertion (item 493) alongside
       the existing (already-logged) drawCalls figure.
     - 488/499 visreg coverage for graphics changes: tests/visreg.mjs
       already exists; baselines were regenerated against this merge.
     - 489 supersampling toggle for capture: already satisfied by the
       existing `?photo` mode (items 373/382) forcing the manual-only
       'ultra' tier's PIXEL_RATIO_ULTRA.
     - 490 shader precompile warm-up, 491 async cave/terrain build:
       real but sizable engine-level changes; not attempted this pass.
     - 492 WebXR/VR stretch goal: noted only, per the item's own wording.
     - 495 linear-space color audit: already answered — see terrain.js's
       "near-linear authored hex" comment (zone palettes are unpacked
       byte-wise, matching how voxelColor writes them; outputColorSpace
       = SRGBColorSpace handles the framebuffer's final conversion).
     - 496 headless offscreen screenshotting: already satisfied by the
       existing Playwright-based tests/*.mjs harness.
     - 497 render-target MSAA vs antialias:true: evaluated — the current
       antialias flag is already conditional on software-renderer
       detection (engine.js), which is the sharper lever for this
       project's actual SwiftShader-heavy usage; not changed further.
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

    // ------------------------------------------------------------
    // Zones — Biome Identity pass (backlog items 215-230). See
    // src/zones/zones-data.js (ZONE_DEFS fields) and src/zones/zones.js
    // (blended/hard lookups) for how these are consumed.
    // ------------------------------------------------------------
    // item 222: zoneBlendAt's border weight t maxes at 0.5 exactly on the
    // seam; a marker is "at the border" once t clears this fraction of that
    // max, i.e. within the innermost ~28% of the cross-fade band.
    ZONE_BORDER_MARKER_THRESHOLD: 0.36,
    // item 215: landmark anchor radius, as a fraction of the arena half-size —
    // far enough from the central pond hub and close enough to the outer wall
    // that every zone's signature silhouette reads from a distance without
    // fouling the pond or clipping the boundary.
    ZONE_LANDMARK_RADIUS_FRAC: 0.6,

    // ---- Flora — trees & vegetation (world-graphics backlog items 177-196) ----
    // Mostly color/shape-only tuning (near-zero instance cost); the few that add
    // geometry (root flares, frost/moss dressing, the burnt landmark) are
    // thinned on the 'low' quality tier by flora-trees.js's own tierScale().
    TREE_HUE_JITTER: 0.05,          // per-tree canopy hue/lightness bias (item 195)
    TREE_CANOPY_AO: 0.16,           // interior-dark / edge-light canopy gradient (item 180)
    TREE_LOBE_WOBBLE: 0.22,         // per-tree canopy silhouette irregularity (item 181)
    TREE_ROOT_FLARE_CHANCE: 0.85,   // trunk-base flare frequency (item 193)
    TREE_BARK_FLECK_CHANCE: 0.16,   // non-birch bark groove flecks, skipped on 'low' (item 188)
    CACTUS_FULL_BLOOM_CHANCE: 0.09, // rare full flower-crown vs. single blossom (item 191)
    BURNT_TREE_LANDMARKS: 1,        // seeded scorched/lightning-struck landmark count (item 196)

    // ---- Creature visual-design pass (src/creatures/*, world-graphics-
    // improvements.md section 18, items 303-323) — appended block, does not
    // touch any existing key above.
    CREATURE_TIER_TRAIL_RATE: { uncommon: 0.5, rare: 1.8 }, // item 303: ambient per-second tier-tell trail chance (legendary has its own richer aura; common gets none)

    // ---- HUD/UI polish & accessibility (backlog items 403-436) ----
    // World-unit radius within which the off-screen legendary-creature HUD
    // indicator (item 416) activates — same order of magnitude as
    // SHADOW_FOLLOW_RADIUS/CAPTURE_RANGE above, tuned so it reads as "nearby"
    // rather than arena-wide.
    LEGENDARY_RADAR_RANGE: 45,

    // ---- Sky/weather/atmosphere additions (graphics backlog items 1-32, 197-214, 437-460) ----
    DAY_NIGHT_PERIOD: 420,          // item 1: seconds for one full day-arc; a short session sees one slice
    DAY_NIGHT_NIGHT_ELEV: 18,       // item 1: degrees — dimmer point of the CONTINUOUS subtle arc
    DAY_NIGHT_DAY_ELEV: 30,         // item 1: degrees — brighter point of the continuous arc
    DAY_NIGHT_AZIMUTH_SWING: 18,    // item 1: degrees the sun azimuth drifts through across the arc
    DAY_NIGHT_SEED_JITTER_DEG: 6,   // item 5: +/- per-seed elevation/azimuth variance so shadow direction differs per load
    NIGHT_EVENT_CHECK_MIN: 90,      // items 2/4: seconds between rolls of the chance to enter a rare night/dusk event
    NIGHT_EVENT_CHECK_SPAN: 90,
    NIGHT_EVENT_CHANCE: 0.4,        // odds a check actually enters the event (kept "rare", not guaranteed)
    NIGHT_EVENT_ENTER_TIME: 16,     // seconds to blend from day into the dip
    NIGHT_EVENT_HOLD_MIN: 40,       // seconds it lingers once fully in
    NIGHT_EVENT_HOLD_SPAN: 35,
    NIGHT_EVENT_EXIT_TIME: 20,      // seconds to blend back out to day
    STAR_COUNT: 220,                // item 17
    SHOOTING_STAR_CHANCE: 0.0006,   // item 445: per-frame odds of a shooting star while deep in the night dip
    FOG_ALTITUDE_REF: 5,            // item 25: camera-y reference height; fog thins above it, thickens below
    FOG_ALTITUDE_STRENGTH: 0.3,     // item 25: max +/- fraction of fogMul shifted by altitude
    FOG_ZONE_TINT_STRENGTH: 0.12,   // item 21: how much the local zone's colour leaks into fog colour
    FOG_STORM_FLASH_BOOST: 0.5,     // item 29: extra fogMul briefly added on a lightning flash
    WETNESS_RISE_RATE: 0.55,        // items 201/210: ground-wetness gain rate while rain/thunderstorm falls
    WETNESS_DECAY_RATE: 0.045,      // items 201/210: ground-wetness decay rate once precipitation stops
    PUDDLE_COUNT: 12,               // item 201: temporary puddle decals after rain
    STEAM_VENT_COUNT: 5,            // item 210: volcanic "steaming ground" wisps as wetness dries
    RAINBOW_FADE_TIME: 8,           // items 197/211: rainbow/fog-bow fade in/out duration (seconds)
    RAINBOW_HOLD_TIME: 20,          // items 197/211: seconds the rainbow lingers at full opacity
    CLOUD_SHADOW_COUNT: 5,          // items 8/442: tracked cloud-shadow blobs (subset of cluster centroids)
    POI_DISCOVER_RADIUS: 9,         // item 454: distance at which a POI's first-visit sparkle triggers
    HEAT_HAZE_COUNT: 10,            // item 203: desert heat-shimmer motes
    SNOW_DRIFT_COUNT: 10,           // item 209: snow-mound decals near tree bases

    // ============================================================
    // Phase 4c additions (world-graphics-improvements.md items 34/36/39/
    // 355/371/373/379/380 — see quality.js/lod.js/engine.js/gpu-detect.js).
    // Appended block; nothing above this line was touched for Phase 4c.
    // ============================================================

    // item 34: the sun-shadow follow frustum (CONFIG.SHADOW_FOLLOW_RADIUS
    // above) widens dynamically with player speed so fast-approaching
    // shadow-casters don't pop in mid-sprint. Reaches RADIUS_MAX at
    // SPEED_REF (world units/s, matches PLAYER_MAX_SPEED) and eases back
    // down at low speed.
    SHADOW_FOLLOW_RADIUS_MAX: 70,
    SHADOW_FOLLOW_SPEED_REF: 8.0,
    // item 39: extra PCFSoft shadow.radius blended in under heavy fog/
    // overcast (softens contrast instead of only tinting the fog itself).
    SHADOW_FOG_RADIUS_BOOST: 3,

    // item 373: a 4th tier above 'high' — manual-only (see quality.js's
    // ?quality=/?photo handling), never reached by the automatic FPS
    // stepper, matching gpu-detect.js's "only act on high-confidence
    // signals" stance (it can confirm a WEAK device, not a strong one).
    SHADOW_MAP_ULTRA: 4096,
    PIXEL_RATIO_ULTRA: 3,
    // item 379: emergency resolution-scale lever below PIXEL_RATIO_LOW for
    // a device that still can't hold FPS at 'low' (no tier left to step
    // down to). Floored so it degrades gracefully instead of unboundedly.
    PIXEL_RATIO_FLOOR: 0.6,
    PIXEL_RATIO_STEP: 0.85,

    // item 355/371: hysteresis band (fraction of the base radius) around
    // each CREATURE_LOD threshold so anim/shadow/simple state doesn't
    // flicker for a creature drifting right at the boundary distance.
    LOD_HYSTERESIS: 0.15,

    // ---- VFX backlog additions (items 243-268, 327-354; see
    // temp/world-graphics-improvements.md) ----

    // Particle pool — tiered budget (item 264): initParticlePool() picks a
    // size from these before quality.js has run its first sample (the
    // software-renderer probe is already known by then), and the pool
    // lazily resizes itself if state.qualityLevel changes later (the FPS
    // auto-scaler stepping the tier up/down).
    PARTICLE_POOL_HIGH: 320,
    PARTICLE_POOL_MEDIUM: 200,
    PARTICLE_POOL_LOW: 110,
    // Particle LOD (item 250): bursts/motes thin out with distance from camera.
    PARTICLE_LOD_NEAR: 20,          // full density inside this radius
    PARTICLE_LOD_FAR: 55,           // thinned to PARTICLE_LOD_MIN_FRACTION beyond this
    PARTICLE_LOD_MIN_FRACTION: 0.35,
    // Ground/impact decal (item 352) — reuses the water-ripple ring geometry.
    DECAL_LIFE: 2.2,

    // Ball flight VFX (items 247/338/343/344/347/351/354)
    BALL_STREAK_LEN_MUL: 0.9,        // motion-blur streak length per unit speed
    BALL_STREAK_WIDTH_MUL: 0.55,     // streak width, relative to BALL_RADIUS
    BALL_SPIN_RING_OPACITY: 0.3,
    BALL_TRAIL_WARN_FRACTION: 0.22,  // last fraction of BALL_DESPAWN_TIME the trail reddens
    BALL_PROXIMITY_TRAIL_BOOST: 1.6, // extra trail density near a hovered target
    RICOCHET_SPARK_BASE: 10,         // spark count at full energy, scaled by restitution
    WHIFF_RADIUS_MUL: 1.6,           // catchRadius multiplier for a "close whiff" grace zone
    WHIFF_SPARK_COUNT: 5,
    RICOCHET_SHAKE_MAG: 0.028,       // radians of camera roll on a maxed-out bounce chain
    RICOCHET_SHAKE_TIME: 0.3,

    // Viewmodel & player VFX (items 328-342)
    VM_CHARGE_GLOW_MAX: 0.85,
    VM_HOLSTER_GLOW_MAX: 0.4,
    BREATH_FOG_INTERVAL: 2.6,        // seconds between breath puffs in cold zones
    VIEW_BOB_FREQ_BASE: 9.0,         // rad/s at a standstill-adjacent walk
    VIEW_BOB_FREQ_SPEED: 7.0,        // extra rad/s at PLAYER_MAX_SPEED
    VIEW_BOB_AMPLITUDE: 0.028,       // world units of vertical camera bob at full tilt
    LANDING_FALL_MIN_SPEED: 4.5,     // minimum touchdown vy to spawn landing dust
    FOOTSTEP_STRIDE_LEN: 2.1,        // world units per footfall (surface dust/splash)
    FOOTSTEP_SPRINT_FRACTION: 0.72,  // fraction of PLAYER_MAX_SPEED counted as "sprinting"
    WADE_OVERLAY_FADE_TIME: 1.8,

    // Targeting VFX (items 345/348/349/350)
    RING_COLOR_EASE: 6.0,            // per-second smoothing rate for the ring's chance-color lerp
    TRAJECTORY_GHOST_STEPS: 22,
    TRAJECTORY_GHOST_DT: 0.045,

    // ---- Cave world/graphics backlog pass (sections 5/8/9/10 — items 79-94,
    // 129-176) — a single new tunable added by that pass; everything else
    // reused existing per-module magic numbers rather than growing this file.
    CAVE_VIGNETTE_MAX: 0.4, // item 173: peak screen-vignette opacity at the cave-mouth "eyes adjusting" transient

    // ============================================================
    // Section 23 — Procedural Variety & Seed Diversity pass
    // (world-graphics-improvements.md items 389-402). Appended block;
    // nothing above this line was touched for this pass. Every new
    // stream this pass adds uses its OWN independent mulberry32 salt
    // (never reuses/reorders an existing rng draw sequence), so all
    // 9 earlier passes' seeded layouts are otherwise undisturbed.
    // ============================================================
    ZONE_TWIN_CHANCE: 0.15,          // item 389: rare chance one non-anchor zone claims a 2nd sector (displacing a different one), beyond the existing full Fisher-Yates shuffle
    MOUNTAIN_SPIRE_SHAPE_EXP: 1.95,  // item 390: "spire" massif archetype's peak curve exponent (tall, narrow, near-zero secondary lobe)
    MOUNTAIN_MESA_SHAPE_EXP: 1.15,   // item 390: "mesa" massif archetype's peak curve exponent (broad, flatter-topped)
    CAVE_BRANCH_BIAS_STRENGTH: 0.4,  // item 391: how far a seed's "branchy vs linear" cave-topology personality shifts branch/chamber/feature odds
    WEATHER_PERSONALITY_STRENGTH: 0.5, // item 393: how far a seed's "stormy vs dry" weather personality skews WEATHER_BIAS's per-zone weights
    CREATURE_RARITY_SKEW_MAX: 0.8,   // item 394: max skew a "lucky seed" applies to uncommon/rare fill weights (commons/win-fuel deck untouched)
    CREATURE_LEGENDARY_BONUS_CHANCE: 0.12, // item 394: rare chance of one extra bonus legendary on a very lucky seed
    ZONE_PALETTE_HUE_JITTER: 0.035,  // item 396: max per-seed, per-zone hue nudge (fraction of 360deg) applied once to each zone's authored palette
    ZONE_PALETTE_LIGHT_JITTER: 0.05, // item 396: max per-seed, per-zone lightness nudge applied alongside the hue nudge
    RIVER_OXBOW_CHANCE: 0.35,        // item 397: odds this seed's main river gets a rare wide "lazy bend" belly (an oxbow-like slow, wide pool)
    RIVER_OXBOW_WIDTH_MUL: 2.2,      // item 397: peak extra channel width at the oxbow belly's centre
    CAVE_GEM_LUCKY_CHANCE: 0.15,     // item 398: odds this seed's caves are ALL unusually gem-rich (a discoverable "lucky seed" moment)
    CAVE_GEM_LUCKY_MUL: 2.2,         // item 398: crystal-cluster count multiplier on a gem-lucky seed
    SEED_THUMBNAIL_MAX_DIM: 256,     // item 399: max width/height (px) for the offline seed-preview thumbnail capture (foundation only)
    CLOUD_STREAK_BIAS_STRENGTH: 0.22, // item 400: how far a seed shifts the streaky-vs-puffy cloud-cluster profile threshold, beyond density-only variety
    FLORA_SPECIES_MIX_JITTER: 0.5,   // item 401: max per-seed, per-zone-per-species weight skew within a zone's existing allowed tree table

    // ============================================================
    // Audio-Visual Sync & Juice pass (world-graphics-improvements.md
    // Section 29, items 461-480). See src/camera-shake.js (new shared
    // screen-shake bus), music.js (beat/duck/mood-warmth getters),
    // capture.js (FOV punch/pull), particles.js (spawnFxRing), and the
    // per-file "item NNN" comments at each point of use. Appended block;
    // nothing above this line was touched for this pass.
    // ============================================================

    // item 461: how much the active mood's own pad-breathing LFO rate
    // (music.js's musicBeatPhase()) blends into otherwise-independent slow
    // ambient pulses (cave crystal shimmer, cloud opacity) for cohesion —
    // deliberately small; this is a "reads as related" nudge, not a hard sync.
    MUSIC_BEAT_VISUAL_MIX: 0.15,

    // item 462: thunderclap screen-shake, scaled by strike proximity (shares
    // src/camera-shake.js's bus with the existing item-353 ricochet shake and
    // the item-467 rock-rumble / item-477 golem-stomp shakes below). Strikes
    // rolled farther than the cutoff don't shake at all — only a genuinely
    // "nearby" clap should rattle the camera.
    THUNDER_SHAKE_MAG: 0.05,
    THUNDER_SHAKE_TIME: 0.5,
    THUNDER_SHAKE_FAR_CUTOFF: 0.55,

    // item 479: flash->thunder delay (ms), retuned so a genuinely CLOSE strike
    // reads as one frame-accurate event instead of the old flat 300ms floor
    // (audibly late even at "far=0"). MIN is a couple of frames — near-instant;
    // SPAN is added on top, scaled by strike distance (far, 0..1), preserving
    // the old far-strike ceiling (~2.5s).
    THUNDER_DELAY_MIN_MS: 40,
    THUNDER_DELAY_SPAN_MS: 2460,

    // item 463: small paired visual bursts for two audio cues that previously
    // had none of their own (only a behavior/movement change) — a bright
    // "alert" flash at the caller for playAlarmChirp, and a flutter-puff per
    // scattering bat for playBatScatter.
    ALARM_CHIRP_BURST_COUNT: 6,
    BAT_SCATTER_BURST_COUNT: 5,

    // item 465: stride length (world units) SHARED between caves-audio.js's
    // footstep SOUND cadence and player.js's footstep DUST cadence while in a
    // cave — both accumulate the identical state.player.velocity.length()*dt
    // each frame, so unifying this one constant (they previously used 1.7 vs
    // FOOTSTEP_STRIDE_LEN's 2.1) locks the two onto the same trigger frame
    // instead of slowly drifting in and out of phase.
    CAVE_FOOTSTEP_STRIDE_LEN: 1.7,

    // item 466: expanding "sonar ping" ring synced to playEchoCall's onset
    // (cave echo-locator creatures) — a second flavor of particles.js's
    // spawnFxRing, distinct from the existing burst-of-motes visual.
    ECHO_RIPPLE_LIFE: 0.5,
    ECHO_RIPPLE_MAX_SCALE: 3.4,

    // item 467: rock-collapse screen-shake, paired with the existing
    // falling-rock + dust + playRockRumble() drama in caves-gameplay.js
    // (which already fires all of those in one synchronous call — this was
    // the one missing beat).
    ROCK_RUMBLE_SHAKE_MAG: 0.022,
    ROCK_RUMBLE_SHAKE_TIME: 0.6,

    // item 464: FOV kick on a legendary capture success — paired with
    // playLegendarySting() (previously only a proximity cue) reused here as
    // the capture-success flourish alongside the existing playSuccessChime().
    LEGENDARY_CAPTURE_FOV_PUNCH: 6,   // degrees, decays back to base
    LEGENDARY_CAPTURE_FOV_TIME: 0.5,

    // item 475: FOV narrowing (lens-pull toward the ball) eased across the
    // capture suck-in phase, peaking mid-suck and releasing by CATCH_SUCK_TIME
    // — see capture.js's updateFovFx.
    CATCH_SUCK_FOV_PULL: 2.5,         // degrees

    // item 476: a small pulse-flash paired with each playWobbleTick hit,
    // additional to the already frame-exact rock/squash + dust/ripple.
    WOBBLE_TICK_FLASH_LIFE: 0.16,

    // item 477: distinct LOW-frequency screen-shake for magmaGolem/
    // crystalGolem footfalls (detected as a zero-crossing of the existing
    // per-frame leg-sway sine in animate.js's 'golem' case) — reuses
    // playThump() (audio.js's existing generic impact thump) rather than
    // synthesizing new audio, paired with a per-species dust puff. Only cues
    // for a golem within GOLEM_STOMP_RANGE of the camera.
    GOLEM_STOMP_SHAKE_MAG: 0.02,
    GOLEM_STOMP_SHAKE_TIME: 0.28,
    GOLEM_STOMP_SHAKE_FREQ: 17,        // rad/s — well below camera-shake.js's 53 default: reads as a heavy thud, not a rattle
    GOLEM_STOMP_RANGE: 30,

    // item 478: splash-ring size multiplier ceiling — a capture ball settling
    // into water sizes its ripple by the CAUGHT creature's tier (a stand-in
    // for "what fell in" weight: common ~1x up to a legendary at this ceiling)
    // instead of every splash using the same fixed ring size regardless of
    // what's inside the ball.
    SPLASH_RING_WEIGHT_MAX: 2.6,

    // item 471: brief exposure/hemi dip ("the world holds its breath") while
    // music.js's crossfadeTo() is actively blending to a new mood — a short
    // attack into the dip, a longer release back out across the crossfade.
    MUSIC_DUCK_VISUAL_DIP: 0.05,
    MUSIC_DUCK_ATTACK: 0.18,
    MUSIC_DUCK_RELEASE: 1.6,

    // item 480: subtle global color-grade nudge from the active music mood's
    // warmth (musicMoodWarmth() in music.js) plus a cooler push while a
    // breakout's adrenaline is fresh (state.breakoutTenseT, set by capture.js).
    // Deliberately small — a mood tint, not a filter.
    MOOD_COLOR_GRADE_STRENGTH: 0.05,
    BREAKOUT_TENSE_TIME: 4.0,

    // item 473: crystal-chime ripple-ring, precisely time-locked to
    // playCrystalChime's onset (caves-decor.js's ball-strike chime handler),
    // distinct from the existing general shimmer/flash glow pulse.
    CRYSTAL_CHIME_RIPPLE_LIFE: 0.4,
    CRYSTAL_CHIME_RIPPLE_SCALE: 1.6,
};
