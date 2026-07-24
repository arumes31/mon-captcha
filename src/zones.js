/* ============================================================
   Zones — runtime API
   ------------------------------------------------------------
   Thin resolver over the seeded PARTITION built in heightfield.js
   (heightfield needs the partition first, to pick a spawn in a
   gentle zone, so it owns the single instance and we read it here
   — no import cycle). Consumers (terrain, flora, atmosphere,
   spawn) ask "which zone is (x,z)?" and get a full descriptor
   with palette / flora table / particle set / creature bias.

   zoneBlendAt returns the primary zone, the neighbour it borders,
   and a cross-fade weight so terrain palettes melt across the
   soft, noise-dithered borders instead of snapping.
   ============================================================ */

import { PARTITION } from './heightfield.js';
import { ZONE_DEFS, ZONE_BY_ID } from './zones-data.js';

export { ZONE_DEFS, ZONE_BY_ID };

// Resolved descriptor list in sector order (index 0..11 -> descriptor)
export const ZONES = PARTITION.assign.map(id => ZONE_BY_ID[id]);

// Hard zone lookup (dithered border) — for flora/particle/creature placement
export function zoneAt(x, z) {
    return ZONE_BY_ID[PARTITION.zoneIdAt(x, z)];
}

export function zoneIndexAt(x, z) {
    return PARTITION.sectorIndexAt(x, z);
}

// Soft blend lookup — { a, b, t }: primary zone a, neighbour b, weight t
// toward b in [0, 0.5]. Used by terrain to cross-fade palettes at borders.
export function zoneBlendAt(x, z) {
    const bl = PARTITION.blendAt(x, z);
    return { a: ZONES[bl.i], b: ZONES[bl.j], t: bl.t };
}

// Zone under the player's feet (music + any HUD)
export function zoneAtCamera(camera) {
    const p = camera.position;
    return zoneAt(p.x, p.z);
}
