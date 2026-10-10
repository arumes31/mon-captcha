/* ============================================================
   Flora — tree & large-plant species builders
   ------------------------------------------------------------
   All the per-species geometry recipes, split out of flora.js
   (which owns PLACEMENT) to respect the module line ceiling.
   Every builder pushes {x,y,z,sx,sy,sz,color,kind} detail
   instances; sx/sy/sz are multiples of the shared V_STEP box.
   Species:
     broadleaf: oak / birch / fruit / weeping / autumn / gray
     conifer  : pine / snowpine (snow-capped tiers)
     palm     : leaning trunk + radiating fronds (lakeside)
     cactus   : saguaro column + arms (desert)
     deadtree : bare gnarled snag (swamp / volcanic)
     giantmush: huge glowing toadstool (fungal grove)
     burnt    : rare lightning-struck/scorched landmark snag

   World & Graphics backlog items 177-196 ("Flora — Trees &
   Vegetation") live in this file + flora.js: per-tree canopy hue
   jitter + lobed silhouettes + interior/edge AO shading, zone-aware
   frost/scorch/moss-and-vine variants, root-flare trunk bases,
   generalized bark flecks, dead-tree breakage variety, a glowing
   mushroom gill underside, a rare cactus full-bloom crown, and the
   burnt-tree landmark. Wind-sway on canopy ('leaf' kind) and meadow
   grass ('grass'/'reed'/... kind) is already live end-to-end via
   terrain.js's windLeaves/windLight index lists + atmosphere.js's
   per-frame sway (scaled by state.weatherWind) — items 177 & 183
   need no change here, every species already tags its canopy 'leaf'.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { getTerrainHeight } from '../heightfield.js';
import { zoneAt } from '../zones/zones.js';

// Leaf palettes per broadleaf species
export const TREE_LEAF_PALETTES = {
    oak:     [0x2e7d32, 0x558b2f, 0x7cb342, 0x33691e, 0x9ccc65],
    autumn:  [0xc21807, 0xf57c00, 0xfbc02d, 0xd84315, 0xe65100],
    birch:   [0x9ccc65, 0xc0ca33, 0x7cb342, 0xdce775],
    fruit:   [0x388e3c, 0x4caf50, 0x2e7d32, 0x66bb6a],
    weeping: [0x4a7c3f, 0x6a994e, 0x386641, 0x588b47],
    gray:    [0x7d8a99, 0x8a97a6, 0x6b7886, 0x9aa5b1],
};

/* ------------------------------------------------------------
   Leaf shading (item 180 follow-up).

   three r160 runs colour management with an srgb-LINEAR working
   space, so Color.offsetHSL() adds/subtracts LINEAR lightness —
   but every AO/jitter amount below is authored perceptually.
   A forest green like #33691e carries only 0.077 linear
   lightness, which is LESS than the 0.088 the canopy AO term
   alone subtracts: setHSL clamps at zero, so interior canopy
   voxels ended up literally #000000 and the rest of the dark
   half of each palette lost ~70% of its albedo. Side and
   underside faces see neither the sun nor skyFill (both come
   from above/one quadrant), so they are lit by the hemisphere
   term alone — at that irradiance a crushed leaf lands in the
   ACES toe and tone-maps to ~(0,15,4). The crown read as holes
   punched in the foliage rather than shaded leaves.

   So shade in sRGB HSL, where the authored numbers mean what
   they say, and stop the dark end at SHADE_FLOOR so a shaded
   leaf still resolves as colour instead of a silhouette. A
   palette entry already darker than the floor (burnt needles,
   snowpine) keeps its own lightness rather than being lifted,
   and brightening is left unclamped so the sun-facing edge of
   the AO gradient is unchanged. Deep shade also drifts slightly
   cooler and less saturated, the way canopy shadow picks up
   skylight rather than just going grey.
   ------------------------------------------------------------ */
const SHADE_FLOOR = 0.30; // sRGB HSL lightness the tone curve still resolves
const _hsl = { h: 0, s: 0, l: 0 };

export function shadeLeaf(hex, hueOff, lightOff) {
    const c = new THREE.Color(hex);
    c.getHSL(_hsl, THREE.SRGBColorSpace);
    const shade = Math.max(0, -lightOff); // how deep into the canopy this voxel sits
    c.setHSL(
        _hsl.h + hueOff + shade * 0.10,
        _hsl.s * (1 - shade * 0.6),
        Math.max(Math.min(_hsl.l, SHADE_FLOOR), _hsl.l + lightOff),
        THREE.SRGBColorSpace
    );
    return c;
}

