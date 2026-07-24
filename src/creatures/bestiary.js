/* ------------------------------------------------------------
   The Bestiary — 51 types. Each entry is plan + palette + stats
   + a UNIQUE movement recipe:
     gait  : how speed pulses  (steady / hop / stopgo / dash / pulse)
     steer : how heading evolves (wander / zigzag / sine / spiral /
             orbit(home) / ring(pond) / waypoint(tree-to-tree) /
             channel(river patrol))
     react : player interaction (flee / curious / freeze-when-seen /
             panic-on-near-miss / taunt / hide / blinkflee)
     special: blink teleport / dive swoops / leap arcs (koi)
     flight : aerial altitude pattern (dart / glide / jitter /
             hoverdash / soar) on top of the base hover height
   Scale spans ~0.35 (tiny: hummingbird, dragonfly, dew beetle)
   to ~2.8 (huge: Ancient Golem, Great Elk, Grand Pond Turtle).
   Tiny types are genuinely hard to hit (hit radius follows
   scale); huge ones are easy and lean common/1-point.

   INTELLIGENCE — `int` is a composable profile layered on the
   movement recipe (rarer = smarter, a few commons get
   personality):
     dodge : 0..1 sidestep skill vs inbound balls (reaction delay
             shrinks and burst sharpens as it rises; never dodges
             balls thrown from behind, and a cooldown always
             leaves a punish window)
     cover : keeps trees/rocks between itself and the player
             while fleeing
     keep  : [min,max] preferred range band from the player
     alarm : panicking alerts nearby same-species (chirp + scatter)

   LEGENDARIES (1-2 alive per world, spawn-guaranteed): aura glow
   + orbiting sparkles, larger-than-life presence pulse, proximity
   sting, ~50% base capture rate. Worth 2 points like all
   non-commons.

   Phase 2j appends the CAVE-EXCLUSIVE types (cave-bestiary.js) —
   they carry `cave: true` (kept out of the surface spawn pools) +
   a `caveBehavior` recipe (cave-behavior.js). Placed only inside
   caves by cave-spawn.js, biased by the 2e theme spawnBias.
   ------------------------------------------------------------ */
import { CAVE_CREATURE_TYPES } from './cave-bestiary.js';

