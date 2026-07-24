/* ============================================================
   Mountain placement (pure) — the seeded massif registry
   ------------------------------------------------------------
   Phase 2m: the world grew from ONE alpine peak to SEVERAL seeded
   mountains that dominate the skyline. This module owns their
   layout so heightfield.js (already at its line ceiling) stays lean.

   Each mountain = { x, z, r, peak, primary }:
     r    : base radius (how wide the massif spreads)
     peak : height it rises above the base terrain at its centre
   The PRIMARY mountain is the original alpine peak (it hosts the
   waterfall / spring basin / magma vent, whose geometry keys off
   L.MX/MZ/R_MT/PEAK), so it is emitted first with L's exact params.
   The extra massifs are bigger, placed in fitting rim zones (rocky
   highlands, the alpine flank, a free rim sector), clear of the
   spawn side, the central pond hub, each other, the magma vent and
   the border-river bearing so nothing collides.

   mountainRise(x,z,mountains) is summed into heightfield.baseHeight;
   for the primary it reproduces the old inline cone EXACTLY.
   ============================================================ */

import { worldNoise, mulberry32 } from '../random.js';

// Smallest signed angular difference a-b in (-PI, PI].
function angDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
}

// Summed cone height at (x,z) over all mountains. Ridged (angular noise breaks
// the silhouette) with craggy micro-detail — the exact formula the single peak
// used, so the primary massif is byte-identical to the pre-2m terrain.
//
// Item 123 (silhouette variety): non-primary massifs additionally sum a SECOND,
// offset lobe — a smaller sub-peak riding one flank of the main cone — so a
// multi-mountain seed reads as a ridgeline rather than one dominant cone
// repeated at a different size. The primary is deliberately left untouched:
// it anchors the waterfall/basin/vent bearing math elsewhere and this file's
// contract promises it stays byte-identical to the pre-2m single-peak formula.
export function mountainRise(x, z, mountains) {
    let rise = 0;
    for (let i = 0; i < mountains.length; i++) {
        const mt = mountains[i];
        const mdx = x - mt.x, mdz = z - mt.z;
        const dm = Math.sqrt(mdx * mdx + mdz * mdz);
        if (dm < mt.r) {
            const am = Math.atan2(mdz, mdx);
            const ridges = 0.82 + 0.22 * worldNoise(Math.cos(am) * 4 + 50, Math.sin(am) * 4 + 50, 2, 2.0, 0.5);
            const t = 1 - dm / mt.r;
            rise += mt.peak * Math.pow(t, 1.55) * ridges
                + worldNoise(x * 0.35 + 9, z * 0.35 - 9, 2, 2.0, 0.5) * 0.5 * t; // craggy detail
        }
        if (!mt.primary && mt.subAng !== undefined) {
            const sx = mt.x + Math.cos(mt.subAng) * mt.r * 0.55;
            const sz = mt.z + Math.sin(mt.subAng) * mt.r * 0.55;
            const sdx = x - sx, sdz = z - sz;
            const sdm = Math.sqrt(sdx * sdx + sdz * sdz);
            const sr = mt.r * 0.62;
            if (sdm < sr) {
                const sam = Math.atan2(sdz, sdx);
                const sridges = 0.85 + 0.2 * worldNoise(Math.cos(sam) * 4 + 70, Math.sin(sam) * 4 + 70, 2, 2.0, 0.5);
                const st = 1 - sdm / sr;
                rise += mt.peak * mt.subH * Math.pow(st, 1.6) * sridges;
            }
        }
    }
    return rise;
}

// Seeded massif registry. Primary first (matches L), then 1-2 bigger extras.
export function placeMountains(deps) {
    const { L, PARTITION, seed, half } = deps;
    const r = mulberry32((seed ^ 0x3a0117) >>> 0);

    // Primary alpine peak — exact L params (hosts waterfall/basin/vent).
    const list = [{ x: L.MX, z: L.MZ, r: L.R_MT, peak: L.PEAK, primary: true }];

    // Bearings to keep clear: the primary (theta), the magma vent flank and the
    // border-river source (BT) — so a massif never buries a feature or the falls.
    const avoid = [L.theta, L.VENT_ANG, L.BT];

    // Try a bearing: place a bigger massif just inside the rim there if it clears
    // the avoid bearings and doesn't overlap an already-placed one.
    const tryPlace = (ang, margin) => {
        for (const a of avoid) if (Math.abs(angDiff(ang, a)) <= margin) return false;
        const rr = 13 + r() * 4;                 // 13-17 (noticeably wider than the 10.5 peak)
        const peak = 17 + r() * 8;               // 17-25 (dominant on the skyline)
        const dist = half - rr - (2 + r() * 4);  // sit just inside the rim
        const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
        for (const mt of list) if ((x - mt.x) ** 2 + (z - mt.z) ** 2 < (rr + mt.r + 5) ** 2) return false;
        // item 123: a seeded secondary lobe direction + relative height (0.35-0.6
        // of the main peak) so this massif reads as a ridgeline, not a lone cone.
        const subAng = ang + (r() < 0.5 ? 1 : -1) * (0.9 + r() * 0.7);
        const subH = 0.35 + r() * 0.25;
        list.push({ x, z, r: rr, peak, primary: false, subAng, subH });
        return true;
    };

    // Preferred host bearings first (rocky-highlands centre + both alpine flanks),
    // then a dense seeded rim scan so a fitting gap is (almost) always found.
    const cand = [];
    const rockyS = PARTITION.assign.indexOf('rocky');
    if (rockyS >= 0) cand.push(PARTITION.rot + (rockyS + 0.5) * PARTITION.sectorWidth);
    cand.push(L.theta + 1.3 + r() * 0.5, L.theta - 1.3 - r() * 0.5);
    const scanBase = r() * Math.PI * 2;
    for (let i = 0; i < 24; i++) cand.push(scanBase + i * (Math.PI * 2 / 24));

    const want = 1 + Math.floor(r() * 2); // 1-2 extra => 2-3 massifs total
    let placed = 0;
    for (const ang of cand) { if (placed >= want) break; if (tryPlace(ang, 0.6)) placed++; }
    // guarantee at least one extra massif even on a tight seed (relax the avoid)
    if (placed === 0) for (let i = 0; i < 24 && placed === 0; i++) if (tryPlace(scanBase + i * (Math.PI * 2 / 24), 0.25)) placed++;
    return list;
}
