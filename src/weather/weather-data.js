/* ============================================================
   Weather Data — states & zone bias (pure)
   ------------------------------------------------------------
   Phase 2c. Seven procedural weather states, each a small recipe
   of MULTIPLIERS against the engine's baseline sky/fog/sun (so a
   re-tuned baseline carries through), plus a precipitation spec,
   a wind level and (for thunderstorms) a lightning flag.

   WEATHER_BIAS steers the seeded next-state roll by the zone the
   player is standing in: snow/ice/alpine favour snowfall, swamp
   favours fog, desert stays clear/windy with only rare rain,
   volcanic greys over with ashy overcast/wind, jungle storms.
   ============================================================ */

// fogMul/sunMul/hemiMul/skyFillMul/exposureMul multiply the captured baseline;
// turbidity/rayleigh are absolute Sky targets; fogColor is an absolute hex.
// precip: null | { kind:'rain'|'snow', rate } ; wind is the gust level [0..1.2].
// hemiSky/hemiGround (item 9, graphics-backlog): absolute HemisphereLight sky/
// ground colours per state, so overcast/storm read visibly desaturated-cool
// and windy reads dusty-warm — not just dimmer, but differently TINTED.
export const WEATHER_STATES = {
    clear: {
        fogMul: 1.0, sunMul: 1.0, hemiMul: 1.0, skyFillMul: 1.0, exposureMul: 1.0,
        turbidity: 2.4, rayleigh: 2.0, fogColor: 0xf2dcb3,
        hemiSky: 0xbdd8f5, hemiGround: 0x96804f,
        precip: null, wind: 0.15, lightning: false,
    },
    overcast: {
        fogMul: 3.2, sunMul: 0.42, hemiMul: 0.78, skyFillMul: 1.15, exposureMul: 0.78,
        turbidity: 9.0, rayleigh: 0.8, fogColor: 0xb8bcbc,
        hemiSky: 0x9aa4ad, hemiGround: 0x746a5c,
        precip: null, wind: 0.4, lightning: false,
    },
    rain: {
        fogMul: 5.5, sunMul: 0.3, hemiMul: 0.7, skyFillMul: 1.2, exposureMul: 0.68,
        turbidity: 11.0, rayleigh: 0.6, fogColor: 0x9aa2a8,
        hemiSky: 0x7d8b96, hemiGround: 0x5c5a52,
        precip: { kind: 'rain', rate: 1.0 }, wind: 0.55, lightning: false,
    },
    thunderstorm: {
        fogMul: 7.0, sunMul: 0.22, hemiMul: 0.5, skyFillMul: 1.25, exposureMul: 0.58,
        turbidity: 13.0, rayleigh: 0.5, fogColor: 0x767c84,
        hemiSky: 0x565f6b, hemiGround: 0x40404a,
        precip: { kind: 'rain', rate: 1.5 }, wind: 0.85, lightning: true,
    },
    snowfall: {
        fogMul: 4.5, sunMul: 0.58, hemiMul: 0.95, skyFillMul: 1.1, exposureMul: 0.9,
        turbidity: 7.0, rayleigh: 1.0, fogColor: 0xdae2ea,
        hemiSky: 0xcfe0ee, hemiGround: 0x9aa6ad,
        precip: { kind: 'snow', rate: 1.0 }, wind: 0.4, lightning: false,
    },
    fog: {
        fogMul: 22.0, sunMul: 0.42, hemiMul: 0.8, skyFillMul: 1.1, exposureMul: 0.78,
        turbidity: 10.0, rayleigh: 0.7, fogColor: 0xc2c6c4,
        hemiSky: 0xb7bcc0, hemiGround: 0x8e897f,
        precip: null, wind: 0.2, lightning: false,
    },
    windy: {
        fogMul: 1.5, sunMul: 0.9, hemiMul: 1.0, skyFillMul: 1.0, exposureMul: 0.97,
        turbidity: 4.0, rayleigh: 1.6, fogColor: 0xe6dcc4,
        hemiSky: 0xcfd0c0, hemiGround: 0x9c8f68,
        precip: null, wind: 1.1, lightning: false,
    },
};

// Per-zone weighted next-state tables (id -> [[state, weight], ...]).
export const WEATHER_BIAS = {
    meadow: [['clear', 4], ['windy', 2], ['overcast', 2], ['rain', 1], ['fog', 1]],
    lakeside: [['clear', 3], ['overcast', 2], ['rain', 2], ['fog', 1.5], ['windy', 1]],
    autumn: [['overcast', 3], ['windy', 2], ['rain', 2], ['fog', 1], ['clear', 2]],
    jungle: [['rain', 4], ['thunderstorm', 2], ['overcast', 2], ['clear', 1]],
    swamp: [['fog', 4], ['overcast', 3], ['rain', 2], ['thunderstorm', 1]],
    desert: [['clear', 5], ['windy', 3], ['overcast', 1], ['rain', 0.4]],
    rocky: [['overcast', 3], ['windy', 3], ['clear', 2], ['fog', 1], ['snowfall', 1]],
    mushroom: [['fog', 3], ['overcast', 2], ['clear', 2], ['rain', 1]],
    snow: [['snowfall', 5], ['overcast', 2], ['fog', 2], ['clear', 1]],
    ice: [['snowfall', 4], ['fog', 2], ['overcast', 2], ['clear', 1]],
    alpine: [['snowfall', 3], ['overcast', 2], ['windy', 2], ['fog', 2], ['clear', 2]],
    volcanic: [['overcast', 3], ['windy', 3], ['clear', 2], ['fog', 1]],
};

