/* ============================================================
   Flora — zone-driven placement
   ------------------------------------------------------------
   Scatters every plant/prop across the valley, steered by the
   twelve zone descriptors (zones.js): each zone's flora table
   sets its tree species mix + densities for grass, flowers,
   bushes, mushrooms and rocks, plus signature props (ice
   crystals, boulders, land reeds, extra giant mushrooms).
   Species geometry recipes live in flora-trees.js.
   Structural dressing that belongs to the WATER network (pond
   reeds, river banks, lily pads, shore sand) stays unconditional.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { mulberry32, worldNoise } from '../random.js';
import { getTerrainHeight, isWaterAt, findDryLand, riverAt, riverPointAt, riverSpan, SPAWN, sampleCave } from '../heightfield.js';
import { inLavaFootprint } from '../lava.js';

// Ground where no plants grow: a cave tunnel footprint (the caves module owns
// all interior dressing — its floor is carved bare rock) OR the lava river /
// pool footprint plus its scorched margin (Phase 2d — trees were sprouting in
// the molten course). Every flora placement loop gates on this.
function inCaveFootprint(x, z) {
    const cf = sampleCave(x, z);
    if (cf && cf.lat < cf.hw + 1.1) return true;
    return inLavaFootprint(x, z);
}
import { zoneAt } from '../zones/zones.js';
import { addSpecies, speciesRadius } from './flora-trees.js';

// Pick a species from a zone's weighted [species, weight] table
function pickSpecies(table, r) {
    let total = 0;
    for (const [, w] of table) total += w;
    let roll = r() * total;
    for (const [s, w] of table) {
        roll -= w;
        if (roll <= 0) return s;
    }
    return table[0][0];
}

export function buildFlora(half, V_STEP) {
    const details = [];
    const treeList = [];
    const r = mulberry32(CONFIG.WORLD_SEED ^ 0x7e57);
    const low = state.qualityLevel === 'low';

    // Keep the flat spawn meadow pad clear of solid obstacles
    const nearSpawn = (x, z, rad) => ((x - SPAWN.x) ** 2 + (z - SPAWN.z) ** 2) < rad * rad;

    /* ---- trees: zone-weighted species + density ---- */
    const treeCount = low ? CONFIG.TREE_COUNT_LOW : CONFIG.TREE_COUNT_HIGH;

    // Prominent muted bluish-gray canopy tree near the pond (fixed landmark).
    // findDryLand only dodges water, so on seeds where the lava course reaches
    // this corner the landmark would sprout in the molten flow (Phase 2d fix):
    // if so, ring-search outward for the nearest dry, lava-free spot.
    let graySpot = findDryLand(-16, -10, 2.2);
    // extra-wide margin (3.0) so this prominent tree's broad canopy never
    // overhangs the molten flow
    if (inLavaFootprint(graySpot.x, graySpot.z, 3.0)) {
        outer:
        for (let rad = 3; rad <= 18; rad += 2.5) {
            for (let a = 0; a < 10; a++) {
                const ang = (a / 10) * Math.PI * 2;
                const cand = findDryLand(-16 + Math.cos(ang) * rad, -10 + Math.sin(ang) * rad, 2.2);
                if (!inLavaFootprint(cand.x, cand.z, 3.0)) { graySpot = cand; break outer; }
            }
        }
    }
    treeList.push({ x: graySpot.x, z: graySpot.z, species: 'gray', r: 0.9 });
    addSpecies(details, graySpot.x, graySpot.z, V_STEP, 'gray', r);

    let placed = 0, attempts = 0;
    while (placed < treeCount && attempts < treeCount * 14) {
        attempts++;
        const x = (r() * 2 - 1) * (half - 3);
        const z = (r() * 2 - 1) * (half - 3);
        const d = Math.sqrt(x * x + z * z);
        if (d < CONFIG.POND_RADIUS + 2.5) continue;
        if (isWaterAt(x, z, 2.0)) continue;
        if (getTerrainHeight(x, z) > 4.2) continue; // no trees on the rocky mountain
        if (nearSpawn(x, z, 3)) continue;
        if (inCaveFootprint(x, z)) continue;
        const zone = zoneAt(x, z);
        if (r() > zone.flora.treeDensity / 1.4) continue; // zone density gate
        // avoid overlap with existing trees
        let ok = true;
        for (const t of treeList) {
            if ((t.x - x) ** 2 + (t.z - z) ** 2 < 13) { ok = false; break; }
        }
        if (!ok) continue;
        const species = pickSpecies(zone.flora.trees, r);
        treeList.push({ x, z, species, r: speciesRadius(species) });
        addSpecies(details, x, z, V_STEP, species, r);
        placed++;
    }
    state.treeList = treeList;

    /* ---- zone signature props ---- */
    addZoneProps(details, treeList, half, V_STEP, r);

    /* ---- fallen mossy logs (forested zones only) ---- */
    const logCount = low ? 5 : 11;
    for (let i = 0; i < logCount; i++) {
        const x = (r() * 2 - 1) * (half - 4);
        const z = (r() * 2 - 1) * (half - 4);
        const d = Math.sqrt(x * x + z * z);
        if (d < CONFIG.POND_RADIUS + 2 || nearSpawn(x, z, 2.5)) continue;
        if (isWaterAt(x, z, 1.6) || getTerrainHeight(x, z) > 4.2) continue;
        if (inCaveFootprint(x, z)) continue;
        const zone = zoneAt(x, z);
        if (r() > zone.flora.treeDensity) continue; // logs follow the tree cover
        const ang = r() * Math.PI * 2;
        const len = 5 + Math.floor(r() * 4);
        const logColor = new THREE.Color(0x4e3a28).offsetHSL(0, 0, (r() - 0.5) * 0.08).getHex();
        for (let s = 0; s < len; s++) {
            const lx = x + Math.cos(ang) * s * 0.32;
            const lz = z + Math.sin(ang) * s * 0.32;
            const h = getTerrainHeight(lx, lz);
            details.push({ x: lx, y: h + 0.17, z: lz, sx: 0.62, sy: 0.62, sz: 0.62, color: logColor, kind: 'log', ry: ang });
            if (r() < 0.45 && zone.flora.grass > 0.2) {
                details.push({ x: lx, y: h + 0.38, z: lz, sx: 0.48, sy: 0.11, sz: 0.48, color: 0x4f7a35, kind: 'moss', ry: ang });
            }
        }
    }

    /* ---- tree stumps ---- */
    const stumpCount = low ? 3 : 7;
    for (let i = 0; i < stumpCount; i++) {
        const x = (r() * 2 - 1) * (half - 4);
        const z = (r() * 2 - 1) * (half - 4);
        const d = Math.sqrt(x * x + z * z);
        if (d < CONFIG.POND_RADIUS + 2 || nearSpawn(x, z, 2)) continue;
        if (isWaterAt(x, z, 1.0) || inCaveFootprint(x, z)) continue;
        const h = getTerrainHeight(x, z);
        if (h > 4.2) continue;
        if (r() > zoneAt(x, z).flora.treeDensity) continue;
        details.push({ x, y: h + 0.16, z, sx: 0.55, sy: 0.55, sz: 0.55, color: 0x5d4037, kind: 'stump' });
        details.push({ x, y: h + 0.34, z, sx: 0.57, sy: 0.08, sz: 0.57, color: 0xa98a62, kind: 'stump-top' });
    }

    /* ---- rocks (zone-weighted, mossy caps only in growing zones) ---- */
    for (let i = 0; i < 84; i++) {
        const x = (r() * 2 - 1) * (half - 3);
        const z = (r() * 2 - 1) * (half - 3);
        const d = Math.sqrt(x * x + z * z);
        if (d < CONFIG.POND_RADIUS + 1.5) continue;
        if (isWaterAt(x, z, 0.8) || inCaveFootprint(x, z)) continue;
        const zone = zoneAt(x, z);
        if (r() > zone.flora.rocks / 1.8) continue;
        const h = getTerrainHeight(x, z);
        const rSize = 0.3 + r() * 0.6;
        const rockV = (r() - 0.5) * 0.1;
        const rockColor = new THREE.Color(zone.rock).offsetHSL(0, 0, 0.07 + rockV).getHex();
        const sy = rSize * (0.5 + r() * 0.5);
        const sx = rSize * (0.8 + r() * 0.4);
        const sz = rSize * (0.8 + r() * 0.4);
        details.push({ x, y: h + sy * V_STEP / 2, z, sx, sy, sz, color: rockColor, kind: 'rock' });
        if (r() < 0.5 && zone.flora.grass > 0.3) {
            const mossCol = new THREE.Color(0x4f7a35).offsetHSL(0, 0, (r() - 0.5) * 0.06).getHex();
            details.push({
                x: x + (r() - 0.5) * 0.15, y: h + sy * V_STEP + 0.02, z: z + (r() - 0.5) * 0.15,
                sx: sx * 0.7, sy: 0.1, sz: sz * 0.7,
                color: mossCol, kind: 'moss'
            });
        }
    }

    /* ---- pebbles (neutral, everywhere) ---- */
    for (let i = 0; i < 175; i++) {
        const x = (r() * 2 - 1) * (half - 2);
        const z = (r() * 2 - 1) * (half - 2);
        const d = Math.sqrt(x * x + z * z);
        if (d < CONFIG.POND_RADIUS + 1) continue;
        if (isWaterAt(x, z, 0.2) || inCaveFootprint(x, z)) continue;
        const h = getTerrainHeight(x, z);
        const c = new THREE.Color(zoneAt(x, z).rock).offsetHSL(0, 0, 0.18).getHex();
        details.push({ x, y: h + 0.08, z, sx: 0.09, sy: 0.07, sz: 0.09, color: c, kind: 'pebble' });
    }

    /* ---- leafy bushes (zone-weighted) ---- */
    const bushCount = low ? 14 : 46;
    for (let i = 0; i < bushCount; i++) {
        const x = (r() * 2 - 1) * (half - 3);
        const z = (r() * 2 - 1) * (half - 3);
        const d = Math.sqrt(x * x + z * z);
        if (d < CONFIG.POND_RADIUS + 1.5 || nearSpawn(x, z, 2)) continue;
        if (isWaterAt(x, z, 1.2) || inCaveFootprint(x, z)) continue;
        const zone = zoneAt(x, z);
        if (r() > zone.flora.bushes / 1.6) continue;
        const h = getTerrainHeight(x, z);
        if (h > 4.5) continue;
        const bushR = 0.45 + r() * 0.45;
        // bush foliage keys off the zone grass tone so autumn reads rusty, jungle lush
        const bushCol = new THREE.Color(zone.grass).offsetHSL(0, -0.05, -0.04);
        const blobs = 6 + Math.floor(r() * 6);
        for (let b = 0; b < blobs; b++) {
            const bx = (r() - 0.5) * bushR * 1.6;
            const bz = (r() - 0.5) * bushR * 1.6;
            const by = r() * bushR * 0.7;
            const c = bushCol.clone().offsetHSL(0, 0, (r() - 0.5) * 0.08).getHex();
            details.push({ x: x + bx, y: h + 0.15 + by, z: z + bz, sx: 0.68, sy: 0.68, sz: 0.68, color: c, kind: 'leaf' });
        }
        if (r() < 0.35 && zone.flora.flowers > 0.3) {
            for (let s = 0; s < 4; s++) {
                details.push({
                    x: x + (r() - 0.5) * bushR * 1.4, y: h + 0.2 + r() * bushR * 0.6, z: z + (r() - 0.5) * bushR * 1.4,
                    sx: 0.11, sy: 0.11, sz: 0.11, color: 0xd23c50, kind: 'berry'
                });
            }
        }
    }

    /* ---- flower patches (zone-weighted) ---- */
    const flowerColors = [0xff5a4e, 0xffbb33, 0x53b5e5, 0xff6699, 0xf3f0e4];
    const patchCount = low ? 8 : 28;
    for (let pIdx = 0; pIdx < patchCount; pIdx++) {
        const px = (r() * 2 - 1) * (half - 3);
        const pz = (r() * 2 - 1) * (half - 3);
        if (Math.sqrt(px * px + pz * pz) < CONFIG.POND_RADIUS + 1.5) continue;
        if (r() > zoneAt(px, pz).flora.flowers / 2.2) continue;
        const petals = 8 + Math.floor(r() * 7);
        const mainCol = flowerColors[Math.floor(r() * flowerColors.length)];
        for (let i = 0; i < petals; i++) {
            const x = px + (r() - 0.5) * 2.4;
            const z = pz + (r() - 0.5) * 2.4;
            const d = Math.sqrt(x * x + z * z);
            if (d < CONFIG.POND_RADIUS + 1.2 || Math.abs(x) > half - 1.5 || Math.abs(z) > half - 1.5) continue;
            if (isWaterAt(x, z, 0.6) || inCaveFootprint(x, z)) continue;
            const h = getTerrainHeight(x, z);
            if (h > 4.2) continue;
            const col = r() < 0.75 ? mainCol : flowerColors[Math.floor(r() * flowerColors.length)];
            details.push({ x, y: h + 0.12, z, sx: 0.06, sy: 0.4, sz: 0.06, color: 0x558b2f, kind: 'stem' });
            details.push({ x, y: h + 0.26, z, sx: 0.18, sy: 0.15, sz: 0.18, color: col, kind: 'flower' });
            if (r() < 0.5) {
                details.push({ x, y: h + 0.33, z, sx: 0.08, sy: 0.06, sz: 0.08, color: 0xffe27a, kind: 'flower' });
            }
        }
    }

    /* ---- small mushrooms sheltering under trees (zone-weighted) ---- */
    const mushroomCount = low ? 26 : 88;
    for (let i = 0; i < mushroomCount; i++) {
        const t = treeList[Math.floor(r() * treeList.length)];
        const ang = r() * Math.PI * 2;
        const rad = 1.0 + r() * 1.8;
        const x = t.x + Math.cos(ang) * rad;
        const z = t.z + Math.sin(ang) * rad;
        const d = Math.sqrt(x * x + z * z);
        if (d < CONFIG.POND_RADIUS + 0.5 || Math.abs(x) > half - 1.5 || Math.abs(z) > half - 1.5) continue;
        if (isWaterAt(x, z, 0.4) || inCaveFootprint(x, z)) continue;
        const zone = zoneAt(x, z);
        if (r() > zone.flora.mushrooms / 2.4 + 0.12) continue; // grove teems, deserts bare
        const h = getTerrainHeight(x, z);
        const capCol = zone.id === 'mushroom' && r() < 0.5 ? 0x7a4a9a : 0xcc0000;
        details.push({ x, y: h + 0.1, z, sx: 0.09, sy: 0.24, sz: 0.09, color: 0xf5f5f5, kind: 'mush-stem' });
        details.push({ x, y: h + 0.18, z, sx: 0.3, sy: 0.12, sz: 0.3, color: capCol, kind: 'mush-cap' });
        for (let s = 0; s < 3; s++) {
            const sx = (r() - 0.5) * 0.3, sz = (r() - 0.5) * 0.3;
            details.push({ x: x + sx, y: h + 0.26, z: z + sz, sx: 0.05, sy: 0.05, sz: 0.05, color: 0xffffff, kind: 'mush-spot' });
        }
    }

    /* ---- meadow grass + ferns, tinted per zone ---- */
    const grassCount = low ? 460 : 2050;
    const grassColor = new THREE.Color();
    for (let i = 0; i < grassCount; i++) {
        const x = (r() * 2 - 1) * (half - 2);
        const z = (r() * 2 - 1) * (half - 2);
        const d = Math.sqrt(x * x + z * z);
        if (d < CONFIG.POND_RADIUS + 1) continue;
        if (isWaterAt(x, z, 0.3) || inCaveFootprint(x, z)) continue;
        const zone = zoneAt(x, z);
        if (zone.flora.grass <= 0) continue;
        if (r() > zone.flora.grass / 1.4) continue;
        const h = getTerrainHeight(x, z);
        if (h > 3.8) continue; // rocky mountain stays bare
        const gWorld = 0.35 + r() * 0.75;             // blade height in world units
        const isFern = r() < 0.22 && zone.flora.grass > 0.5;
        const m = worldNoise(x * 0.055 + 37, z * 0.055 - 11, 3, 2.0, 0.5) * 0.5 + 0.5;
        grassColor.setHex(zone.grass).offsetHSL(0, 0, (m - 0.5) * 0.1 + (r() - 0.5) * 0.07);
        const gH = gWorld / V_STEP;
        details.push({
            x, y: h + gWorld / 2 + 0.04, z,
            sx: isFern ? 0.24 : 0.09, sy: gH, sz: isFern ? 0.24 : 0.09,
            color: grassColor.getHex(), kind: 'grass',
            rx: (r() - 0.5) * 0.2, rz: (r() - 0.5) * 0.2
        });
    }

    /* ---- structural water dressing (zone-independent) ---- */
    addWaterDressing(details, half, V_STEP, r, low);

    // Safety valve: never exceed the flora instance budget
    if (details.length > CONFIG.MAX_FLORA_INSTANCES) {
        details.length = CONFIG.MAX_FLORA_INSTANCES;
    }

    return details;
}