// Dispatch: species tag -> builder
export function addSpecies(details, x, z, V_STEP, species, r) {
    switch (species) {
        case 'pine':      return addPine(details, x, z, V_STEP, false, r);
        case 'snowpine':  return addPine(details, x, z, V_STEP, true, r);
        case 'palm':      return addPalm(details, x, z, V_STEP, r);
        case 'cactus':    return addCactus(details, x, z, V_STEP, r);
        case 'deadtree':  return addDeadTree(details, x, z, V_STEP, r);
        case 'giantmush': return addGiantMushroom(details, x, z, V_STEP, r);
        case 'burnt':     return addBurntTree(details, x, z, V_STEP, r);
        default:          return addTree(details, x, z, V_STEP, species, r);
    }
}

// Collision radius per species (player/creature obstacle avoidance)
export function speciesRadius(species) {
    switch (species) {
        case 'cactus': return 0.5;
        case 'giantmush': return 1.0;
        case 'deadtree': return 0.6;
        case 'burnt': return 0.7;
        default: return 0.9;
    }
}

// Detail-density multiplier for the small cosmetic extras added below (root
// flares, frost dusting, moss/vines, ash rings, ...): thinned on 'low' so the
// budget-conscious tier doesn't pay for per-tree flourishes, a bit richer on
// 'high' where the instance budget has headroom. Placement counts (tree
// totals, etc.) are governed separately in flora.js.
function tierScale() {
    const q = state.qualityLevel;
    return q === 'low' ? 0.5 : (q === 'high' ? 1.2 : 1.0);
}

// Cheap zone-proximity probe: true if (x,z) itself, or any of a small ring of
// sample points at `rad`, resolve to zone id `id`. zoneAt() alone is a hard
// (if dithered) partition boundary; sampling a short ring around it lets a
// zone-flavored tree variant bleed a few units across that border instead of
// snapping — used for the scorched/volcanic-adjacent variant (item 185).
function nearZoneId(x, z, id, rad = 3.5, samples = 6) {
    if (zoneAt(x, z).id === id) return true;
    for (let i = 0; i < samples; i++) {
        const a = (i / samples) * Math.PI * 2;
        if (zoneAt(x + Math.cos(a) * rad, z + Math.sin(a) * rad).id === id) return true;
    }
    return false;
}

// Root-flare wedges where a trunk meets the ground (item 193): without this
// every trunk column base intersected the terrain as a flat cylinder butt.
// footR is the trunk's rough base radius (species-specific taper start).
function addRootFlare(details, x, z, h, color, footR, r) {
    if (r() > CONFIG.TREE_ROOT_FLARE_CHANCE * (state.qualityLevel === 'low' ? 0.4 : 1)) return;
    const flares = 3 + Math.floor(r() * 3);
    for (let i = 0; i < flares; i++) {
        const a = (i / flares) * Math.PI * 2 + r() * 0.5;
        const rad = footR * (0.55 + r() * 0.4);
        const fh = 0.24 + r() * 0.16;
        details.push({
            x: x + Math.cos(a) * rad, y: h + fh * 0.5, z: z + Math.sin(a) * rad,
            sx: footR * (0.45 + r() * 0.25), sy: fh, sz: footR * (0.45 + r() * 0.25),
            color, kind: 'root', ry: a
        });
    }
}

/* ------------------------------------------------------------
   Broadleaf (the original multi-species voxel tree): twisting
   trunk + chunky volumetric canopy. Trunk height is authored in
   WORLD units and divided by V_STEP so arena/voxel rescales
   never stretch the trees.
   ------------------------------------------------------------ */
