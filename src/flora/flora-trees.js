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
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { getTerrainHeight } from '../heightfield.js';

// Leaf palettes per broadleaf species
export const TREE_LEAF_PALETTES = {
    oak:     [0x2e7d32, 0x558b2f, 0x7cb342, 0x33691e, 0x9ccc65],
    autumn:  [0xc21807, 0xf57c00, 0xfbc02d, 0xd84315, 0xe65100],
    birch:   [0x9ccc65, 0xc0ca33, 0x7cb342, 0xdce775],
    fruit:   [0x388e3c, 0x4caf50, 0x2e7d32, 0x66bb6a],
    weeping: [0x4a7c3f, 0x6a994e, 0x386641, 0x588b47],
    gray:    [0x7d8a99, 0x8a97a6, 0x6b7886, 0x9aa5b1],
};

// Dispatch: species tag -> builder
export function addSpecies(details, x, z, V_STEP, species, r) {
    switch (species) {
        case 'pine':      return addPine(details, x, z, V_STEP, false, r);
        case 'snowpine':  return addPine(details, x, z, V_STEP, true, r);
        case 'palm':      return addPalm(details, x, z, V_STEP, r);
        case 'cactus':    return addCactus(details, x, z, V_STEP, r);
        case 'deadtree':  return addDeadTree(details, x, z, V_STEP, r);
        case 'giantmush': return addGiantMushroom(details, x, z, V_STEP, r);
        default:          return addTree(details, x, z, V_STEP, species, r);
    }
}

// Collision radius per species (player/creature obstacle avoidance)
export function speciesRadius(species) {
    switch (species) {
        case 'cactus': return 0.5;
        case 'giantmush': return 1.0;
        case 'deadtree': return 0.6;
        default: return 0.9;
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
    const colors = TREE_LEAF_PALETTES[species] || TREE_LEAF_PALETTES.oak;
    const isBirch = species === 'birch';
    const trunkColor = isBirch ? 0xe8e6da : 0x5d4037;
    const trunkWorld = (isBirch ? 4.4 : 3.2) + r() * 2.2;      // world-unit trunk height
    const trunkH = Math.max(3, Math.round(trunkWorld / V_STEP)); // voxel steps

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
        }
    }

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
                    color: 0x5d4037, kind: 'branch'
                });
            }
        }
    }

    // Volumetric canopy: chunky leaf blocks on a coarser lattice
    const LEAF_STEP = 0.55;
    const leafScale = (LEAF_STEP / CONFIG.VOXEL_SIZE) * 0.98; // blocks just touch
    const canopyRadius = species === 'fruit' ? 2.0 + r() * 0.6 : 2.4 + r() * 1.0;
    const canopyBaseY = h + trunkH * V_STEP - (species === 'weeping' ? 0.4 : 0);
    const canopyDensity = state.qualityLevel === 'low' ? 0.45 : (isBirch ? 0.55 : 0.68);
    const squash = species === 'weeping' ? 0.6 : (isBirch ? 1.15 : 0.9); // vertical canopy shape
    for (let dx = -canopyRadius; dx <= canopyRadius; dx += LEAF_STEP) {
        for (let dy = 0; dy <= canopyRadius * squash + 1.0; dy += LEAF_STEP) {
            for (let dz = -canopyRadius; dz <= canopyRadius; dz += LEAF_STEP) {
                const dist = Math.sqrt(dx * dx + (dy / squash) * (dy / squash) + dz * dz);
                if (dist > canopyRadius) continue;
                if (r() > canopyDensity) continue;
                const col = colors[Math.floor(r() * colors.length)];
                const c = new THREE.Color(col);
                c.offsetHSL((r() - 0.5) * 0.02, 0, (r() - 0.5) * 0.1);
                details.push({
                    x: x + dx, y: canopyBaseY + dy, z: z + dz,
                    sx: leafScale, sy: leafScale, sz: leafScale,
                    color: c.getHex(), kind: 'leaf'
                });
            }
        }
    }

    // Species accents
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
                const c = new THREE.Color(colors[Math.floor(r() * colors.length)]);
                c.offsetHSL(0, 0, (r() - 0.5) * 0.08 - s * 0.015);
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
   ------------------------------------------------------------ */
