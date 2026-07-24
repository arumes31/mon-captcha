/* ============================================================
   Zone Data & Seeded Partition (pure)
   ------------------------------------------------------------
   The twelve themed zones and the math that carves the valley
   into them. This module is deliberately dependency-light
   (config + random + noise only) so BOTH heightfield.js (which
   needs the partition to pick a seeded spawn in a gentle zone,
   before zones.js exists) and zones.js (the runtime API) can
   share ONE partition with no import cycle.

   Zones fan out as twelve soft angular sectors around the central
   pond hub. The sector holding the seeded mountain bearing is
   pinned to ALPINE (so it hosts the mountain + waterfall); the
   neighbour sector on the magma vent's side is pinned to VOLCANIC
   (the scorched flank that hosts the vent). The remaining ten
   zone types are shuffled into the other ten sectors per seed.
   Borders are noise-dithered (wiggly, not pie-slice straight) and
   palettes cross-fade in a band around each border, so transitions
   read soft/organic.

   Each descriptor carries the four per-zone attributes the plan
   asks for: a terrain PALETTE, a FLORA table, an ambient PARTICLE
   set, and a CREATURE spawn-bias list (ids from the bestiary).
   ============================================================ */

import { CONFIG } from './config.js';
import { worldNoise, mulberry32 } from './random.js';