export function addTree(details, x, z, V_STEP, species, r) {
    const h = getTerrainHeight(x, z);
    const zone = zoneAt(x, z);
    const inFrostZone = zone && (zone.id === 'ice' || zone.id === 'snow' || zone.id === 'alpine');
    const inSwampJungle = zone && (zone.id === 'swamp' || zone.id === 'jungle');
    const scorched = nearZoneId(x, z, 'volcanic'); // item 185
    const colors = TREE_LEAF_PALETTES[species] || TREE_LEAF_PALETTES.oak;
    const isBirch = species === 'birch';
    const trunkColor = scorched ? 0x241f1b : (isBirch ? 0xe8e6da : 0x5d4037);
    const trunkWorld = (isBirch ? 4.4 : 3.2) + r() * 2.2;      // world-unit trunk height
    const trunkH = Math.max(3, Math.round(trunkWorld / V_STEP)); // voxel steps
    const tScale = tierScale();

    // Per-specimen identity (item 195): one hue/lightness bias applied across
    // this tree's whole canopy so a forest of the same species doesn't read
    // as cloned, on top of the existing per-block jitter.
    const hueBias = (r() - 0.5) * CONFIG.TREE_HUE_JITTER;
    const lightBias = (r() - 0.5) * CONFIG.TREE_HUE_JITTER;

    // Twisting trunk: stack with slight horizontal jitter, tapering
    let tx = x, tz = z;
    for (let y = 0; y < trunkH; y++) {
        const jx = (r() - 0.5) * (isBirch ? 0.12 : 0.3);
        const jz = (r() - 0.5) * (isBirch ? 0.12 : 0.3);
        tx += jx * 0.35; tz += jz * 0.35;
        const taper = (isBirch ? 0.4 : 0.55) - (y / trunkH) * 0.12;
        const trunkV = (r() - 0.5) * 0.05;
        const tColor = new THREE.Color(trunkColor).offsetHSL(0, 0, trunkV).getHex();
        details.push({
            x: tx, y: h + y * V_STEP + V_STEP / 2, z: tz,
            sx: taper, sy: 1.0, sz: taper,
            color: tColor, kind: 'trunk'
        });
        // birch bark: characteristic dark flecks on the papery white trunk
        if (isBirch && r() < 0.4) {
            const side = r() * Math.PI * 2;
            details.push({
                x: tx + Math.cos(side) * 0.11, y: h + y * V_STEP + V_STEP / 2, z: tz + Math.sin(side) * 0.11,
                sx: 0.16, sy: 0.3, sz: 0.16,
                color: 0x2f2a26, kind: 'bark'
            });
        } else if (!isBirch && state.qualityLevel !== 'low' && r() < CONFIG.TREE_BARK_FLECK_CHANCE) {
            // item 188: cheap procedural bark detail — the shared flora material
            // has no room for a real normal map, so a scattering of small darker
            // groove flecks (same trick birch already uses) breaks up the flat
            // trunk color on every other species too.
            const side = r() * Math.PI * 2;
            const barkCol = new THREE.Color(trunkColor).offsetHSL(0, 0, -0.14 - r() * 0.06).getHex();
            details.push({
                x: tx + Math.cos(side) * 0.13, y: h + y * V_STEP + V_STEP / 2, z: tz + Math.sin(side) * 0.13,
                sx: 0.14, sy: 0.26, sz: 0.14,
                color: barkCol, kind: 'bark'
            });
        }
        // item 186: moss climbing bark in swamp/jungle zones
        if (inSwampJungle && !scorched && r() < 0.18 * tScale) {
            details.push({
                x: tx + (r() - 0.5) * 0.2, y: h + y * V_STEP + V_STEP / 2, z: tz + (r() - 0.5) * 0.2,
                sx: 0.22, sy: 0.4, sz: 0.22,
                color: 0x3d5a2a, kind: 'moss'
            });
        }
    }
    addRootFlare(details, x, z, h, trunkColor, isBirch ? 0.36 : 0.5, r);

    // Branch arms near the crown (birch stays clean & vertical)
    if (!isBirch) {
        const branchCount = 2 + Math.floor(r() * 3);
        for (let b = 0; b < branchCount; b++) {
            const bx = tx + (r() - 0.5) * 2.0;
            const bz = tz + (r() - 0.5) * 2.0;
            const by = h + (trunkH - 2 + Math.floor(r() * 2)) * V_STEP;
            const branchLen = 1 + Math.floor(r() * 3);
            for (let y = 0; y < branchLen; y++) {
                details.push({
                    x: bx + (r() - 0.5) * 0.2, y: by + y * V_STEP, z: bz + (r() - 0.5) * 0.2,
                    sx: 0.35, sy: 1.0, sz: 0.35,
                    color: scorched ? 0x241f1b : 0x5d4037, kind: 'branch'
                });
            }
        }
    }

    // Volumetric canopy: chunky leaf blocks on a coarser lattice
    const LEAF_STEP = 0.55;
    const leafScale = (LEAF_STEP / CONFIG.VOXEL_SIZE) * 0.98; // blocks just touch
    const canopyRadius = species === 'fruit' ? 2.0 + r() * 0.6 : 2.4 + r() * 1.0;
    const canopyBaseY = h + trunkH * V_STEP - (species === 'weeping' ? 0.4 : 0);
    let canopyDensity = state.qualityLevel === 'low' ? 0.45 : (isBirch ? 0.55 : 0.68);
    if (scorched) canopyDensity *= 0.3; // fire-thinned crown
    const squash = species === 'weeping' ? 0.6 : (isBirch ? 1.15 : 0.9); // vertical canopy shape

    // item 181: per-tree lobed silhouette — an angular wobble on the canopy
    // boundary (instead of a perfect sphere) so individual specimens read as
    // distinct lumps, not clones. Weeping stays smoother since its silhouette
    // already comes from the drape strands below.
    const lobes = 2 + Math.floor(r() * 3);
    const lobePhase = r() * Math.PI * 2;
    const wobbleAmt = CONFIG.TREE_LOBE_WOBBLE * (species === 'weeping' ? 0.35 : 1);

    for (let dx = -canopyRadius; dx <= canopyRadius; dx += LEAF_STEP) {
        for (let dy = 0; dy <= canopyRadius * squash + 1.0; dy += LEAF_STEP) {
            for (let dz = -canopyRadius; dz <= canopyRadius; dz += LEAF_STEP) {
                const dist = Math.sqrt(dx * dx + (dy / squash) * (dy / squash) + dz * dz);
                const theta = Math.atan2(dz, dx);
                const localR = canopyRadius * (1 + wobbleAmt * 0.5 * Math.sin(theta * lobes + lobePhase));
                if (dist > localR) continue;
                if (r() > canopyDensity) continue;
                // item 180: canopy self-shadowing/AO — interior reads darker,
                // outer edge (sun-facing) reads lighter, via a cheap radial
                // lightness gradient baked into the instance color at build time.
                const edgeT = Math.min(1, dist / localR);
                const col = scorched ? 0x3a322a : colors[Math.floor(r() * colors.length)];
                const c = shadeLeaf(col,
                    hueBias + (r() - 0.5) * 0.02,
                    lightBias + (r() - 0.5) * 0.1 + (edgeT - 0.55) * CONFIG.TREE_CANOPY_AO
                );
                details.push({
                    x: x + dx, y: canopyBaseY + dy, z: z + dz,
                    sx: leafScale, sy: leafScale, sz: leafScale,
                    color: c.getHex(), kind: 'leaf'
                });
            }
        }
    }

    // item 184: frost dusting on canopy tops in snow/ice/alpine zones (covers
    // every broadleaf species, not just the pine/snowpine that already carry
    // their own dedicated snowy tiers).
    if (inFrostZone && !scorched) {
        const dustCount = Math.max(1, Math.round((3 + r() * 4) * tScale));
        for (let s = 0; s < dustCount; s++) {
            const a = r() * Math.PI * 2;
            const rad = canopyRadius * (0.5 + r() * 0.45);
            const dy = canopyRadius * squash * (0.55 + r() * 0.45);
            details.push({
                x: x + Math.cos(a) * rad, y: canopyBaseY + dy + 0.06, z: z + Math.sin(a) * rad,
                sx: 0.34, sy: 0.12, sz: 0.34, color: 0xeef4fb, kind: 'snowcap'
            });
        }
    }

    // item 186: hanging vine strands off the canopy edge in swamp/jungle zones
    if (inSwampJungle && !scorched) {
        const vines = Math.max(1, Math.round((2 + r() * 3) * tScale));
        for (let vI = 0; vI < vines; vI++) {
            const a = r() * Math.PI * 2;
            const vx = x + Math.cos(a) * canopyRadius * 0.8;
            const vz = z + Math.sin(a) * canopyRadius * 0.8;
            const drop = 2 + Math.floor(r() * 3);
            for (let s = 0; s < drop; s++) {
                const c = new THREE.Color(0x3d6b2a).offsetHSL(0, 0, (r() - 0.5) * 0.06 - s * 0.02);
                details.push({
                    x: vx, y: canopyBaseY - s * 0.3, z: vz,
                    sx: 0.1, sy: 0.32, sz: 0.1, color: c.getHex(), kind: 'vine'
                });
            }
        }
    }

    // Species accents — a scorched snag bears neither fruit nor bright litter
    if (scorched) return;
    if (species === 'fruit') {
        const fruitCount = 5 + Math.floor(r() * 5);
        for (let f = 0; f < fruitCount; f++) {
            const ang = r() * Math.PI * 2;
            const el = r() * Math.PI * 0.5;
            const fr = canopyRadius * (0.85 + r() * 0.2);
            details.push({
                x: x + Math.cos(ang) * Math.cos(el) * fr,
                y: canopyBaseY + Math.sin(el) * fr * 0.8 + 0.2,
                z: z + Math.sin(ang) * Math.cos(el) * fr,
                sx: 0.22, sy: 0.22, sz: 0.22,
                color: r() < 0.6 ? 0xd83a2e : 0xf5a623, kind: 'fruit'
            });
        }
    } else if (species === 'weeping') {
        const drapes = 6 + Math.floor(r() * 4);
        for (let dIdx = 0; dIdx < drapes; dIdx++) {
            const ang = (dIdx / drapes) * Math.PI * 2 + r() * 0.5;
            const dx = Math.cos(ang) * canopyRadius * 0.85;
            const dz = Math.sin(ang) * canopyRadius * 0.85;
            const drop = 3 + Math.floor(r() * 4);
            for (let s = 0; s < drop; s++) {
                const c = shadeLeaf(colors[Math.floor(r() * colors.length)], 0, (r() - 0.5) * 0.08 - s * 0.015);
                details.push({
                    x: x + dx + (r() - 0.5) * 0.15, y: canopyBaseY + 0.3 - s * 0.34, z: z + dz + (r() - 0.5) * 0.15,
                    sx: 0.42, sy: 0.7, sz: 0.42,
                    color: c.getHex(), kind: 'leaf'
                });
            }
        }
    } else if (species === 'autumn' && r() < 0.8) {
        const pool = 5 + Math.floor(r() * 5);
        for (let s = 0; s < pool; s++) {
            const ang = r() * Math.PI * 2;
            const rad = 0.5 + r() * 1.6;
            const lx = x + Math.cos(ang) * rad, lz = z + Math.sin(ang) * rad;
            const lh = getTerrainHeight(lx, lz);
            details.push({
                x: lx, y: lh + 0.05, z: lz,
                sx: 0.24, sy: 0.05, sz: 0.24,
                color: colors[Math.floor(r() * colors.length)], kind: 'litter',
                ry: r() * Math.PI
            });
        }
    }
}