/* ------------------------------------------------------------
   Zone signature props, scattered through their home zone only:
   ice crystals, boulders, land-reed clumps, bonus giant shrooms.
   ------------------------------------------------------------ */
function addZoneProps(details, treeList, half, V_STEP, r) {
    const tries = 360;
    let crystals = 0, boulders = 0, reeds = 0, shrooms = 0, patches = 0, bones = 0;
    for (let i = 0; i < tries; i++) {
        const x = (r() * 2 - 1) * (half - 4);
        const z = (r() * 2 - 1) * (half - 4);
        if (Math.hypot(x, z) < CONFIG.POND_RADIUS + 2) continue;
        if (isWaterAt(x, z, 1.2) || inCaveFootprint(x, z)) continue;
        const h = getTerrainHeight(x, z);
        if (h > 4.5) continue;
        if (((x - SPAWN.x) ** 2 + (z - SPAWN.z) ** 2) < 16) continue;
        const zone = zoneAt(x, z);
        const props = zone.flora.props;
        if (!props.length) continue;
        const tag = props[Math.floor(r() * props.length)];
        if (tag === 'iceCrystal' && crystals < 14) {
            crystals++;
            const n = 2 + Math.floor(r() * 3);
            for (let c = 0; c < n; c++) {
                const ox = (r() - 0.5) * 0.8, oz = (r() - 0.5) * 0.8;
                const ch = 0.8 + r() * 1.6;
                details.push({
                    x: x + ox, y: getTerrainHeight(x + ox, z + oz) + ch / 2, z: z + oz,
                    sx: 0.22 + r() * 0.14, sy: ch / V_STEP, sz: 0.22 + r() * 0.14,
                    color: r() < 0.5 ? 0x9fe4ff : 0x6fc8f0, kind: 'crystal',
                    rx: (r() - 0.5) * 0.35, rz: (r() - 0.5) * 0.35,
                });
            }
        } else if (tag === 'boulder' && boulders < 12) {
            boulders++;
            const s = 1.1 + r() * 1.1;
            const col = new THREE.Color(zone.rock).offsetHSL(0, 0, 0.05 + (r() - 0.5) * 0.06).getHex();
            details.push({ x, y: h + s * V_STEP / 2, z, sx: s, sy: s * (0.7 + r() * 0.4), sz: s * (0.8 + r() * 0.4), color: col, kind: 'rock', ry: r() * Math.PI });
            if (r() < 0.6) {
                details.push({ x: x + (r() - 0.5) * 0.6, y: h + s * V_STEP * 0.95, z: z + (r() - 0.5) * 0.6, sx: s * 0.55, sy: s * 0.4, sz: s * 0.55, color: col, kind: 'rock' });
            }
        } else if (tag === 'reed' && reeds < 16) {
            reeds++;
            const stalks = 3 + Math.floor(r() * 3);
            for (let s = 0; s < stalks; s++) {
                const ox = (r() - 0.5) * 0.6, oz = (r() - 0.5) * 0.6;
                const shWorld = 1.1 + r() * 0.8;
                details.push({
                    x: x + ox, y: h + shWorld / 2, z: z + oz,
                    sx: 0.11, sy: shWorld / V_STEP, sz: 0.11,
                    color: 0x5a7a30, kind: 'reed',
                    rx: (r() - 0.5) * 0.1, rz: (r() - 0.5) * 0.1
                });
                if (r() < 0.5) {
                    details.push({ x: x + ox, y: h + shWorld + 0.1, z: z + oz, sx: 0.15, sy: 0.5, sz: 0.15, color: 0x6b4a2b, kind: 'cattail' });
                }
            }
        } else if (tag === 'giantmush' && shrooms < 5) {
            shrooms++;
            addSpecies(details, x, z, V_STEP, 'giantmush', r);
            treeList.push({ x, z, species: 'giantmush', r: 1.0 });
        } else if (tag === 'flowerpatch' && patches < 16) {
            // dense wildflower cluster — signature meadow/lakeside dressing
            patches++;
            const flowerColors = [0xff5a4e, 0xffbb33, 0x53b5e5, 0xff6699, 0xf3f0e4, 0xc77dff];
            const mainCol = flowerColors[Math.floor(r() * flowerColors.length)];
            const n = 10 + Math.floor(r() * 10);
            for (let c = 0; c < n; c++) {
                const ox = (r() - 0.5) * 2.0, oz = (r() - 0.5) * 2.0;
                const fx = x + ox, fz = z + oz;
                if (isWaterAt(fx, fz, 0.4)) continue;
                const fh = getTerrainHeight(fx, fz);
                if (fh > 4.0) continue;
                const col = r() < 0.7 ? mainCol : flowerColors[Math.floor(r() * flowerColors.length)];
                details.push({ x: fx, y: fh + 0.12, z: fz, sx: 0.06, sy: 0.4, sz: 0.06, color: 0x558b2f, kind: 'stem' });
                details.push({ x: fx, y: fh + 0.26, z: fz, sx: 0.17, sy: 0.15, sz: 0.17, color: col, kind: 'flower' });
            }
        } else if (tag === 'bones' && bones < 10) {
            // bleached bone arc breaking up the dunes
            bones++;
            const ang = r() * Math.PI * 2;
            const ribs = 3 + Math.floor(r() * 3);
            for (let s = 0; s < ribs; s++) {
                const bx = x + Math.cos(ang) * s * 0.4;
                const bz = z + Math.sin(ang) * s * 0.4;
                const bh = getTerrainHeight(bx, bz);
                const rise = 0.25 + Math.sin((s / ribs) * Math.PI) * 0.6;
                details.push({ x: bx, y: bh + rise / 2 + 0.1, z: bz, sx: 0.1, sy: rise / V_STEP, sz: 0.1, color: 0xe8e0cf, kind: 'bone', rz: (r() - 0.5) * 0.3 });
            }
        }
    }
}