export const CREATURE_TYPES = [
    // ---- slimes ----
    { id: 'mossSlime', name: 'Moss Slime', plan: 'slime', tier: 'common', scale: 1.6, speed: 0.55,
      palette: { body: 0x7cc26a, accent: 0x3f7a33, belly: 0xa8d89a, eye: 0x14210f }, particle: 0x8fd77d,
      gait: { t: 'hop', rate: 1.6, pause: 0.55, h: 0.42 }, steer: { t: 'wander', jit: 0.02, turn: 1.2 }, react: { t: 'none' } },
    { id: 'emberSlime', name: 'Ember Slime', plan: 'slime', tier: 'uncommon', scale: 1.0, speed: 1.25, fire: true,
      palette: { body: 0xff7a3c, accent: 0xffd23c, belly: 0xffa060, eye: 0x2a1206, glow: 0xff5a1f, glowI: 1.5 }, particle: 0xffa040,
      gait: { t: 'hop', rate: 4.2, pause: 0.12, h: 0.3 }, steer: { t: 'zigzag', freq: 3.2, amp: 0.55 }, react: { t: 'panic' } },
    { id: 'frostSlime', name: 'Frost Slime', plan: 'slime', tier: 'common', scale: 1.25, speed: 0.5,
      palette: { body: 0x9fd8ef, accent: 0xe8fbff, belly: 0xc8ecf7, eye: 0x102030 }, particle: 0xbfeaff,
      gait: { t: 'hop', rate: 1.1, pause: 1.0, h: 0.55 }, steer: { t: 'wander', jit: 0.012, turn: 0.9 }, react: { t: 'freeze', r: 10 } },
    { id: 'royalSlime', name: 'Royal Slime', plan: 'slime', tier: 'rare', scale: 0.75, speed: 1.9, sparkle: true,
      palette: { body: 0x9b5de5, accent: 0xffd700, belly: 0xb98af0, eye: 0x1c0a2e, glow: 0xb26bff, glowI: 1.7 }, particle: 0xc77dff,
      gait: { t: 'dash', on: 0.7, off: 0.5, mul: 2.0 }, steer: { t: 'wander', jit: 0.05, turn: 2.6 }, react: { t: 'flee', r: 5, boost: 1.6 },
      int: { dodge: 0.6 } },

    // ---- bunnies ----
    { id: 'meadowBunny', name: 'Meadow Bunny', plan: 'bunny', tier: 'common', scale: 1.2, speed: 0.75,
      palette: { body: 0xb98e63, belly: 0xe8d8bd, accent: 0xd9a8a0, eye: 0x241a12 }, particle: 0xd9b98a,
      gait: { t: 'hop', rate: 2.6, pause: 0.5, h: 0.3 }, steer: { t: 'wander', jit: 0.03, turn: 1.4 }, react: { t: 'curious', far: 8, near: 2.6 },
      int: { alarm: true } },
    { id: 'duskHare', name: 'Dusk Hare', plan: 'bunny', tier: 'uncommon', scale: 0.95, speed: 1.4,
      palette: { body: 0x6b6480, belly: 0xb9b2c9, accent: 0x8d8299, eye: 0x171322 }, particle: 0xa79ec4,
      gait: { t: 'hop', rate: 3.6, pause: 0.25, h: 0.34 }, steer: { t: 'zigzag', freq: 2.6, amp: 0.75 }, react: { t: 'flee', r: 4.5, boost: 1.7 },
      int: { dodge: 0.5, alarm: true } },
    { id: 'moonHare', name: 'Moon Hare', plan: 'bunny', tier: 'rare', scale: 0.62, speed: 2.1, sparkle: true,
      palette: { body: 0xf2f6ff, belly: 0xcfe0ff, accent: 0xafc7ff, eye: 0x22304d, glow: 0x9db9ff, glowI: 1.3 }, particle: 0xcfe0ff,
      gait: { t: 'dash', on: 0.55, off: 0.6, mul: 2.1 }, steer: { t: 'wander', jit: 0.08, turn: 2.2 }, react: { t: 'flee', r: 6, boost: 1.8 },
      int: { dodge: 0.7, alarm: true } },

    // ---- foxes ----
    { id: 'rustFox', name: 'Rust Fox', plan: 'fox', tier: 'uncommon', scale: 1.05, speed: 1.35,
      palette: { body: 0xc3602c, belly: 0xefd9b8, accent: 0x743c1c, eye: 0x241206 }, particle: 0xe08a4a,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'waypoint', pause: 0.9 }, react: { t: 'curious', far: 9, near: 3 },
      int: { dodge: 0.3, cover: true } },
    { id: 'silverFox', name: 'Silver Fox', plan: 'fox', tier: 'rare', scale: 0.8, speed: 2.0,
      palette: { body: 0xc9cdd4, belly: 0xf2f4f7, accent: 0x7e858f, eye: 0x1a2028, glow: 0xdfe7ff, glowI: 0.9 }, particle: 0xdfe7f7,
      gait: { t: 'dash', on: 1.0, off: 0.55, mul: 1.9 }, steer: { t: 'zigzag', freq: 3.8, amp: 0.5 }, react: { t: 'freeze', r: 11 },
      int: { dodge: 0.6, cover: true } },

    // ---- birds (aerial) ----
    { id: 'sunFinch', name: 'Sun Finch', plan: 'bird', tier: 'uncommon', scale: 0.9, speed: 1.3, hover: 1.3,
      palette: { body: 0xffc94a, accent: 0xe2732c, belly: 0xfff2cf, eye: 0x241a06 }, particle: 0xffd76b,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'orbit', r: 4 }, react: { t: 'none' },
      int: { keep: [4, 9] } },
    { id: 'skySwallow', name: 'Sky Swallow', plan: 'bird', tier: 'rare', scale: 0.7, speed: 2.3, hover: 1.9,
      palette: { body: 0x3f6fd8, accent: 0x1f3a77, belly: 0xe8f0ff, eye: 0x0c1226, glow: 0x6fa3ff, glowI: 1.1 }, particle: 0x7fb0ff,
      gait: { t: 'pulse', freq: 1.6, mul: 1.9 }, steer: { t: 'sine', freq: 1.3, amp: 2.6 }, react: { t: 'flee', r: 6, boost: 1.5 },
      int: { dodge: 0.65 } },

    // ---- ducks (aquatic — pond & river) ----
    { id: 'pondDuck', name: 'Pond Duck', plan: 'duck', tier: 'common', scale: 1.25, speed: 0.6, aquatic: true,
      palette: { body: 0xb5894f, accent: 0x2e7d46, belly: 0xe6d3ac, accent2: 0x6b4f2e, eye: 0x1a1206 }, particle: 0xd8b95e,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'wander', jit: 0.02, turn: 1.0 }, react: { t: 'none' },
      int: { alarm: true } },
    { id: 'mandarinDuck', name: 'Mandarin Duck', plan: 'duck', tier: 'uncommon', scale: 1.0, speed: 1.3, aquatic: true,
      palette: { body: 0xc75b39, accent: 0x7b3fa0, belly: 0xf3e3c3, accent2: 0x2d6fb8, eye: 0x140a1c }, particle: 0xd88be0,
      gait: { t: 'dash', on: 0.8, off: 0.7, mul: 2.0 }, steer: { t: 'wander', jit: 0.04, turn: 1.6 }, react: { t: 'panic' },
      int: { alarm: true } },
    { id: 'goldenDuck', name: 'Golden Duck', plan: 'duck', tier: 'legendary', scale: 0.85, speed: 2.2, aquatic: true, sparkle: true,
      palette: { body: 0xffd24a, accent: 0xffb300, belly: 0xfff3c9, accent2: 0xf2a71b, eye: 0x2e1c02, glow: 0xffc21f, glowI: 1.6 }, particle: 0xffd75e,
      gait: { t: 'pulse', freq: 2.2, mul: 1.7 }, steer: { t: 'ring', r: 5.2 }, react: { t: 'flee', r: 6, boost: 1.6 },
      int: { dodge: 0.85 } },

    // ---- frogs ----
    { id: 'mudFrog', name: 'Mud Frog', plan: 'frog', tier: 'common', scale: 1.3, speed: 0.6,
      palette: { body: 0x6f7d3a, belly: 0xd9d3a8, accent: 0x4c5626, eye: 0x1c2008 }, particle: 0x9aa64f,
      gait: { t: 'hop', rate: 1.4, pause: 1.1, h: 0.5 }, steer: { t: 'wander', jit: 0.025, turn: 1.6 }, react: { t: 'none' } },
    { id: 'leafFrog', name: 'Leaf Frog', plan: 'frog', tier: 'uncommon', scale: 0.95, speed: 1.35,
      palette: { body: 0x39b54a, belly: 0xf2ffd9, accent: 0xff8c2e, eye: 0x0e2a12 }, particle: 0x6be07c,
      gait: { t: 'hop', rate: 3.0, pause: 0.35, h: 0.42 }, steer: { t: 'ring', r: 11.2 }, react: { t: 'flee', r: 4, boost: 1.6 } },
    { id: 'dartFrog', name: 'Dart Frog', plan: 'frog', tier: 'rare', scale: 0.5, speed: 2.2,
      palette: { body: 0x2456e8, belly: 0xffe94a, accent: 0x101820, eye: 0x060a12, glow: 0x3a6bff, glowI: 1.2 }, particle: 0x5b83ff,
      gait: { t: 'hop', rate: 5.2, pause: 0.1, h: 0.26 }, steer: { t: 'zigzag', freq: 5, amp: 0.85 }, react: { t: 'flee', r: 5, boost: 1.8 },
      int: { dodge: 0.65 } },

    // ---- spiders ----
    { id: 'wolfSpider', name: 'Wolf Spider', plan: 'spider', tier: 'common', scale: 1.3, speed: 0.7,
      palette: { body: 0x5a4632, accent: 0x3a2d20, eye: 0x0a0a0a, glow: 0xff3b1f, glowI: 0.9 }, particle: 0x8a6b4a,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'wander', jit: 0.03, turn: 1.5 }, react: { t: 'taunt', r: 12 } },
    { id: 'lavaSpider', name: 'Lava Spider', plan: 'spider', tier: 'uncommon', scale: 1.0, speed: 1.45, fire: true,
      palette: { body: 0x2b2130, accent: 0x4a1f16, eye: 0x0a0a0a, glow: 0xff4a1f, glowI: 1.8 }, particle: 0xff6a3c,
      gait: { t: 'stopgo', on: 0.7, off: 0.4, mul: 1.5 }, steer: { t: 'wander', jit: 0.05, turn: 2.0 }, react: { t: 'panic' } },
    { id: 'widowWeaver', name: 'Widow Weaver', plan: 'spider', tier: 'rare', scale: 0.7, speed: 2.0,
      palette: { body: 0x16161c, accent: 0x232330, eye: 0x0a0a0a, glow: 0xc22cff, glowI: 1.8 }, particle: 0xc65cff,
      gait: { t: 'dash', on: 0.5, off: 0.85, mul: 2.2 }, steer: { t: 'sine', freq: 2.2, amp: 1.4 }, react: { t: 'freeze', r: 12 },
      int: { dodge: 0.6, cover: true } },

    // ---- golems ----
    { id: 'stoneGolem', name: 'Stone Golem', plan: 'golem', tier: 'common', scale: 1.55, speed: 0.42,
      palette: { body: 0x75726b, accent: 0x57544e, belly: 0x4f7a35, accent2: 0x8b877e, eye: 0x0a0a0a, glow: 0x7fe7ff, glowI: 1.2 }, particle: 0xa8a49a,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'orbit', r: 5 }, react: { t: 'none' } },
    { id: 'mossGolem', name: 'Moss Golem', plan: 'golem', tier: 'common', scale: 1.3, speed: 0.5,
      palette: { body: 0x5d6b46, accent: 0x46543a, belly: 0x74934c, accent2: 0x3e4a30, eye: 0x0a0a0a, glow: 0xaaff6a, glowI: 1.1 }, particle: 0x8fbf62,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'wander', jit: 0.008, turn: 2.8 }, react: { t: 'taunt', r: 13 } },
    { id: 'magmaGolem', name: 'Magma Golem', plan: 'golem', tier: 'uncommon', scale: 1.15, speed: 0.95, fire: true,
      palette: { body: 0x453a3a, accent: 0x2e2626, belly: 0xff7a26, accent2: 0x5c4848, eye: 0x0a0a0a, glow: 0xff5a1f, glowI: 2.0 }, particle: 0xff8546,
      gait: { t: 'stopgo', on: 1.0, off: 0.6, mul: 1.5 }, steer: { t: 'wander', jit: 0.03, turn: 1.4 }, react: { t: 'curious', far: 11, near: 2 } },
    { id: 'crystalGolem', name: 'Crystal Golem', plan: 'golem', tier: 'legendary', scale: 1.35, speed: 1.7, sparkle: true,
      palette: { body: 0x9fd4e8, accent: 0x6fb6d8, belly: 0xe8fbff, accent2: 0xbfe9f7, eye: 0x0a0a0a, glow: 0x6fe3ff, glowI: 2.0 }, particle: 0x9feaff,
      gait: { t: 'steady', mul: 1.15 }, steer: { t: 'zigzag', freq: 1.8, amp: 0.4 }, react: { t: 'freeze', r: 12 },
      int: { dodge: 0.8, keep: [7, 12] } },
    { id: 'elderGolem', name: 'Ancient Golem', plan: 'golem', tier: 'common', scale: 2.6, speed: 0.3,
      palette: { body: 0x6b685f, accent: 0x4c4a44, belly: 0x63845c, accent2: 0x86827a, eye: 0x0a0a0a, glow: 0xffc86a, glowI: 1.0 }, particle: 0xb8b2a4,
      gait: { t: 'steady', mul: 0.85 }, steer: { t: 'orbit', r: 7 }, react: { t: 'taunt', r: 15 },
      int: { dodge: 0 } },

    // ---- crabs ----
    { id: 'sandCrab', name: 'Sand Crab', plan: 'crab', tier: 'common', scale: 1.15, speed: 0.7,
      palette: { body: 0xd9b26a, accent: 0xb98d4a, eye: 0x2a2118 }, particle: 0xe0c684,
      gait: { t: 'stopgo', on: 0.9, off: 0.5, mul: 1.4 }, steer: { t: 'ring', r: 10.6 }, react: { t: 'panic' } },
    { id: 'rubyCrab', name: 'Ruby Crab', plan: 'crab', tier: 'uncommon', scale: 0.9, speed: 1.4,
      palette: { body: 0xc42e3e, accent: 0x8e1f2c, eye: 0x1c0608, glow: 0xff3a4a, glowI: 1.0 }, particle: 0xff5a6a,
      gait: { t: 'stopgo', on: 0.5, off: 0.25, mul: 1.9 }, steer: { t: 'zigzag', freq: 3.4, amp: 0.6 }, react: { t: 'flee', r: 4, boost: 1.7 },
      int: { dodge: 0.4 } },

    // ---- turtles ----
    { id: 'pebbleTurtle', name: 'Pebble Turtle', plan: 'turtle', tier: 'common', scale: 1.35, speed: 0.35,
      palette: { body: 0x6e7f5a, accent: 0x55684a, accent2: 0x8a9a70, belly: 0xc9b98a, eye: 0x1a1c10 }, particle: 0xa9b58a,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'wander', jit: 0.015, turn: 1.0 }, react: { t: 'hide', r: 3.5 } },
    { id: 'emeraldTurtle', name: 'Emerald Turtle', plan: 'turtle', tier: 'uncommon', scale: 1.05, speed: 0.9,
      palette: { body: 0x2e8b57, accent: 0x1f6b41, accent2: 0x62c98a, belly: 0xd8e8c9, eye: 0x0a2014, glow: 0x4ade80, glowI: 0.8 }, particle: 0x62d68a,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'ring', r: 10.8 }, react: { t: 'hide', r: 2.5 } },
    { id: 'grandTurtle', name: 'Grand Pond Turtle', plan: 'turtle', tier: 'common', scale: 2.75, speed: 0.25, aquatic: true,
      palette: { body: 0x5a7a52, accent: 0x435c3e, accent2: 0x7fa06a, belly: 0xd6c69a, eye: 0x16200f }, particle: 0x9ab585,
      gait: { t: 'steady', mul: 0.5 }, steer: { t: 'ring', r: 5.5 }, react: { t: 'none' } },

    // ---- snails ----
    { id: 'gardenSnail', name: 'Garden Snail', plan: 'snail', tier: 'common', scale: 1.3, speed: 0.3,
      palette: { body: 0xc9a06a, accent: 0x8a5a36, accent2: 0x6e462a, belly: 0xb98d5a, eye: 0x241a10 }, particle: 0xd0aa74,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'sine', freq: 0.8, amp: 0.8 }, react: { t: 'none' } },
    { id: 'starSnail', name: 'Star Snail', plan: 'snail', tier: 'rare', scale: 0.5, speed: 1.1, sparkle: true,
      palette: { body: 0x7f6ff2, accent: 0x2d2a66, accent2: 0x4a44a8, belly: 0xffd94a, eye: 0x100e2a, glow: 0x8f7fff, glowI: 1.8 }, particle: 0xa89aff,
      gait: { t: 'pulse', freq: 1.4, mul: 1.6 }, steer: { t: 'spiral', rate: 0.55 }, react: { t: 'none' } },

    // ---- ghosts (aerial) ----
    { id: 'mistyGhost', name: 'Misty Ghost', plan: 'ghost', tier: 'uncommon', scale: 1.0, speed: 1.1, hover: 1.5,
      palette: { body: 0xbfd3df, eye: 0x1c2733, glow: 0x9fc9df, glowI: 0.9 }, particle: 0xcfe3ef,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'wander', jit: 0.02, turn: 1.2 }, react: { t: 'none' },
      special: { t: 'blink', period: 6.5, range: 4 } },
    { id: 'phantom', name: 'Phantom', plan: 'ghost', tier: 'rare', scale: 0.8, speed: 1.9, hover: 1.7,
      palette: { body: 0x7d8ad0, eye: 0x1a1033, glow: 0x7d6bff, glowI: 1.6 }, particle: 0x9a8aff,
      gait: { t: 'pulse', freq: 1.1, mul: 1.6 }, steer: { t: 'sine', freq: 1.7, amp: 1.8 }, react: { t: 'blinkflee', r: 4.5 },
      special: { t: 'blink', period: 0, range: 5 }, int: { dodge: 0.7 } },

    // ---- dragonlings (aerial, legendary) ----
    { id: 'emberwing', name: 'Emberwing Dragonling', plan: 'dragon', tier: 'legendary', scale: 1.1, speed: 2.5, hover: 2.1, sparkle: true, fire: true,
      palette: { body: 0xc22f1f, belly: 0xffc21f, accent: 0x7a1a10, eye: 0x0a0a0a, glow: 0xff6a1f, glowI: 2.0 }, particle: 0xff9a3c,
      gait: { t: 'pulse', freq: 1.9, mul: 2.0 }, steer: { t: 'sine', freq: 0.9, amp: 2.2 }, react: { t: 'panic' },
      int: { dodge: 0.85 } },
    { id: 'frostwing', name: 'Frostwing Dragonling', plan: 'dragon', tier: 'legendary', scale: 1.0, speed: 2.3, hover: 2.3, sparkle: true,
      palette: { body: 0x9fd8ef, belly: 0xeaf9ff, accent: 0x5a9ec9, eye: 0x0a0a0a, glow: 0x6fe3ff, glowI: 2.0 }, particle: 0xbfefff,
      gait: { t: 'steady', mul: 1.1 }, steer: { t: 'orbit', r: 6 }, react: { t: 'freeze', r: 13 },
      special: { t: 'dive', freq: 0.22 }, int: { dodge: 0.9 } },

    // ---- mushroom-kin ----
    { id: 'shroomkin', name: 'Shroomkin', plan: 'mushroom', tier: 'common', scale: 1.25, speed: 0.55,
      palette: { body: 0xc94f3f, belly: 0xe8dcc0, accent: 0xf5efdf, eye: 0x2a1c14 }, particle: 0xe08a72,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'wander', jit: 0.06, turn: 0.7 }, react: { t: 'hide', r: 3 } },
    { id: 'glowcap', name: 'Glowcap Shroomkin', plan: 'mushroom', tier: 'uncommon', scale: 1.0, speed: 1.0,
      palette: { body: 0x4a7dc9, belly: 0xd8e3f2, accent: 0xeaf2ff, eye: 0x101c2e, glow: 0x5fa8ff, glowI: 1.8 }, particle: 0x7fb8ff,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'orbit', r: 3.4 }, react: { t: 'taunt', r: 12 },
      int: { keep: [4, 8] } },

    // ---- beetles ----
    { id: 'dewBeetle', name: 'Dew Beetle', plan: 'beetle', tier: 'common', scale: 0.6, speed: 0.75,
      palette: { body: 0x3a4a5a, accent: 0x5a7a8a, accent2: 0x2c3844, eye: 0x11181f }, particle: 0x7a9aae,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'wander', jit: 0.09, turn: 2.1 }, react: { t: 'none' } },
    { id: 'jewelScarab', name: 'Jewel Scarab', plan: 'beetle', tier: 'rare', scale: 0.45, speed: 2.3, sparkle: true,
      palette: { body: 0x1f6b41, accent: 0x2ecc71, accent2: 0xffd700, eye: 0x061408, glow: 0x3affa0, glowI: 1.7 }, particle: 0x5affb0,
      gait: { t: 'dash', on: 0.4, off: 0.5, mul: 2.3 }, steer: { t: 'zigzag', freq: 4.6, amp: 0.7 }, react: { t: 'flee', r: 4, boost: 1.8 },
      int: { dodge: 0.7 } },

    // ---- jellies (aerial drifters) ----
    { id: 'driftJelly', name: 'Drift Jelly', plan: 'jelly', tier: 'uncommon', scale: 1.05, speed: 0.9, hover: 1.6,
      palette: { body: 0xffb7d0, accent: 0xff7fa8, eye: 0x33202a, glow: 0xff8fb8, glowI: 1.2 }, particle: 0xffa8c8,
      gait: { t: 'pulse', freq: 1.2, mul: 1.8 }, steer: { t: 'wander', jit: 0.015, turn: 0.8 }, react: { t: 'none' } },
    { id: 'nebulaJelly', name: 'Nebula Jelly', plan: 'jelly', tier: 'rare', scale: 0.8, speed: 1.7, hover: 1.9,
      palette: { body: 0x7a5af2, accent: 0x3ae8e0, eye: 0x101033, glow: 0x8a6aff, glowI: 1.8 }, particle: 0x9a7aff,
      gait: { t: 'pulse', freq: 1.9, mul: 2.0 }, steer: { t: 'spiral', rate: 0.9 }, react: { t: 'panic' },
      int: { dodge: 0.55 } },

    // ---- water dwellers (pond & river) ----
    { id: 'koi', name: 'Amber Koi', plan: 'fish', tier: 'common', scale: 0.9, speed: 1.1, aquatic: true,
      palette: { body: 0xe8863c, accent: 0xf6f0dd, accent2: 0xc7501f, eye: 0x1c1206 }, particle: 0xf0a860,
      gait: { t: 'pulse', freq: 1.4, mul: 1.8 }, steer: { t: 'channel' }, react: { t: 'none' },
      special: { t: 'leap', period: 5.5, dur: 0.75, h: 1.15 } },
    { id: 'riverOtter', name: 'River Otter', plan: 'otter', tier: 'uncommon', scale: 1.15, speed: 1.3, aquatic: true,
      palette: { body: 0x6b4a30, belly: 0xc9a878, accent: 0x4a3220, eye: 0x1a1008 }, particle: 0xb08a5c,
      gait: { t: 'stopgo', on: 0.9, off: 0.5, mul: 1.6 }, steer: { t: 'channel' }, react: { t: 'curious', far: 8, near: 2.4 },
      int: { alarm: true } },
    { id: 'glowfish', name: 'Lantern Glowfish', plan: 'fish', tier: 'rare', scale: 0.55, speed: 1.9, aquatic: true, sparkle: true,
      palette: { body: 0x36e0c8, accent: 0xbafff2, accent2: 0x1f8f96, eye: 0x062a26, glow: 0x3affd8, glowI: 2.2 }, particle: 0x6affe0,
      gait: { t: 'pulse', freq: 2.6, mul: 2.2 }, steer: { t: 'wander', jit: 0.06, turn: 2.2 }, react: { t: 'flee', r: 4.5, boost: 1.7 },
      int: { dodge: 0.6 } },

    // ---- true fliers ----
    { id: 'dragonfly', name: 'Brook Dragonfly', plan: 'dragonfly', tier: 'common', scale: 0.42, speed: 1.9, hover: 1.4,
      palette: { body: 0x2f9e8f, accent: 0xbfeaff, accent2: 0x1c5f56, eye: 0x0c1a18, glow: 0x66d9c8, glowI: 0.8 }, particle: 0x8fe8da,
      gait: { t: 'dash', on: 0.35, off: 0.4, mul: 2.6 }, steer: { t: 'zigzag', freq: 5.4, amp: 0.9 }, react: { t: 'none' },
      flight: { t: 'dart' }, int: { dodge: 0.3 } },
    { id: 'duskOwl', name: 'Dusk Owl', plan: 'owl', tier: 'uncommon', scale: 0.95, speed: 1.5, hover: 2.4,
      palette: { body: 0x7a6250, belly: 0xd9c6a8, accent: 0x51402f, eye: 0xffc94a }, particle: 0xc9b08a,
      gait: { t: 'steady', mul: 1 }, steer: { t: 'waypoint', pause: 1.6 }, react: { t: 'freeze', r: 12 },
      flight: { t: 'glide' }, int: { dodge: 0.45, cover: true } },
    { id: 'gloamBat', name: 'Gloam Bat', plan: 'bat', tier: 'uncommon', scale: 0.6, speed: 1.8, hover: 1.9,
      palette: { body: 0x3a3244, accent: 0x574a66, belly: 0x2a2433, eye: 0xd83a2e }, particle: 0x8a7aa8,
      gait: { t: 'pulse', freq: 3.5, mul: 1.9 }, steer: { t: 'zigzag', freq: 6.2, amp: 1.2 }, react: { t: 'panic' },
      flight: { t: 'jitter' }, int: { dodge: 0.5, alarm: true } },
    { id: 'hummingbird', name: 'Jewel Hummingbird', plan: 'hummingbird', tier: 'rare', scale: 0.38, speed: 2.4, hover: 1.6, sparkle: true,
      palette: { body: 0x27b06a, accent: 0xff5a8a, belly: 0xe9fff2, eye: 0x0a1c10, glow: 0x4affa0, glowI: 1.4 }, particle: 0x7dffb8,
      gait: { t: 'dash', on: 0.25, off: 0.8, mul: 3.0 }, steer: { t: 'orbit', r: 3 }, react: { t: 'flee', r: 4, boost: 1.8 },
      flight: { t: 'hoverdash' }, int: { dodge: 0.7 } },
    { id: 'phoenix', name: 'Dawn Phoenix', plan: 'phoenix', tier: 'legendary', scale: 1.9, speed: 2.2, hover: 3.0, sparkle: true, ember: true, fire: true,
      palette: { body: 0xe8481f, belly: 0xffc21f, accent: 0x8a1f0f, accent2: 0xffe27a, eye: 0x1c0a04, glow: 0xff7a1f, glowI: 2.2 }, particle: 0xffab4d,
      gait: { t: 'steady', mul: 1.15 }, steer: { t: 'ring', r: 13 }, react: { t: 'flee', r: 8, boost: 1.5 },
      special: { t: 'dive', freq: 0.15 }, flight: { t: 'soar' }, int: { dodge: 0.9 } },

    // ---- megafauna ----
    { id: 'greatElk', name: 'Great Elk', plan: 'elk', tier: 'uncommon', scale: 2.35, speed: 0.9,
      palette: { body: 0x8a6a48, belly: 0xc9b394, accent: 0x5f4630, accent2: 0xd9cba8, eye: 0x1c1206 }, particle: 0xbfa27c,
      gait: { t: 'stopgo', on: 1.6, off: 1.0, mul: 1.3 }, steer: { t: 'waypoint', pause: 1.4 }, react: { t: 'flee', r: 4, boost: 1.4 },
      int: { dodge: 0.35, cover: true, keep: [6, 11], alarm: true } },

    // ---- cave-exclusive types (Phase 2j; movement in cave-behavior.js) ----
    ...CAVE_CREATURE_TYPES,
];
