/* ============================================================
   Cave THEME registry + decoration-registration API (Phase 2e)
   ------------------------------------------------------------
   THE KEYSTONE the whole CAVE DEPTH PROGRAM (Phases 2f–2l) keys
   off. Every cave carries a seeded `theme` (set in caves-data.js);
   this module is the single extension point where a later phase
   plugs THEME-SPECIFIC decoration / lights / particles / creatures
   / audio into a cave WITHOUT touching the core cave files
   (caves.js render, caves-data.js generation, heightfield.js
   fields). Downstream phases add or grow a THEME PACK (see
   caves-themes.js) and register it here — they never edit the core.

   TAXONOMY — six themes (frozen for the program):
     crystal      luminous crystal-forest cave (item set 57–64 hangs here)
     bat          guano-floored bat roost, ceiling colonies (item 65, 90…)
     fungal       mushroom/fungi overgrowth (item set 49–56)
     flooded      the ONE wet cave — underground pool (item set 39–48).
                  RESERVED for the seed-chosen wet cave; never dry.
     mineral-ore  ore veins / metallic glints (rock item set 17–20…)
     geode        crystal-lined geode pockets, hero crystals (57–58…)

   REGISTRATION CONTRACT — registerCaveTheme(theme, descriptor):
   `descriptor` is a plain object; EVERY field is OPTIONAL, so a
   theme pack implements only the hooks it needs. The core calls
   them at well-defined moments and gracefully skips absent ones.

     label         string, human name (docs/debug).
     glowHue(cave) -> hex color for the theme's accent (crystals,
                   glow props, accent light). Return undefined to
                   fall back to the host-zone hue.
     spawnBias     [creatureId,…] — creature types this theme prefers
                   (Phase 2j reads this to bias cave-dweller spawns).
     decorate(ctx) BUILD-TIME. Push extra rock/glow/drip descriptors
                   and props via ctx (see BUILD CONTEXT below). Runs
                   once, inside buildCaves, after the core dressing.
     lights(ctx)   BUILD-TIME. Register extra PointLights via
                   ctx.addLight(...) (auto-culled with the cave).
     particles(ctx)BUILD-TIME. Reserved for theme particle systems.
     update(u)     PER-FRAME, but ONLY while the cave is observed
                   (band !== 'far' — see the culling in caves.js).
                   u = { cave, ci, band, dt, elapsed, near, mid }.
     dispose(cave) TEARDOWN. Release anything the theme allocated.

   BUILD CONTEXT (ctx) passed to decorate/lights/particles:
     { cave, ci, theme, rng, profile, low,
       rock, glow, drips,          // arrays: push voxel/prop/drip descriptors
       addLight(color,intensity,dist,x,y,z,flick),  // lights() only
       helpers: { getGroundY, addSpike, addCrystalCluster,
                  addGlowMushroom, perpOf, THREE } }
     - rock  descriptor: {x,y,z,sx,sy,sz,color,rx,ry,rz}  (dark shell mat)
     - glow  descriptor: {x,y,z,sx,sy,sz,rx,ry,rz,bright} (emissive, cave hue)
     - drip  descriptor: {x,z,topY,floorY,phase,speed,pool[,ci]}
     Props pushed to `glow`/`drips` are CULLED + LOD'd for free (they
     live in the per-cave culled layer). Props pushed to `rock` join
     the always-on shell — reserve that for structural/landmark rock.

   QUALITY-TIER density (item 100): caveTierProfile(quality) returns
   the per-tier knobs the core AND theme packs scale their prop /
   light / particle counts by, so low stays cheap and high stays rich.
   ============================================================ */

// Frozen taxonomy — the six cave themes (order = default distribution bag).
export const CAVE_THEMES = ['crystal', 'bat', 'fungal', 'flooded', 'mineral-ore', 'geode'];
// The dry themes a normal (non-wet) cave may take. `flooded` is reserved for
// the seed-chosen wet cave so a dry cave is never tagged flooded.
export const DRY_CAVE_THEMES = ['crystal', 'bat', 'fungal', 'mineral-ore', 'geode'];

const registry = new Map();

// Register (or replace) a theme's decoration descriptor. Idempotent — a later
// phase re-registering a richer pack overrides the 2e stub cleanly.
export function registerCaveTheme(theme, descriptor) {
    if (!CAVE_THEMES.includes(theme)) {
        console.warn('[caves] unknown cave theme registered:', theme);
    }
    registry.set(theme, Object.assign({ theme }, descriptor));
    return registry.get(theme);
}

// Resolve a cave's descriptor. Falls back to `crystal` (always registered) so
// callers never get undefined even if a theme string is somehow unrecognized.
export function getCaveThemeDescriptor(theme) {
    return registry.get(theme) || registry.get('crystal') || { theme, label: theme };
}

export function caveThemeRegistered(theme) { return registry.has(theme); }
export function registeredCaveThemes() { return [...registry.keys()]; }

// Host-zone accent hue — the Phase 2b default a theme falls back to when its
// glowHue returns undefined (so the wet/teal + per-zone look is preserved
// exactly until a later phase gives a theme its own colour). Pure mapping,
// no imports, so both caves.js and caves-themes.js can share it cycle-free.
export function zoneGlowHue(zoneId) {
    switch (zoneId) {
        case 'mushroom': return 0xc77dff;
        case 'volcanic': return 0xff8a3c;
        case 'ice': case 'snow': case 'alpine': return 0x8fe4ff;
        case 'jungle': case 'meadow': return 0x7dffb0;
        case 'desert': return 0xffd27a;
        default: return 0x6fe3ff;
    }
}

/* ------------------------------------------------------------
   Quality-tier density profile (item 100). One table the core and
   every theme pack read so the whole cave layer scales together:
   fewer props / lights / particles on low, full richness on high,
   a sensible middle on medium.
   ------------------------------------------------------------ */
export function caveTierProfile(quality) {
    if (quality === 'low') {
        return {
            tier: 'low',
            densityScale: 0.5,   // multiplies build-time prop probabilities/counts
            crystalsPerCluster: 1,
            mushrooms: false,    // hard-off on low (matches Phase 2b behavior)
            drips: false,        // hard-off on low
            lightsPerCave: 2,
            lightMul: 0.66,      // dimmer interior lights (5 / 4 vs 7.5 / 6)
            poolLight: true,
            glowPulse: true,
        };
    }
    if (quality === 'medium') {
        return {
            tier: 'medium',
            densityScale: 0.8,
            crystalsPerCluster: 2,
            mushrooms: true,
            drips: true,
            lightsPerCave: 2,
            lightMul: 0.85,
            poolLight: true,
            glowPulse: true,
        };
    }
    return {
        tier: 'high',
        densityScale: 1.0,
        crystalsPerCluster: 3,
        mushrooms: true,
        drips: true,
        lightsPerCave: 2,
        lightMul: 1.0,
        poolLight: true,
        glowPulse: true,
    };
}