/* ------------------------------------------------------------
   Water-network dressing: pond reeds, river banks, lily pads,
   shore sand. Structural (identical across all zone layouts).
   ------------------------------------------------------------ */
function addWaterDressing(details, half, V_STEP, r, low) {
    // Reeds & cattails ringing the pond
    const reedCount = low ? 20 : 44;
    for (let i = 0; i < reedCount; i++) {
        const ang = r() * Math.PI * 2;
        const rad = CONFIG.POND_RADIUS - 0.4 + r() * 1.2;
        const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
        const base = Math.max(getTerrainHeight(x, z), -0.35);
        const stalks = 2 + Math.floor(r() * 3);
        for (let s = 0; s < stalks; s++) {
            const ox = (r() - 0.5) * 0.35, oz = (r() - 0.5) * 0.35;
            const shWorld = 1.3 + r() * 0.9;
            const topY = base + shWorld;
            details.push({
                x: x + ox, y: base + shWorld / 2, z: z + oz,
                sx: 0.11, sy: shWorld / V_STEP, sz: 0.11,
                color: 0x4a8038, kind: 'reed',
                rx: (r() - 0.5) * 0.1, rz: (r() - 0.5) * 0.1
            });
            if (r() < 0.7) {
                details.push({
                    x: x + ox, y: topY + 0.12, z: z + oz,
                    sx: 0.15, sy: 0.5, sz: 0.15,
                    color: 0x6b4a2b, kind: 'cattail'
                });
            }
        }
    }

    // Reeds & sand tracing the river banks from the pond up to the falls
    const span = riverSpan();
    const bankCount = low ? 16 : 34;
    for (let i = 0; i < bankCount; i++) {
        const u = span.uMin + 1.5 + r() * (span.uMax - span.uMin - 2.5);
        const side = r() < 0.5 ? 1 : -1;
        const rv0 = riverPointAt(u, 0);
        const rvInfo = riverAt(rv0.x, rv0.z);
        const wW = rvInfo ? rvInfo.wWater : 1.7;
        const sandP = riverPointAt(u, side * (wW + 0.5 + r() * 1.2));
        if (Math.abs(sandP.x) < half - 1.5 && Math.abs(sandP.z) < half - 1.5 && !isWaterAt(sandP.x, sandP.z, 0.1)) {
            const sh = getTerrainHeight(sandP.x, sandP.z);
            details.push({ x: sandP.x, y: sh + 0.06, z: sandP.z, sx: 0.4, sy: 0.1, sz: 0.4, color: 0xd9c89a, kind: 'shore', ry: r() * Math.PI });
        }
        if (r() < 0.8) {
            const reedP = riverPointAt(u, side * (wW - 0.2 + r() * 0.8));
            if (Math.abs(reedP.x) < half - 1.5 && Math.abs(reedP.z) < half - 1.5) {
                const base = Math.max(getTerrainHeight(reedP.x, reedP.z), -0.35);
                const stalks = 2 + Math.floor(r() * 2);
                for (let s = 0; s < stalks; s++) {
                    const ox = (r() - 0.5) * 0.35, oz = (r() - 0.5) * 0.35;
                    const shWorld = 1.2 + r() * 0.8;
                    const topY = base + shWorld;
                    details.push({
                        x: reedP.x + ox, y: base + shWorld / 2, z: reedP.z + oz,
                        sx: 0.11, sy: shWorld / V_STEP, sz: 0.11,
                        color: 0x4a8038, kind: 'reed',
                        rx: (r() - 0.5) * 0.1, rz: (r() - 0.5) * 0.1
                    });
                    if (r() < 0.6) {
                        details.push({
                            x: reedP.x + ox, y: topY + 0.12, z: reedP.z + oz,
                            sx: 0.15, sy: 0.5, sz: 0.15,
                            color: 0x6b4a2b, kind: 'cattail'
                        });
                    }
                }
            }
        }
    }

    // Lily pads with blossoms drifting on the pond surface
    const lilyCount = low ? 10 : 20;
    for (let i = 0; i < lilyCount; i++) {
        const ang = r() * Math.PI * 2;
        const rad = 1.2 + r() * (CONFIG.POND_RADIUS - 2.4);
        const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
        const padS = 0.75 + r() * 0.55;
        const padCol = new THREE.Color(0x3f9c53).offsetHSL(0, 0, (r() - 0.5) * 0.08).getHex();
        details.push({
            x, y: CONFIG.POND_WATER_LEVEL + 0.03, z,
            sx: padS, sy: 0.07, sz: padS,
            color: padCol, kind: 'lily', ry: r() * Math.PI * 2
        });
        if (r() < 0.45) {
            const bloom = r() < 0.5 ? 0xffb7d0 : 0xfdf7e6;
            details.push({ x, y: CONFIG.POND_WATER_LEVEL + 0.11, z, sx: 0.22, sy: 0.16, sz: 0.22, color: bloom, kind: 'lilyflower' });
            details.push({ x, y: CONFIG.POND_WATER_LEVEL + 0.18, z, sx: 0.09, sy: 0.08, sz: 0.09, color: 0xffd94a, kind: 'lilyflower' });
        }
    }

    // Sandy shore patches breaking up the grass around the pond
    for (let i = 0; i < 50; i++) {
        const ang = r() * Math.PI * 2;
        const rad = CONFIG.POND_RADIUS + 0.4 + r() * 1.6;
        const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
        const h = getTerrainHeight(x, z);
        details.push({ x, y: h + 0.06, z, sx: 0.3, sy: 0.1, sz: 0.3, color: 0xd9c89a, kind: 'shore' });
    }
}