// species tags dispatch to flora builders:
//   oak/birch/fruit/weeping/autumn/gray -> broadleaf addTree
//   pine/snowpine/palm -> addPine   cactus -> addCactus
//   deadtree -> addDeadTree         giantmush -> addGiantMushroom
export const ZONE_DEFS = [
    {
        id: 'meadow', name: 'Sunny Meadow', music: 'meadow', gentle: true,
        surf0: 0x4f8a2f, surf1: 0x93b84c, dirt: 0x6b5334, rock: 0x726c5e, grass: 0x5a8f28,
        flora: { trees: [['oak', 3], ['fruit', 2], ['birch', 1]], treeDensity: 0.8, grass: 1.35,
                 flowers: 2.6, bushes: 1.3, mushrooms: 0.3, rocks: 0.5, props: ['flowerpatch'] },
        particle: { kind: 'pollen', color: 0xffe7a0, density: 1.0 },
        creatures: ['meadowBunny', 'sunFinch', 'gardenSnail', 'mudFrog', 'mossSlime', 'dragonfly'],
    },
    {
        id: 'volcanic', name: 'Ember Flats', music: 'volcanic', gentle: false,
        surf0: 0x1c1210, surf1: 0x362016, dirt: 0x180f0b, rock: 0x1f1815, grass: 0x4a2c1a,
        flora: { trees: [['deadtree', 1]], treeDensity: 0.35, grass: 0, flowers: 0, bushes: 0,
                 mushrooms: 0, rocks: 1.4, props: ['boulder'] },
        particle: { kind: 'ember', color: 0xff7a30, density: 1.5 },
        creatures: ['emberSlime', 'lavaSpider', 'magmaGolem', 'rubyCrab', 'emberwing', 'phoenix'],
    },
    {
        id: 'ice', name: 'Frozen Reaches', music: 'ice', gentle: false,
        surf0: 0x6aa8cc, surf1: 0xa8d8ec, dirt: 0x7a94a8, rock: 0x6a8494, grass: 0x8ac8e4,
        flora: { trees: [['snowpine', 2]], treeDensity: 0.5, grass: 0, flowers: 0, bushes: 0,
                 mushrooms: 0, rocks: 0.7, props: ['iceCrystal', 'iceCrystal'] },
        particle: { kind: 'sparkle', color: 0xd6f0ff, density: 1.1 },
        creatures: ['frostSlime', 'silverFox', 'glowfish', 'widowWeaver', 'crystalGolem', 'frostwing'],
    },
    {
        id: 'snow', name: 'Snowfield', music: 'snow', gentle: true,
        surf0: 0xaabecc, surf1: 0xdceaf4, dirt: 0x8a98a4, rock: 0x76828c, grass: 0xa8bcc8,
        flora: { trees: [['snowpine', 3]], treeDensity: 0.75, grass: 0, flowers: 0, bushes: 0.3,
                 mushrooms: 0, rocks: 0.6, props: [] },
        particle: { kind: 'snow', color: 0xffffff, density: 1.4 },
        creatures: ['frostSlime', 'duskHare', 'moonHare', 'pebbleTurtle', 'greatElk', 'silverFox'],
    },
    {
        id: 'jungle', name: 'Emerald Jungle', music: 'jungle', gentle: true,
        surf0: 0x1f6b2c, surf1: 0x3f9c38, dirt: 0x49361f, rock: 0x59513f, grass: 0x2c7a1e,
        flora: { trees: [['oak', 2], ['weeping', 2], ['fruit', 1]], treeDensity: 1.4, grass: 1.4,
                 flowers: 0.6, bushes: 1.6, mushrooms: 0.8, rocks: 0.4, props: [] },
        particle: { kind: 'spore', color: 0x9be86a, density: 1.0 },
        creatures: ['leafFrog', 'dartFrog', 'jewelScarab', 'dewBeetle', 'hummingbird', 'mossSlime'],
    },
    {
        id: 'autumn', name: 'Autumn Wood', music: 'autumn', gentle: true,
        surf0: 0x7c5a2e, surf1: 0xb98237, dirt: 0x5a3f28, rock: 0x6a5a48, grass: 0x9a7a30,
        flora: { trees: [['autumn', 3], ['weeping', 1], ['oak', 1]], treeDensity: 1.2, grass: 0.8,
                 flowers: 0.4, bushes: 1.0, mushrooms: 1.2, rocks: 0.5, props: [] },
        particle: { kind: 'leaf', color: 0xd8722e, density: 1.1 },
        creatures: ['rustFox', 'greatElk', 'duskOwl', 'shroomkin', 'gardenSnail', 'wolfSpider'],
    },
    {
        id: 'swamp', name: 'Mistwater Swamp', music: 'swamp', gentle: false,
        surf0: 0x2c381f, surf1: 0x44502e, dirt: 0x241f14, rock: 0x2e2e24, grass: 0x3e4c20,
        flora: { trees: [['deadtree', 2], ['weeping', 1]], treeDensity: 0.9, grass: 0.7,
                 flowers: 0.2, bushes: 0.8, mushrooms: 1.0, rocks: 0.4, props: ['reed'] },
        particle: { kind: 'mist', color: 0x8a9a6a, density: 1.2 },
        creatures: ['mudFrog', 'riverOtter', 'gardenSnail', 'gloamBat', 'leafFrog', 'mistyGhost'],
    },
    {
        id: 'desert', name: 'Dune Barrens', music: 'desert', gentle: true,
        surf0: 0x9a7c38, surf1: 0xc8a860, dirt: 0x84662e, rock: 0x74603a, grass: 0x9a8440,
        flora: { trees: [['cactus', 3]], treeDensity: 0.6, grass: 0.18, flowers: 0.1, bushes: 0.35,
                 mushrooms: 0, rocks: 1.0, props: ['boulder', 'bones'] },
        particle: { kind: 'dust', color: 0xe0c890, density: 0.7 },
        creatures: ['sandCrab', 'dewBeetle', 'wolfSpider', 'rubyCrab', 'starSnail', 'sandCrab'],
    },
    {
        id: 'rocky', name: 'Rocky Highlands', music: 'rocky', gentle: false,
        surf0: 0x4e4a42, surf1: 0x6e6658, dirt: 0x423c34, rock: 0x4e4840, grass: 0x5e5e40,
        flora: { trees: [['pine', 1]], treeDensity: 0.35, grass: 0.4, flowers: 0.2, bushes: 0.4,
                 mushrooms: 0.2, rocks: 1.8, props: ['boulder', 'boulder'] },
        particle: { kind: 'dust', color: 0xb4ac9e, density: 0.6 },
        creatures: ['stoneGolem', 'mossGolem', 'elderGolem', 'silverFox', 'greatElk', 'crystalGolem'],
    },
    {
        id: 'mushroom', name: 'Fungal Grove', music: 'mushroom', gentle: true,
        surf0: 0x352a44, surf1: 0x544468, dirt: 0x261e30, rock: 0x363040, grass: 0x54387a,
        flora: { trees: [['giantmush', 3]], treeDensity: 1.0, grass: 0.6, flowers: 0.3, bushes: 0.6,
                 mushrooms: 2.4, rocks: 0.5, props: ['giantmush'] },
        particle: { kind: 'spore', color: 0xc77dff, density: 1.3 },
        creatures: ['shroomkin', 'glowcap', 'starSnail', 'driftJelly', 'nebulaJelly', 'mudFrog'],
    },
    {
        id: 'lakeside', name: 'Reed Shores', music: 'lakeside', gentle: true,
        surf0: 0x7e8c44, surf1: 0xb8a468, dirt: 0x96804e, rock: 0x6e6a58, grass: 0x74923c,
        flora: { trees: [['palm', 2], ['birch', 1]], treeDensity: 0.65, grass: 1.0, flowers: 0.9,
                 bushes: 0.8, mushrooms: 0.2, rocks: 0.5, props: ['reed', 'flowerpatch'] },
        particle: { kind: 'sparkle', color: 0xbfeaff, density: 0.9 },
        creatures: ['pondDuck', 'mandarinDuck', 'koi', 'dragonfly', 'sandCrab', 'goldenDuck'],
    },
    {
        id: 'alpine', name: 'Alpine Ridge', music: 'alpine', gentle: false,
        surf0: 0x6e6a62, surf1: 0x9a948a, dirt: 0x5a544c, rock: 0x6a645c, grass: 0x6f8a5a,
        flora: { trees: [['pine', 3], ['snowpine', 1]], treeDensity: 0.85, grass: 0.5, flowers: 0.4,
                 bushes: 0.4, mushrooms: 0.2, rocks: 1.3, props: ['boulder'] },
        particle: { kind: 'mist', color: 0xdae6f0, density: 0.7 },
        creatures: ['greatElk', 'duskOwl', 'skySwallow', 'stoneGolem', 'crystalGolem', 'frostwing'],
    },
];