function addPine(details, x, z, V_STEP, snowy, r) {
    const h = getTerrainHeight(x, z);
    const height = 4.5 + r() * 2.5;               // world units to the tip
    const tiers = 4 + Math.floor(r() * 2);
    const baseR = 1.5 + r() * 0.6;
    const trunkCol = snowy ? 0x4a3a30 : 0x5a4232;
    const needle = snowy ? 0x2a4d3c : 0x2d5a27;

    // trunk
    const trunkSteps = Math.max(2, Math.round((height * 0.35) / V_STEP));
    for (let i = 0; i < trunkSteps; i++) {
        details.push({
            x, y: h + i * V_STEP + V_STEP / 2, z,
            sx: 0.4, sy: 1.0, sz: 0.4,
            color: trunkCol, kind: 'trunk'
        });
    }

    // needle tiers: square rings of blocks, shrinking upward
    const tierBase = h + height * 0.28;
    const tierStep = (height - height * 0.28) / tiers;
    for (let t = 0; t < tiers; t++) {
        const ty = tierBase + t * tierStep;
        const tr = baseR * (1 - t / tiers) + 0.25;
        const STEP = 0.5;
        for (let dx = -tr; dx <= tr; dx += STEP) {
            for (let dz = -tr; dz <= tr; dz += STEP) {
                const d = Math.hypot(dx, dz);
                if (d > tr) continue;
                if (r() > 0.8) continue;
                const c = new THREE.Color(needle).offsetHSL(0, 0, (r() - 0.5) * 0.08);
                details.push({
                    x: x + dx, y: ty, z: z + dz,
                    sx: 0.6, sy: 0.55, sz: 0.6,
                    color: c.getHex(), kind: 'leaf'
                });
                // snow slab riding the tier's upper face (outer blocks mostly)
                if (snowy && d > tr * 0.35 && r() < 0.75) {
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
    if (snowy) details.push({ x, y: h + height + 0.3, z, sx: 0.42, sy: 0.16, sz: 0.42, color: 0xeef4fb, kind: 'snowcap' });
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
            const c = new THREE.Color(0x4a8f3a).offsetHSL(0, 0, (r() - 0.5) * 0.08 - t * 0.04);
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
    // blossom
    if (r() < 0.4) {
        details.push({
            x, y: h + steps * V_STEP + 0.1, z,
            sx: 0.18, sy: 0.14, sz: 0.18, color: r() < 0.5 ? 0xff6699 : 0xffe27a, kind: 'flower'
        });
    }
}

/* ------------------------------------------------------------
   Dead tree: gnarled bare snag — twisting gray trunk, a few
   crooked rising branches, no leaves.
   ------------------------------------------------------------ */
function addDeadTree(details, x, z, V_STEP, r) {
    const h = getTerrainHeight(x, z);
    const height = 3.0 + r() * 2.0;
    const steps = Math.max(3, Math.round(height / V_STEP));
    const col = new THREE.Color(0x54463c).offsetHSL(0, 0, (r() - 0.5) * 0.07).getHex();
    let tx = x, tz = z;
    for (let i = 0; i < steps; i++) {
        tx += (r() - 0.5) * 0.22;
        tz += (r() - 0.5) * 0.22;
        details.push({
            x: tx, y: h + i * V_STEP + V_STEP / 2, z: tz,
            sx: 0.42 - (i / steps) * 0.18, sy: 1.0, sz: 0.42 - (i / steps) * 0.18,
            color: col, kind: 'trunk'
        });
    }
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

/* ------------------------------------------------------------
   Giant mushroom: thick pale stem + wide two-layer cap with
   pale-gill underside and bright spots. Cap hue rolls per
   specimen (violet / crimson / teal).
   ------------------------------------------------------------ */
function addGiantMushroom(details, x, z, V_STEP, r) {
    const h = getTerrainHeight(x, z);
    const height = 2.2 + r() * 1.4;
    const capR = 1.4 + r() * 0.8;
    const roll = r();
    const capCol = roll < 0.45 ? 0x7a4a9a : roll < 0.8 ? 0xb04038 : 0x2a8f86;
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
            // gill underside ring
            if (d > capR * 0.35) {
                details.push({
                    x: x + dx, y: capY - 0.12, z: z + dz,
                    sx: 0.56, sy: 0.14, sz: 0.56, color: 0xe8ddc4, kind: 'mush-gill'
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
