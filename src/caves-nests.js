/* ============================================================
   Cave NESTS / eggs — Phase 2j item 74 (environmental storytelling)
   ------------------------------------------------------------
   Static decor pushed through the 2e theme `decorate` hook (via the
   DecorKit), so it rides the CULLED per-cave layer for free and is
   disposed with the cave — the core cave files are never touched.

   A nest = a small twig/pebble RIM ring on a chamber floor (where the
   cave life gathers) cradling a CLUTCH of faintly-luminous eggs (soft
   emissive so they read in the dark bat/fungal chambers). Placement
   scales with the tier density profile. Registered from caves-themes.js
   on the bat / fungal / flooded themes.
   ============================================================ */

import { getGroundY } from './heightfield.js';

export function addNests(kit, cave, ctx, eggHue = 0xe0d6c2) {
    const { rng, profile } = ctx, ds = profile.densityScale;
    const spots = (cave.chambers || []).map(c => ({ x: c.x, z: c.z }));
    if (!spots.length) return;
    const nNests = Math.max(1, Math.round(spots.length * 0.8 * ds));
    for (let s = 0; s < nNests && s < spots.length; s++) {
        const sp = spots[s];
        // tuck the nest off-centre (against a wall-ish spot), not dead centre
        const off = 0.6 + rng() * 0.7, ang = rng() * Math.PI * 2;
        const nx = sp.x + Math.cos(ang) * off, nz = sp.z + Math.sin(ang) * off;
        const gy = getGroundY(nx, nz), rim = 0.5 + rng() * 0.15;
        // twig / pebble rim
        const twigs = 8 + Math.floor(rng() * 5);
        for (let i = 0; i < twigs; i++) {
            const a = (i / twigs) * Math.PI * 2 + rng() * 0.3, rr = rim + rng() * 0.12;
            const x = nx + Math.cos(a) * rr, z = nz + Math.sin(a) * rr;
            kit.rock(x, gy + 0.06, z, 0.16 + rng() * 0.12, 0.1, 0.16 + rng() * 0.12,
                rng() < 0.5 ? 0x3a2f22 : 0x2a241c, 0, a, (rng() - 0.5) * 0.3);
        }
        // clutch of pale, softly glowing eggs
        const eggs = 3 + Math.floor(rng() * 3);
        for (let i = 0; i < eggs; i++) {
            const a = rng() * Math.PI * 2, rr = rng() * rim * 0.5, sz = 0.13 + rng() * 0.06;
            kit.emit(eggHue, nx + Math.cos(a) * rr, gy + 0.09, nz + Math.sin(a) * rr, sz, sz * 1.4, sz, 0, rng() * Math.PI, 0);
        }
    }
}
