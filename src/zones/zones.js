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

   ------------------------------------------------------------
   Biome-identity pass (backlog items 215-230) — everything below
   ZONE_BY_ID re-export is new lookups over the ZONE_DEFS fields
   added for this pass. This module only computes; it does not
   render, so each export names which other (out-of-scope-for-
   this-pass) system would need to call it to actually show up:

     zoneElevationBiasAt  -> heightfield.js height function (221)
     zoneParticleBlendAt  -> atmosphere.js ambient particles (217, 226)
     zoneSkyTintAt        -> engine.js Sky/zenith uniforms (218)
     zoneCloudTintAt      -> atmosphere.js buildClouds() (225)
     zoneGlowAt           -> atmosphere.js zoneGlow layer (224)
     zoneWindAt           -> weather/wind system (229)
     zoneDustAt           -> footstep/ground-dust system (219, 228)
     zoneFlyoverAt        -> atmosphere.js ambient-life flyovers (230)
     zoneLandmarkAnchor   -> flora.js / mountain.js prop placement (215)
     zoneChipColor        -> ui.js HUD compass chip (220)
     zonePrimaryCreature  -> flora.js/creatures.js density tells (223)
     isZoneBorder /
     zoneBorderStrength   -> flora.js boundary-marker prop scatter (222)
     checkFirstVisit /
     hasVisitedZone       -> game.js/atmosphere.js first-discovery
                              sting + camera pan (216, 227)
   ============================================================ */

import { CONFIG } from '../config.js';
import { PARTITION } from '../heightfield.js';
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

/* ------------------------------------------------------------
   Shared hex-color lerp, same normalized-channel technique
   terrain.js's computeZoneColors uses for palette cross-fades —
   kept local here so callers get pre-blended colors and never
   need to reimplement it per consumer.
   ------------------------------------------------------------ */
const _r = (h) => ((h >> 16) & 255) / 255;
const _g = (h) => ((h >> 8) & 255) / 255;
const _b = (h) => (h & 255) / 255;
const _mix = (a, b, t) => a + (b - a) * t;
function blendHex(h1, h2, t) {
    const r = Math.round(_mix(_r(h1), _r(h2), t) * 255);
    const g = Math.round(_mix(_g(h1), _g(h2), t) * 255);
    const b = Math.round(_mix(_b(h1), _b(h2), t) * 255);
    return (r << 16) | (g << 8) | b;
}

// item 221: elevation bias/roughness, blended across the same soft border
// terrain palettes use — swamp/lakeside read lower & flatter, rocky/alpine
// higher & more jagged. heightfield.js would add bias*someScale into its
// height function and multiply its roughness-noise amplitude by roughness
// to actually bend the terrain; this only computes the blended values.
export function zoneElevationBiasAt(x, z) {
    const { a, b, t } = zoneBlendAt(x, z);
    return {
        bias: _mix(a.elevationBias, b.elevationBias, t),
        roughness: _mix(a.roughness, b.roughness, t),
    };
}

// items 217 + 226: ambient particle color/density cross-faded the same way
// terrain colors are, so a border reads as a gradual particle-kind handoff
// rather than a pop; kind itself is categorical and flips only exactly at
// the seam (t's max), where color/density on both sides already agree.
// atmosphere.js's ambient-particle builder would call this instead of
// reading zoneAt(x,z).particle directly.
export function zoneParticleBlendAt(x, z) {
    const { a, b, t } = zoneBlendAt(x, z);
    return {
        color: blendHex(a.particle.color, b.particle.color, t),
        density: _mix(a.particle.density, b.particle.density, t),
        kind: t < 0.5 ? a.particle.kind : b.particle.kind,
    };
}

// item 218: blended zenith/sky tint. engine.js's Sky rig would sample this
// at the camera's (x,z) each frame (or on zone change) to retint the dome.
export function zoneSkyTintAt(x, z) {
    const { a, b, t } = zoneBlendAt(x, z);
    return blendHex(a.sky, b.sky, t);
}

// item 225: blended cloud-layer tint, for atmosphere.js's buildClouds() to
// color drifting cloud sprites by the zone(s) beneath them.
export function zoneCloudTintAt(x, z) {
    const { a, b, t } = zoneBlendAt(x, z);
    return blendHex(a.cloudTint, b.cloudTint, t);
}