/* ------------------------------------------------------------
   Conifer: dark trunk + stacked shrinking needle tiers. The
   snowpine variant lays white snow slabs on top of each tier.
   Also frosts automatically inside snow/ice/alpine zones even
   when the species roll picked plain 'pine' (item 184), and
   scorches near volcanic zone borders (item 185).
   ------------------------------------------------------------ */
function addPine(details, x, z, V_STEP, snowy, r) {
    const zone = zoneAt(x, z);
    const inFrostZone = zone && (zone.id === 'ice' || zone.id === 'snow' || zone.id === 'alpine');
    snowy = snowy || inFrostZone;
    const scorched = nearZoneId(x, z, 'volcanic');
    const h = getTerrainHeight(x, z);
    const height = 4.5 + r() * 2.5;               // world units to the tip
    const tiers = 4 + Math.floor(r() * 2);
    const baseR = 1.5 + r() * 0.6;
    const trunkCol = scorched ? 0x221d19 : (snowy ? 0x4a3a30 : 0x5a4232);
    const needle = scorched ? 0x28231e : (snowy ? 0x2a4d3c : 0x2d5a27);
    const hueBias = (r() - 0.5) * CONFIG.TREE_HUE_JITTER;
    const lightBias = (r() - 0.5) * CONFIG.TREE_HUE_JITTER;

    // trunk
    const trunkSteps = Math.max(2, Math.round((height * 0.35) / V_STEP));
    for (let i = 0; i < trunkSteps; i++) {
        details.push({
            x, y: h + i * V_STEP + V_STEP / 2, z,
            sx: 0.4, sy: 1.0, sz: 0.4,
            color: trunkCol, kind: 'trunk'
        });
    }
    addRootFlare(details, x, z, h, trunkCol, 0.42, r);

    // needle tiers: square rings of blocks, shrinking upward
    const tierBase = h + height * 0.28;
    const tierStep = (height - height * 0.28) / tiers;
    const needleDensity = scorched ? 0.32 : 0.8;
    for (let t = 0; t < tiers; t++) {
        const ty = tierBase + t * tierStep;
        const tr = baseR * (1 - t / tiers) + 0.25;
        const STEP = 0.5;
        for (let dx = -tr; dx <= tr; dx += STEP) {
            for (let dz = -tr; dz <= tr; dz += STEP) {
                const d = Math.hypot(dx, dz);
                if (d > tr) continue;
                if (r() > needleDensity) continue;
                const edgeT = d / tr; // item 180: interior darker, outer edge lighter
                const c = shadeLeaf(needle,
                    hueBias, lightBias + (r() - 0.5) * 0.08 + (edgeT - 0.5) * CONFIG.TREE_CANOPY_AO
                );
                details.push({
                    x: x + dx, y: ty, z: z + dz,
                    sx: 0.6, sy: 0.55, sz: 0.6,
                    color: c.getHex(), kind: 'leaf'
                });
                // snow slab riding the tier's upper face (outer blocks mostly)
                if (snowy && !scorched && d > tr * 0.35 && r() < 0.75) {
                    details.push({
                        x: x + dx, y: ty + 0.26, z: z + dz,
                        sx: 0.58, sy: 0.14, sz: 0.58,
                        color: 0xeef4fb, kind: 'snowcap'
                    });
                }
            }
        }
    }
    // tip block (+ snow dollop)
    details.push({ x, y: h + height, z, sx: 0.5, sy: 0.7, sz: 0.5, color: needle, kind: 'leaf' });
    if (snowy && !scorched) details.push({ x, y: h + height + 0.3, z, sx: 0.42, sy: 0.16, sz: 0.42, color: 0xeef4fb, kind: 'snowcap' });
}