export const WEATHER_DEFAULT_BIAS = [['clear', 4], ['overcast', 2], ['windy', 1], ['rain', 1], ['fog', 1]];

// States allowed on the 'low' quality tier: sky/fog/lighting recipes only, no
// precipitation particle systems (rain streaks / snow points / lightning).
// 'low' used to force weather permanently to 'clear' — reasonable when it was
// a rare fallback for a device that had visibly struggled, but gpu-detect.js
// now seeds 'low' immediately for any confirmed software renderer, making it
// the default starting tier for a lot of real traffic. Zones still read
// visibly different (a swamp stays foggier, a snow zone stays overcast more
// often) without paying for particles.
export const WEATHER_LOW_TIER_STATES = new Set(['clear', 'overcast', 'windy', 'fog']);

// item 393: state groupings used by weather.js's rollNext() to apply a
// seed-driven weather PERSONALITY on top of (never replacing) the fixed
// per-zone WEATHER_BIAS tables above — some seeds trend stormier, some drier.
export const WEATHER_STORMY = new Set(['rain', 'thunderstorm', 'snowfall', 'overcast', 'fog']);
export const WEATHER_CALM = new Set(['clear', 'windy']);

/* ============================================================
   Day/Night & Celestial (graphics-backlog items 1,2,4,5,10,17,
   440,445) — pure data, applied by weather.js's day/night layer.
   ------------------------------------------------------------
   Two independent layers, both multiplying/tinting the SAME
   captured baseline the weather recipes above already multiply,
   so nothing here fights WEATHER_STATES — it just moves what
   "baseline" means before weather's own mul is applied on top:

   1) A continuous, subtle "dayPhase" arc (item 1) — the sun disc
      slowly rides between a dimmer and a brighter elevation over
      a multi-minute session; always on, deliberately gentle
      (short CAPTCHA session, not an open-world day cycle).
   2) A rare, independently-scheduled "night event" (items 2/4/10/
      17/440/445) — a deeper dusk-to-moonlit dip that occasionally
      rolls in (like a weather state, on its own seeded timer),
      warms into a dusk rim first (item 2), then cools toward a
      moonlit palette with the sun disc itself recolouring into a
      moon (item 4/440) and stars/aurora fading in — rather than a
      literal second night skybox.
   ============================================================ */
export const DAY_NIGHT = {
    dayHemiFloor: 0.6,     // never dims hemi/skyFill/exposure below this fraction (stays solvable)
    nightMinElev: 4,       // degrees — the rare night-event's deepest sun dip (still above horizon)
    nightSunColor: 0xaecbff,   // cool "moon" tint the sun disc recolours toward (item 4/440)
    nightHemiSky: 0x1f2a44,
    nightHemiGround: 0x12141f,
    nightFogTint: 0x1c2438,
    duskSunColor: 0xffb066,    // warm rim tint on the way down into the dip (item 2)
    duskWarmPeak: 0.35,       // nightT at which the warm dusk tint peaks before cooling to moonlight
};

// Zones that can host the rare aurora ribbon during a night event (item 10) —
// alpine/ice/snow read as the "cold sky" biomes worth the extra ribbon draw.
export const AURORA_ZONES = new Set(['alpine', 'ice', 'snow']);

// Per-zone Sky bias (items 3/16): small deltas ADDED to the weather-blended
// turbidity/rayleigh/exposureMul so e.g. Ember Flats reads hazier and Frozen
// Reaches reads crisper even under the identical `clear` state.
export const ZONE_SKY_BIAS = {
    meadow: { turbidity: 0, rayleigh: 0, exposureMul: 0 },
    lakeside: { turbidity: -0.3, rayleigh: 0.15, exposureMul: 0.01 },
    autumn: { turbidity: 0.4, rayleigh: -0.1, exposureMul: -0.01 },
    jungle: { turbidity: 1.1, rayleigh: -0.25, exposureMul: -0.03 },
    swamp: { turbidity: 1.6, rayleigh: -0.35, exposureMul: -0.04 },
    desert: { turbidity: 1.8, rayleigh: -0.2, exposureMul: 0.03 },
    rocky: { turbidity: 0.3, rayleigh: 0.1, exposureMul: 0 },
    mushroom: { turbidity: 0.9, rayleigh: -0.2, exposureMul: -0.03 },
    snow: { turbidity: -0.6, rayleigh: 0.35, exposureMul: 0.02 },
    ice: { turbidity: -0.8, rayleigh: 0.45, exposureMul: 0.02 },
    alpine: { turbidity: -0.5, rayleigh: 0.3, exposureMul: 0.01 },
    volcanic: { turbidity: 2.2, rayleigh: -0.3, exposureMul: -0.02 },
};

// Rainbow/fog-bow eligibility (items 197/211): landing on `clear` FROM one of
// these states is what triggers the arc, keyed to which visual variant it gets.
export const RAINBOW_FROM = {
    rain: 'rainbow', thunderstorm: 'rainbow', fog: 'fogbow',
};