// item 224: blended inner/outer zoneGlow gradient stops, replacing one
// shared ramp with a per-zone signature that still cross-fades at borders.
export function zoneGlowAt(x, z) {
    const { a, b, t } = zoneBlendAt(x, z);
    return {
        inner: blendHex(a.glow.inner, b.glow.inner, t),
        outer: blendHex(a.glow.outer, b.glow.outer, t),
    };
}

// item 229: regional wind gust profile. Gust strength blends at borders;
// style (dust devil vs canopy sway, etc) is categorical like particle kind.
export function zoneWindAt(x, z) {
    const { a, b, t } = zoneBlendAt(x, z);
    return { gust: _mix(a.wind.gust, b.wind.gust, t), style: t < 0.5 ? a.wind.style : b.wind.style };
}

// items 219 + 228: ground-dust kickup material underfoot. Not cross-faded —
// what kicks up under a footstep is whatever's literally underfoot, not an
// average of two zones. A footstep/kickup system would call this per step.
export function zoneDustAt(x, z) {
    return zoneAt(x, z).dust;
}

// item 230: ambient-creature silhouette flyover. Categorical, hard lookup
// like dust — atmosphere.js's ambient-life spawner would sample this to
// pick which silhouette drifts overhead in a given zone.
export function zoneFlyoverAt(x, z) {
    return zoneAt(x, z).flyover;
}

// item 215: world-space anchor for a zone's signature landmark — the centre
// bearing of its sector (pre-dither, so it's stable regardless of the noise
// wobble at the actual borders) at a radius tuned to clear the pond hub and
// stay inboard of the outer wall. flora.js/mountain.js's prop-placement pass
// would spawn ZONE_BY_ID[id].landmark's silhouette here.
export function zoneLandmarkAnchor(zoneId) {
    const sector = PARTITION.assign.indexOf(zoneId);
    if (sector < 0) return null;
    const bearing = PARTITION.rot + PARTITION.sectorWidth * (sector + 0.5);
    const radius = (CONFIG.ARENA_SIZE / 2) * CONFIG.ZONE_LANDMARK_RADIUS_FRAC;
    return { x: Math.cos(bearing) * radius, z: Math.sin(bearing) * radius, bearing, radius };
}

// item 220: single representative HUD chip color per zone (its sunlit
// terrain hue) — ui.js's compass/HUD would look this up per zone visited.
export function zoneChipColor(zoneId) {
    return ZONE_BY_ID[zoneId].surf1;
}

// item 223: the single most representative creature id for a zone's bias
// list, for a density "tell" (nest/tracks) system to scatter ahead of the
// player actually seeing one. flora.js/creatures.js would consume this.
export function zonePrimaryCreature(zoneId) {
    return ZONE_BY_ID[zoneId].creatures[0];
}

// item 222: how close (x,z) is to a zone seam, 0 (interior) .. 0.5 (exact
// seam) — the same weight zoneBlendAt already computes, exposed standalone
// so a boundary-marker prop scatter doesn't need to unpack a full blend.
export function zoneBorderStrength(x, z) {
    return PARTITION.blendAt(x, z).t;
}

export function isZoneBorder(x, z, threshold = CONFIG.ZONE_BORDER_MARKER_THRESHOLD) {
    return zoneBorderStrength(x, z) >= threshold;
}

/* ------------------------------------------------------------
   items 216 + 227: first-discovery tracking. A per-session Set of
   zone ids already announced, owned here since it's pure runtime
   state about "which zones has this session seen" — not persisted,
   not touching state.js. game.js (or wherever zoneAtCamera is
   polled per frame) would call checkFirstVisit(zone.id) whenever
   the camera's zone changes; a true result is the one-shot moment
   to fire the particle/color "sting" (216) and, for jungle/
   mushroom/volcanic specifically, a camera pan/highlight (227).
   ------------------------------------------------------------ */
const _visitedZones = new Set();

export function hasVisitedZone(zoneId) {
    return _visitedZones.has(zoneId);
}

// Returns true the first time this is called for a given zone id per
// session, false every time after — a one-shot discovery trigger.
export function checkFirstVisit(zoneId) {
    if (_visitedZones.has(zoneId)) return false;
    _visitedZones.add(zoneId);
    return true;
}
