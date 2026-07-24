/* ============================================================
   Cave Bestiary — Phase 2j (CREATURES & life, items 65–76)
   ------------------------------------------------------------
   Eleven cave-EXCLUSIVE types (flag `cave: true`) that the spawn
   deck keeps OUT of the surface pools and places only inside the
   seeded caves (creatures/cave-spawn.js), biased by the 2e theme
   `spawnBias`. Each carries a `caveBehavior` string that routes it
   to a UNIQUE movement engine in cave-behavior.js (the hard rule:
   no two types move alike):

     roost   (65) colony bats hang on the vault, SCATTER on approach
     wyrm    (66) cathedral-only LEGENDARY, slow serpentine vault patrol
     blind   (67) pale eyeless creeper, freezes/trembles when sensed
     school  (68) glowfish shoal darting inside a cave water pool
     emerge  (69) low-light dweller: hides under light, out in the dark
     sleep   (70) slumbering hulk that wakes and BOLTS if disturbed
     guard   (71) territorial warden defending the crystal chamber
     swarm   (72) spore-gnat cloud, caught as one group
     lantern (73) moth drawn toward / repelled by the player's lantern
     skitter (75) wall/ceiling crawler (climbs the rock, not the floor)
     echo    (76) echo-locator, visible only when it periodically CALLS

   Every type has display name + tier + palette + `particle` so the
   targeting readout, toast, capture-rate ladder and catch flow work
   exactly as they do for the surface bestiary. Body PLANS are reused
   from plans.js (plus the new `swarm` cluster plan) — the movement,
   not the mesh, is what stays unique.
   ------------------------------------------------------------ */
export const CAVE_CREATURE_TYPES = [
    // 65 — CEILING BAT COLONY (bat/flooded themes)
    { id: 'colonyBat', name: 'Roost Bat', plan: 'bat', tier: 'uncommon', scale: 0.58, speed: 1.9, hover: 2.0,
      cave: true, caveBehavior: 'roost',
      // item 310: nocturnal eye-shine — glow wired into the bat plan's eyes
      palette: { body: 0x2e2833, accent: 0x453c52, belly: 0x241f2c, eye: 0xd8452e, glow: 0xff5a3a, glowI: 1.0 }, particle: 0x7a6a94 },

    // 66 — CAVE LEGENDARY: the Gloomwyrm (cathedral only, 1/world)
    { id: 'gloomwyrm', name: 'Gloomwyrm', plan: 'dragon', tier: 'legendary', scale: 2.35, speed: 1.4, hover: 2.4,
      cave: true, caveBehavior: 'wyrm', sparkle: true, cathedral: true,
      palette: { body: 0x1c2740, belly: 0x2a3f66, accent: 0x0f1626, eye: 0x0a0a0a, glow: 0x6fe3ff, glowI: 2.2 }, particle: 0x8fe6ff },

    // 67 — BLIND pale cave-adapted variant (eyeless salamander)
    { id: 'paleSalamander', name: 'Pale Salamander', plan: 'frog', tier: 'common', scale: 1.05, speed: 0.62,
      cave: true, caveBehavior: 'blind',
      palette: { body: 0xe6dde0, belly: 0xf4eef1, accent: 0xd6bcc6, eye: 0xe0d6da }, particle: 0xe4d8dd },

    // 68 — GLOWFISH SCHOOL in cave water pools (flooded theme)
    { id: 'caveGlowfish', name: 'Grotto Glowfish', plan: 'fish', tier: 'rare', scale: 0.5, speed: 1.7, aquatic: true,
      cave: true, caveBehavior: 'school', sparkle: true,
      palette: { body: 0xbfeaf2, accent: 0xe8fbff, accent2: 0x7fbfd0, eye: 0x14343c, glow: 0x8fe0ff, glowI: 2.0 }, particle: 0xaef0ff },

    // 69 — LOW-LIGHT EMERGER (hides under the lantern, out in the dark)
    { id: 'shadeGel', name: 'Shade Gel', plan: 'slime', tier: 'uncommon', scale: 1.05, speed: 0.9,
      cave: true, caveBehavior: 'emerge',
      palette: { body: 0x8fb0a8, accent: 0x5f8078, belly: 0xb8d0c8, eye: 0x14201c, glow: 0x6fd0b8, glowI: 1.0 }, particle: 0x9fd8c8 },

    // 70 — SLEEPING hulk that wakes + bolts
    { id: 'slumberTroll', name: 'Slumbering Troll', plan: 'golem', tier: 'uncommon', scale: 2.2, speed: 1.3,
      cave: true, caveBehavior: 'sleep',
      palette: { body: 0x4a4640, accent: 0x35322d, belly: 0x5a6b46, accent2: 0x625d54, eye: 0x0a0a0a, glow: 0xffb04a, glowI: 1.2 }, particle: 0x9a9488 },

    // 71 — TERRITORIAL GUARDIAN of the crystal chamber
    { id: 'crystalWarden', name: 'Crystal Warden', plan: 'crab', tier: 'rare', scale: 1.55, speed: 1.4,
      cave: true, caveBehavior: 'guard',
      palette: { body: 0x5a6a8a, accent: 0x8f7fd8, eye: 0x0a0a0a, glow: 0x9a7fff, glowI: 1.3 }, particle: 0xb0a0ff },

    // 72 — SWARM (caught as a group)
    { id: 'sporeSwarm', name: 'Spore Swarm', plan: 'swarm', tier: 'uncommon', scale: 1.0, speed: 1.2, hover: 1.2,
      cave: true, caveBehavior: 'swarm', sparkle: true,
      palette: { body: 0x9affc0, accent: 0x5fe0a0, eye: 0x0a1a10, glow: 0x7dffb0, glowI: 1.8 }, particle: 0x9affc0 },

    // 73 — LANTERN-REACTIVE moth
    { id: 'lanternMoth', name: 'Lantern Moth', plan: 'dragonfly', tier: 'uncommon', scale: 0.72, speed: 1.6, hover: 1.7,
      cave: true, caveBehavior: 'lantern', flight: { t: 'jitter' },
      palette: { body: 0xd8c8a8, accent: 0xf0e6d0, accent2: 0xa89880, eye: 0x2a2018, glow: 0xffe6a0, glowI: 0.7 }, particle: 0xf0e0c0 },

    // 75 — WALL / CEILING SKITTERER
    { id: 'wallCreeper', name: 'Wall Creeper', plan: 'spider', tier: 'uncommon', scale: 0.8, speed: 1.5,
      cave: true, caveBehavior: 'skitter',
      palette: { body: 0x6a6270, accent: 0x4a4452, eye: 0x0a0a0a, glow: 0xb08fff, glowI: 0.9 }, particle: 0x9a8ab0 },

    // 76 — ECHO-LOCATOR (reveal-on-call)
    { id: 'echoWisp', name: 'Echo Wisp', plan: 'ghost', tier: 'rare', scale: 0.92, speed: 1.5, hover: 1.6,
      cave: true, caveBehavior: 'echo',
      palette: { body: 0xbfeef0, eye: 0x1c3338, glow: 0x7fe0ff, glowI: 1.5 }, particle: 0xaef0ff },
];
