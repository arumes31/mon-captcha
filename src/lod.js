/* ============================================================
   Distance LOD (Phase 4b, item 344)
   ------------------------------------------------------------
   Proximity-scaled detail so standing cost tracks what is near the
   player, not the whole world:

     - CREATURES: beyond `anim` radius, secondary animation is
       amortized (every 3rd frame); beyond `simple` radius it is
       dropped to a simplified state (no per-part animation at all);
       beyond `shadow` radius the creature stops casting a shadow.
     - FLORA: detail-flora sectors beyond a ring stop drawing
       (enforced in culling.js via floraLodRadius()).

   Radii are per quality tier and the tier machine (quality.js) drives
   them through applyLodTier(). LOW always culls SOONER than MEDIUM,
   which culls sooner than HIGH — low is always the cheaper tier. HIGH
   is deliberately GENEROUS (radii wider than the arena) so the golden
   'high' tier — the one the 4a visreg baselines were minted on — sees
   NO visual change from this phase; the savings land on medium/low
   (weaker devices), which is where they matter.
   ============================================================ */

import { CONFIG } from './config.js';
import { state } from './state.js';

// { anim, shadow, simple } world-unit radii. Arena half-extent is 50, so a
// 'high' radius >= ~60 never triggers inside the play space (no visual change).
const CREATURE_LOD = {
    // item 373: 'ultra' is a stronger-GPU tier (see quality.js) — LOD itself
    // doesn't need to be MORE generous than 'high' (already never triggers
    // inside the arena), so it mirrors 'high' exactly; ultra's win is
    // elsewhere (shadow-map size, bloom, pixel ratio).
    ultra:  { animSq: 25 * 25, shadowSq: 999 * 999, simpleSq: 999 * 999 },
    high:   { animSq: 25 * 25, shadowSq: 999 * 999, simpleSq: 999 * 999 },
    medium: { animSq: 20 * 20, shadowSq: 30 * 30,   simpleSq: 46 * 46 },
    low:    { animSq: 14 * 14, shadowSq: 18 * 18,   simpleSq: 32 * 32 },
};

// Detail-flora ring radius (world units). >= 9000 means "never" (high tier).
const FLORA_RING = { ultra: 9999, high: 9999, medium: 60, low: 42 };

let _c = CREATURE_LOD.high;
let _flora = FLORA_RING.high;

// Bound to the quality-tier state machine (quality.js applyQualityTier()).
export function applyLodTier(tier) {
    _c = CREATURE_LOD[tier] || CREATURE_LOD.high;
    _flora = (FLORA_RING[tier] != null) ? FLORA_RING[tier] : FLORA_RING.high;
}

export function floraLodRadius() { return _flora; }

// Toggle a creature's shadow casting only on transitions (touching every part
// each frame would defeat the point). c.parts is the flat mesh list.
function setCreatureShadow(c, on) {
    if (c._shadowOn === on) return;
    c._shadowOn = on;
    const parts = c.parts;
    if (!parts) return;
    for (let i = 0; i < parts.length; i++) parts[i].castShadow = on;
}

// items 355 + 371: hysteresis so a creature drifting right at a threshold
// doesn't flicker between LOD/shadow states every frame (355 covers the
// anim/simple thresholds; 371's "shadow pop" is the same flicker applied to
// the shadow toggle, so one mechanism fixes both). `wasFar` is the state's
// PREVIOUS classification; crossing back requires the tighter of the two
// bounds, so the state only flips once it has cleared a real band, not a
// single noisy sample right on the line.
function hysteresisFar(wasFar, distSq, thresholdSq) {
    const band = CONFIG.LOD_HYSTERESIS;
    return wasFar
        ? distSq > thresholdSq * (1 - band)   // already far: must come well back inside to clear it
        : distSq > thresholdSq * (1 + band);  // already near: must go well beyond to become far
}

/* ------------------------------------------------------------
   Per-creature LOD. Sets shadow state as a side effect; returns an
   animation code the behaviour loop gates on:
     0 = full secondary animation
     1 = amortized (caller runs it every 3rd frame)
     2 = simplified (caller skips secondary animation entirely)
   ------------------------------------------------------------ */
export function creatureLod(c, distSq) {
    const shadowFar = hysteresisFar(!!c._shadowFar, distSq, _c.shadowSq);
    c._shadowFar = shadowFar;
    setCreatureShadow(c, !shadowFar);

    const simpleFar = hysteresisFar(!!c._simpleFar, distSq, _c.simpleSq);
    c._simpleFar = simpleFar;
    if (simpleFar) return 2;

    const animFar = hysteresisFar(!!c._animFar, distSq, _c.animSq);
    c._animFar = animFar;
    return animFar ? 1 : 0;
}
