/* ============================================================
   3D Voxel CAPTCHA - main.js (High-Res Voxel Rework)
   ------------------------------------------------------------
   Thin ES module entry point. The engine, world, creatures and
   game loop live in ./src/*.js modules (browser-native ESM;
   'three' resolves via the CDN importmap in the host page).
   Exposes a public API on window.__captcha.

   Features:
     - Beautiful procedural voxel world, RANDOMIZED EVERY LOAD (seeded hills,
       center lake, baked AO) with guaranteed structure: pond, flat spawn
       meadow, a landmark mountain with waterfall + spring basin + magma
       vent, and a winding wadeable river feeding the pond
     - High-fidelity environment (multi-species trees, logs, bushes, reeds,
       river banks, lily pads, mushrooms, grass)
     - Golden-hour atmosphere (warm sun, layered drifting clouds, fireflies,
       falling leaves, distant birds, waterfall rush)
     - Data-driven bestiary: 51 creature types from 24 voxel body plans, each
       with a unique movement/behaviour combo — swimmers patrol pond AND
       river, true fliers (dragonfly/owl/bat/hummingbird/phoenix) fly real
       altitude patterns, sizes span tiny (~0.35x) to megafauna (~2.8x)
     - Intelligence layer: ball-dodging with readable tells, cover-seeking
       flight, preferred-range keeping, same-species alarm calls
     - Legendary presence: 1-2 per world, aura sparkles + proximity sting
     - First-person movement with Space-to-jump and river wading
     - Physics-based projectile throwing (a detailed two-tone voxel capture
       ball, held in a first-person viewmodel, tumbling in flight with a
       sparkle trail)
     - Palworld-style capture flow: hover targeting ring + "Capture XX%"
       readout, tier-based capture rates with a back-strike bonus, suck-in,
       three ball wobbles, then a golden click — or a panicked breakout
     - Tier-weighted win: commons score 1 point, rarer types 2 — 6 points solve
     - Interactive reticle (HUD reticle that reacts to hovering targets)
     - Real-time adaptive graphics quality scaling
     - Built-in audio synthesizer (throw whoosh, wobble ticks, success chime,
       breakout burst, capture pop, thump, splash, alarm chirps, legendary
       sting, looping waterfall)
   ============================================================ */

import { state } from './src/state.js';
import { init, destroy } from './src/game.js';

/* ============================================================
   Public API Expose
   ============================================================ */
const publicAPI = {
    init,
    destroy,
    getCreaturesCaught: () => state.creaturesCaught,
    getIsCaptchaSolved: () => state.isCaptchaSolved,
    getToken: () => state.token,
    getFps: () => Math.round(state.fps),
    getQualityLevel: () => state.qualityLevel,
};

if (typeof window !== 'undefined') {
    window.__captcha = publicAPI;
    
    // Auto-init if script loaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => init());
    } else {
        init();
    }
}

export default publicAPI;
export const init_ = init;
export const destroy_ = destroy;