/* ------------------------------------------------------------
   Palm: leaning tan trunk + crown of radiating drooping fronds.
   ------------------------------------------------------------ */
function addPalm(details, x, z, V_STEP, r) {
    const h = getTerrainHeight(x, z);
    const height = 3.6 + r() * 1.8;
    const leanA = r() * Math.PI * 2;
    const lean = 0.5 + r() * 0.7;                  // total sideways drift
    const steps = Math.max(4, Math.round(height / V_STEP));
    const hueBias = (r() - 0.5) * CONFIG.TREE_HUE_JITTER;
    let topX = x, topZ = z;
    for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const px = x + Math.cos(leanA) * lean * t * t;
        const pz = z + Math.sin(leanA) * lean * t * t;
        topX = px; topZ = pz;
        details.push({
            x: px, y: h + i * V_STEP + V_STEP / 2, z: pz,
            sx: 0.38 - t * 0.08, sy: 1.0, sz: 0.38 - t * 0.08,
            color: new THREE.Color(0x9a7a4a).offsetHSL(0, 0, (r() - 0.5) * 0.05).getHex(),
            kind: 'trunk'
        });
    }
    addRootFlare(details, x, z, h, 0x8a6d3f, 0.34, r);
    const crownY = h + steps * V_STEP;
    // fronds: 5-7 arcs of flattened blocks radiating out and drooping
    const fronds = 5 + Math.floor(r() * 3);
    for (let f = 0; f < fronds; f++) {
        const fa = (f / fronds) * Math.PI * 2 + r() * 0.4;
        const flen = 1.6 + r() * 0.8;
        const segs = 4;
        for (let s = 1; s <= segs; s++) {
            const t = s / segs;
            const droop = t * t * 1.0;
            const c = shadeLeaf(0x4a8f3a, hueBias, (r() - 0.5) * 0.08 - t * 0.04);
            details.push({
                x: topX + Math.cos(fa) * flen * t,
                y: crownY + 0.25 - droop,
                z: topZ + Math.sin(fa) * flen * t,
                sx: 0.5 - t * 0.15, sy: 0.12, sz: 0.5 - t * 0.15,
                color: c.getHex(), kind: 'leaf', ry: fa
            });
        }
    }
    // coconuts
    if (r() < 0.75) {
        for (let cN = 0; cN < 2; cN++) {
            details.push({
                x: topX + (r() - 0.5) * 0.4, y: crownY - 0.15, z: topZ + (r() - 0.5) * 0.4,
                sx: 0.2, sy: 0.2, sz: 0.2, color: 0x5d4a32, kind: 'fruit'
            });
        }
    }
}