export const ZONE_BY_ID = {};
for (const z of ZONE_DEFS) ZONE_BY_ID[z.id] = z;

const TAU = Math.PI * 2;
const NZ = 12;                    // zone count
const SECTOR_W = TAU / NZ;
const DITHER = SECTOR_W * 0.38;   // border wiggle amplitude (radians) — soft, but
                                  // small enough that sector centres stay pure
const EDGE = 0.18;                // palette cross-fade band (fraction of a sector)

const wrap = (a) => ((a % TAU) + TAU) % TAU;

// Smallest signed angular difference a-b in (-PI, PI]
function angDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    return d;
}

/* ------------------------------------------------------------
   Build the seeded partition. mountainBearing/ventBearing come
   from heightfield's already-seeded layout, so the mountain and
   vent land in the right zones every time.
   ------------------------------------------------------------ */
export function makePartition(mountainBearing, ventBearing) {
    // Pin the mountain bearing to the CENTRE of a sector, then that sector
    // is alpine. rot chosen so floor((mtn - rot)/SECTOR_W) == alpine index.
    const alpine = 0;
    const rot = mountainBearing - SECTOR_W * (alpine + 0.5);

    // Volcanic = the sector adjacent to alpine on the vent's side.
    const side = angDiff(ventBearing, mountainBearing) >= 0 ? 1 : -1;
    const volcanic = (alpine + side + NZ) % NZ;

    // Seeded shuffle of the remaining ten zone ids into the other sectors.
    const rng = mulberry32((CONFIG.WORLD_SEED ^ 0x20e5) >>> 0);
    const rest = ZONE_DEFS.map(z => z.id).filter(id => id !== 'alpine' && id !== 'volcanic');
    for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = rest[i]; rest[i] = rest[j]; rest[j] = t;
    }
    const assign = new Array(NZ).fill(null);
    assign[alpine] = 'alpine';
    assign[volcanic] = 'volcanic';
    let k = 0;
    for (let s = 0; s < NZ; s++) {
        if (assign[s]) continue;
        assign[s] = rest[k++];
    }

    const gentleSectors = new Set();
    for (let s = 0; s < NZ; s++) {
        if (ZONE_BY_ID[assign[s]].gentle) gentleSectors.add(s);
    }

    // dithered continuous sector coordinate at (x,z): value in [0, NZ)
    const sectorCoord = (x, z) => {
        const a = Math.atan2(z, x)
            + worldNoise(x * 0.045 + 7, z * 0.045 - 3, 2, 2.0, 0.5) * DITHER
            + worldNoise(x * 0.13 - 4, z * 0.13 + 9, 2, 2.0, 0.5) * (DITHER * 0.3);
        return wrap(a - rot) / SECTOR_W; // [0, NZ)
    };

    const sectorIndexAt = (x, z) => Math.floor(sectorCoord(x, z)) % NZ;

    const zoneIdAt = (x, z) => assign[sectorIndexAt(x, z)];

    // primary + neighbour sector with a soft cross-fade weight t toward the
    // neighbour (0 = fully primary), for palette blending across borders
    const blendAt = (x, z) => {
        const s = sectorCoord(x, z);
        const i = Math.floor(s) % NZ;
        const frac = s - Math.floor(s);
        let j = i, t = 0;
        if (frac < EDGE) {
            j = (i - 1 + NZ) % NZ;
            const u = 1 - frac / EDGE;        // 1 at boundary -> 0 at band edge
            t = 0.5 * u * u * (3 - 2 * u);    // smoothstep, max 0.5 at the seam
        } else if (frac > 1 - EDGE) {
            j = (i + 1) % NZ;
            const u = 1 - (1 - frac) / EDGE;
            t = 0.5 * u * u * (3 - 2 * u);
        }
        return { i, j, t };
    };

    return {
        assign, rot, sectorWidth: SECTOR_W, alpineSector: alpine, volcanicSector: volcanic,
        gentleSectors, sectorIndexAt, zoneIdAt, blendAt,
    };
}
