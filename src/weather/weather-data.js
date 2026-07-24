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
export const WEATHER_STATES = {
    clear: {
        fogMul: 1.0, sunMul: 1.0, hemiMul: 1.0, skyFillMul: 1.0, exposureMul: 1.0,
        turbidity: 2.4, rayleigh: 2.0, fogColor: 0xf2dcb3,
        precip: null, wind: 0.15, lightning: false,
    },
    overcast: {
        fogMul: 3.2, sunMul: 0.42, hemiMul: 0.78, skyFillMul: 1.15, exposureMul: 0.78,
        turbidity: 9.0, rayleigh: 0.8, fogColor: 0xb8bcbc,
        precip: null, wind: 0.4, lightning: false,
    },
    rain: {
        fogMul: 5.5, sunMul: 0.3, hemiMul: 0.7, skyFillMul: 1.2, exposureMul: 0.68,
        turbidity: 11.0, rayleigh: 0.6, fogColor: 0x9aa2a8,
        precip: { kind: 'rain', rate: 1.0 }, wind: 0.55, lightning: false,
    },
    thunderstorm: {
        fogMul: 7.0, sunMul: 0.22, hemiMul: 0.5, skyFillMul: 1.25, exposureMul: 0.58,
        turbidity: 13.0, rayleigh: 0.5, fogColor: 0x767c84,
        precip: { kind: 'rain', rate: 1.5 }, wind: 0.85, lightning: true,
    },
    snowfall: {
        fogMul: 4.5, sunMul: 0.58, hemiMul: 0.95, skyFillMul: 1.1, exposureMul: 0.9,
        turbidity: 7.0, rayleigh: 1.0, fogColor: 0xdae2ea,
        precip: { kind: 'snow', rate: 1.0 }, wind: 0.4, lightning: false,
    },
    fog: {
        fogMul: 22.0, sunMul: 0.42, hemiMul: 0.8, skyFillMul: 1.1, exposureMul: 0.78,
        turbidity: 10.0, rayleigh: 0.7, fogColor: 0xc2c6c4,
        precip: null, wind: 0.2, lightning: false,
    },
    windy: {
        fogMul: 1.5, sunMul: 0.9, hemiMul: 1.0, skyFillMul: 1.0, exposureMul: 0.97,
        turbidity: 4.0, rayleigh: 1.6, fogColor: 0xe6dcc4,
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