/* ------------------------------------------------------------
   Cactus: saguaro column, 0-2 arms, pale ribs, flower on top.
   Rare full-bloom crown variant (item 191) instead of the usual
   single occasional blossom.
   ------------------------------------------------------------ */
function addCactus(details, x, z, V_STEP, r) {
    const h = getTerrainHeight(x, z);
    const height = 1.6 + r() * 1.6;
    const steps = Math.max(2, Math.round(height / V_STEP));
    const bodyCol = new THREE.Color(0x3f7a35).offsetHSL(0, 0, (r() - 0.5) * 0.06).getHex();
    for (let i = 0; i < steps; i++) {
        details.push({
            x, y: h + i * V_STEP + V_STEP / 2, z,
            sx: 0.42, sy: 1.0, sz: 0.42, color: bodyCol, kind: 'cactus'
        });
    }
    // arms: horizontal nub + vertical riser
    const arms = Math.floor(r() * 3);
    for (let aN = 0; aN < arms; aN++) {
        const aa = r() * Math.PI * 2;
        const ay = h + height * (0.35 + r() * 0.3);
        const ox = Math.cos(aa) * 0.55, oz = Math.sin(aa) * 0.55;
        details.push({ x: x + ox, y: ay, z: z + oz, sx: 0.34, sy: 0.34, sz: 0.34, color: bodyCol, kind: 'cactus' });
        const riser = 1 + Math.floor(r() * 2);
        for (let i2 = 1; i2 <= riser; i2++) {
            details.push({
                x: x + ox, y: ay + i2 * V_STEP * 0.6, z: z + oz,
                sx: 0.3, sy: 0.6, sz: 0.3, color: bodyCol, kind: 'cactus'
            });
        }
    }
    // item 191: rare, showier full-bloom crown — a discoverable variant rarer
    // than the everyday single blossom
    if (r() < CONFIG.CACTUS_FULL_BLOOM_CHANCE) {
        const n = 4 + Math.floor(r() * 3);
        for (let i = 0; i < n; i++) {
            const ang = (i / n) * Math.PI * 2 + r() * 0.3;
            details.push({
                x: x + Math.cos(ang) * 0.3, y: h + steps * V_STEP + 0.06, z: z + Math.sin(ang) * 0.3,
                sx: 0.16, sy: 0.13, sz: 0.16, color: r() < 0.5 ? 0xff6699 : 0xffe27a, kind: 'flower'
            });
        }
        details.push({ x, y: h + steps * V_STEP + 0.2, z, sx: 0.14, sy: 0.12, sz: 0.14, color: 0xffe27a, kind: 'flower' });
    } else if (r() < 0.4) {
        details.push({
            x, y: h + steps * V_STEP + 0.1, z,
            sx: 0.18, sy: 0.14, sz: 0.18, color: r() < 0.5 ? 0xff6699 : 0xffe27a, kind: 'flower'
        });
    }
}

/* ------------------------------------------------------------
   Dead tree: gnarled bare snag — twisting gray trunk, either a
   full crooked branch crown or a clean splintered break (item 189
   branch-breakage variety), no leaves. Mossy in swamp/jungle
   zones (item 186), deeper charred near volcanic borders (185).
   ------------------------------------------------------------ */
function addDeadTree(details, x, z, V_STEP, r) {
    const zone = zoneAt(x, z);
    const inSwampJungle = zone && (zone.id === 'swamp' || zone.id === 'jungle');
    const scorched = nearZoneId(x, z, 'volcanic');
    const h = getTerrainHeight(x, z);
    const height = 3.0 + r() * 2.0;
    const snapped = r() < 0.4; // some snags read as cleanly snapped, not gnarled
    const steps = Math.max(3, Math.round((snapped ? height * (0.45 + r() * 0.25) : height) / V_STEP));
    const colBase = scorched ? 0x1e1a17 : 0x54463c;
    const col = new THREE.Color(colBase).offsetHSL(0, 0, (r() - 0.5) * 0.07).getHex();
    let tx = x, tz = z;
    for (let i = 0; i < steps; i++) {
        tx += (r() - 0.5) * 0.22;
        tz += (r() - 0.5) * 0.22;
        details.push({
            x: tx, y: h + i * V_STEP + V_STEP / 2, z: tz,
            sx: 0.42 - (i / steps) * 0.18, sy: 1.0, sz: 0.42 - (i / steps) * 0.18,
            color: col, kind: 'trunk'
        });
        if (inSwampJungle && !scorched && r() < 0.2) {
            details.push({
                x: tx + (r() - 0.5) * 0.2, y: h + i * V_STEP + V_STEP / 2, z: tz + (r() - 0.5) * 0.2,
                sx: 0.2, sy: 0.34, sz: 0.2, color: 0x3d5a2a, kind: 'moss'
            });
        }
    }
    addRootFlare(details, x, z, h, col, 0.4, r);

    if (snapped) {
        // item 189: a clean splintered break instead of the gnarled crown —
        // a few short jagged shards fanning out at odd angles from the cut
        const shards = 3 + Math.floor(r() * 3);
        for (let s = 0; s < shards; s++) {
            const a = r() * Math.PI * 2;
            const len = 0.3 + r() * 0.35;
            details.push({
                x: tx + Math.cos(a) * len * 0.5, y: h + steps * V_STEP + len * 0.3, z: tz + Math.sin(a) * len * 0.5,
                sx: 0.12, sy: len, sz: 0.12, color: col, kind: 'branch',
                rx: (r() - 0.5) * 0.6, rz: (r() - 0.5) * 0.6
            });
        }
    } else {
        // crooked branches angling up-and-out from the upper half
        const branches = 2 + Math.floor(r() * 3);
        for (let b = 0; b < branches; b++) {
            const ba = r() * Math.PI * 2;
            let bx = tx, bz = tz;
            let by = h + height * (0.5 + r() * 0.35);
            const blen = 2 + Math.floor(r() * 3);
            for (let s = 0; s < blen; s++) {
                bx += Math.cos(ba) * 0.3;
                bz += Math.sin(ba) * 0.3;
                by += 0.22 + r() * 0.15;
                details.push({
                    x: bx, y: by, z: bz,
                    sx: 0.2, sy: 0.5, sz: 0.2, color: col, kind: 'branch'
                });
            }
        }
    }
}

/* ------------------------------------------------------------
   Giant mushroom: thick pale stem + wide two-layer cap with a
   luminous gill underside (item 190) and bright spots. Cap hue
   rolls per specimen (violet / crimson / teal); the gill glow
   color is paired for contrast so the underside reads as a
   light-catching landmark feature, not flat beige.
   ------------------------------------------------------------ */
function addGiantMushroom(details, x, z, V_STEP, r) {
    const h = getTerrainHeight(x, z);
    const height = 2.2 + r() * 1.4;
    const capR = 1.4 + r() * 0.8;
    const roll = r();
    const capCol = roll < 0.45 ? 0x7a4a9a : roll < 0.8 ? 0xb04038 : 0x2a8f86;
    const glowCol = roll < 0.45 ? 0xffe9b0 : roll < 0.8 ? 0xffd9a8 : 0xd6fff5;
    const steps = Math.max(2, Math.round(height / V_STEP));
    for (let i = 0; i < steps; i++) {
        const t = i / steps;
        details.push({
            x: x + (r() - 0.5) * 0.06, y: h + i * V_STEP + V_STEP / 2, z: z + (r() - 0.5) * 0.06,
            sx: 0.55 - t * 0.12, sy: 1.0, sz: 0.55 - t * 0.12,
            color: new THREE.Color(0xcfc4ae).offsetHSL(0, 0, (r() - 0.5) * 0.04).getHex(),
            kind: 'trunk'
        });
    }
    const capY = h + steps * V_STEP;
    const STEP = 0.5;
    for (let dx = -capR; dx <= capR; dx += STEP) {
        for (let dz = -capR; dz <= capR; dz += STEP) {
            const d = Math.hypot(dx, dz);
            if (d > capR) continue;
            // gill underside ring — glowing, cap-paired tone (item 190)
            if (d > capR * 0.35) {
                details.push({
                    x: x + dx, y: capY - 0.12, z: z + dz,
                    sx: 0.56, sy: 0.14, sz: 0.56, color: glowCol, kind: 'mush-gill'
                });
            }
            // domed top: inner blocks sit distinctly higher (real toadstool dome)
            const lift = Math.pow(1 - d / capR, 1.4) * 1.15;
            const c = new THREE.Color(capCol).offsetHSL(0, 0, (r() - 0.5) * 0.07);
            details.push({
                x: x + dx, y: capY + 0.18 + lift, z: z + dz,
                sx: 0.6, sy: 0.5 + lift * 0.4, sz: 0.6, color: c.getHex(), kind: 'mush-cap'
            });
            // bright spots
            if (r() < 0.12) {
                details.push({
                    x: x + dx, y: capY + 0.55 + lift, z: z + dz,
                    sx: 0.22, sy: 0.1, sz: 0.22, color: 0xfff3d9, kind: 'mush-spot'
                });
            }
        }
    }
}

/* ------------------------------------------------------------
   Burnt landmark tree (item 196): a rare, permanently scorched,
   lightning-split snag for environmental storytelling. A live
   "struck THIS storm" reaction would need a per-frame weather-event
   hook outside this build-once placement module (owned by
   atmosphere.js/game.js), so this is a seeded static landmark
   instead — same charred payoff, always discoverable rather than
   tied to a live thunderstorm.
   ------------------------------------------------------------ */
function addBurntTree(details, x, z, V_STEP, r) {
    const h = getTerrainHeight(x, z);
    const height = 4.2 + r() * 2.0;
    const steps = Math.max(4, Math.round(height / V_STEP));
    const col = new THREE.Color(0x18140f).offsetHSL(0, 0, (r() - 0.5) * 0.05).getHex();
    let tx = x, tz = z;
    for (let i = 0; i < steps; i++) {
        tx += (r() - 0.5) * 0.16;
        tz += (r() - 0.5) * 0.16;
        const taper = 0.5 - (i / steps) * 0.22;
        details.push({ x: tx, y: h + i * V_STEP + V_STEP / 2, z: tz, sx: taper, sy: 1.0, sz: taper, color: col, kind: 'trunk' });
    }
    addRootFlare(details, x, z, h, col, 0.5, r);

    // split, splintered crown — the lightning blew the top open into a few
    // jagged charred prongs instead of a canopy
    const prongs = 3 + Math.floor(r() * 3);
    for (let p = 0; p < prongs; p++) {
        const a = r() * Math.PI * 2;
        const len = 0.6 + r() * 0.9;
        details.push({
            x: tx + Math.cos(a) * len * 0.4, y: h + steps * V_STEP + len * 0.4, z: tz + Math.sin(a) * len * 0.4,
            sx: 0.16, sy: len, sz: 0.16, color: col, kind: 'branch',
            rx: (r() - 0.5) * 0.7, rz: (r() - 0.5) * 0.7
        });
    }

    // scorched ground ring + a few dying ember flecks
    const tScale = tierScale();
    const ashN = Math.max(4, Math.round((8 + r() * 6) * tScale));
    for (let s = 0; s < ashN; s++) {
        const a = (s / ashN) * Math.PI * 2 + r() * 0.3;
        const rad = 1.0 + r() * 1.1;
        const ax = x + Math.cos(a) * rad, az = z + Math.sin(a) * rad;
        const ah = getTerrainHeight(ax, az);
        details.push({ x: ax, y: ah + 0.05, z: az, sx: 0.4, sy: 0.09, sz: 0.4, color: 0x2a2622, kind: 'ash' });
    }
    if (r() < 0.7) {
        const emberN = 2 + Math.floor(r() * 3);
        for (let e = 0; e < emberN; e++) {
            details.push({
                x: x + (r() - 0.5) * 0.7, y: h + 0.15 + r() * 0.3, z: z + (r() - 0.5) * 0.7,
                sx: 0.08, sy: 0.08, sz: 0.08, color: 0xff7a33, kind: 'ember'
            });
        }
    }
}
