/* ============================================================
   Creatures & Monsters (Data-Driven Bestiary)
   ------------------------------------------------------------
   40 distinct types built from 16 handcrafted voxel body plans
   x stat/palette/behaviour variants. Every type owns a UNIQUE
   movement combo (gait + steering + special) plus a reaction
   behaviour, so no two types move alike. Difficulty tiers:
   common / uncommon / rare / legendary — harder types are
   smaller (per-creature hit radius), faster, skittish, erratic
   or aerial, and rare/legendary ones glow for the bloom pass.
   Shared BoxGeometry / MeshStandardMaterial caches keep the
   memory + draw cost of 30-40 creatures manageable.
   ============================================================ */

/* ------------------------------------------------------------
   Body plans — handcrafted voxel builders (<= 16 parts each).
   Each receives (P: palette, add: part helper, ud: userData).
   Group origin sits at the creature's feet (y = 0).
   ------------------------------------------------------------ */
export const CREATURE_PLANS = {
    slime(P, add, ud) {
        ud.body = add(0.5, 0.44, 0.5, P.body, 0, 0.24, 0, { trans: true, opacity: 0.85 });
        add(0.24, 0.22, 0.24, P.accent, 0, 0.22, 0, { glow: P.glow, glowI: P.glowI }); // core
        ud.eyes = [
            add(0.07, 0.08, 0.03, P.eye, -0.11, 0.28, 0.25),
            add(0.07, 0.08, 0.03, P.eye, 0.11, 0.28, 0.25),
        ];
        add(0.1, 0.03, 0.03, P.eye, 0, 0.16, 0.25); // mouth
        add(0.12, 0.06, 0.12, P.body, -0.26, 0.03, 0.16, { trans: true, opacity: 0.85 }); // drip
        add(0.09, 0.05, 0.09, P.body, 0.24, 0.03, -0.18, { trans: true, opacity: 0.85 }); // drip
    },

    bunny(P, add, ud) {
        ud.body = add(0.34, 0.3, 0.44, P.body, 0, 0.26, -0.04);
        ud.head = add(0.28, 0.26, 0.26, P.body, 0, 0.48, 0.2);
        add(0.14, 0.1, 0.06, P.belly, 0, -0.06, 0.15, { parent: ud.head });      // muzzle
        ud.ears = [
            add(0.08, 0.3, 0.05, P.body, -0.09, 0.24, -0.04, { parent: ud.head }),
            add(0.08, 0.3, 0.05, P.body, 0.09, 0.24, -0.04, { parent: ud.head }),
        ];
        add(0.05, 0.2, 0.03, P.accent, -0.09, 0.24, -0.01, { parent: ud.head }); // inner ear
        add(0.05, 0.2, 0.03, P.accent, 0.09, 0.24, -0.01, { parent: ud.head });
        ud.tail = add(0.14, 0.14, 0.14, P.belly, 0, 0.3, -0.28);
        ud.legs = [ // big hind feet
            add(0.12, 0.09, 0.22, P.body, -0.13, 0.045, 0.02),
            add(0.12, 0.09, 0.22, P.body, 0.13, 0.045, 0.02),
        ];
        ud.eyes = [
            add(0.05, 0.07, 0.03, P.eye, -0.09, 0.04, 0.13, { parent: ud.head }),
            add(0.05, 0.07, 0.03, P.eye, 0.09, 0.04, 0.13, { parent: ud.head }),
        ];
    },

    fox(P, add, ud) {
        ud.body = add(0.3, 0.26, 0.52, P.body, 0, 0.34, -0.02);
        add(0.24, 0.18, 0.18, P.belly, 0, 0.3, 0.2);                              // chest ruff
        ud.head = add(0.26, 0.22, 0.24, P.body, 0, 0.54, 0.3);
        add(0.1, 0.09, 0.14, P.belly, 0, -0.04, 0.17, { parent: ud.head });       // snout
        add(0.06, 0.05, 0.04, 0x201612, 0, -0.02, 0.25, { parent: ud.head });     // nose
        ud.ears = [
            add(0.09, 0.16, 0.05, P.body, -0.09, 0.17, -0.02, { parent: ud.head }),
            add(0.09, 0.16, 0.05, P.body, 0.09, 0.17, -0.02, { parent: ud.head }),
        ];
        ud.legs = [
            add(0.07, 0.26, 0.07, P.accent, -0.1, 0.13, 0.16),
            add(0.07, 0.26, 0.07, P.accent, 0.1, 0.13, 0.16),
            add(0.07, 0.26, 0.07, P.accent, -0.1, 0.13, -0.18),
            add(0.07, 0.26, 0.07, P.accent, 0.1, 0.13, -0.18),
        ];
        ud.tail = [
            add(0.13, 0.13, 0.26, P.body, 0, 0.42, -0.38, { rx: 0.35 }),
            add(0.1, 0.1, 0.14, P.belly, 0, 0.5, -0.52, { rx: 0.35 }),            // white tail tip
        ];
        ud.eyes = [
            add(0.04, 0.06, 0.03, P.eye, -0.08, 0.04, 0.125, { parent: ud.head }),
            add(0.04, 0.06, 0.03, P.eye, 0.08, 0.04, 0.125, { parent: ud.head }),
        ];
    },

    bird(P, add, ud) {
        ud.body = add(0.26, 0.24, 0.34, P.body, 0, 0.3, 0);
        add(0.18, 0.14, 0.1, P.belly, 0, 0.26, 0.16);                             // breast
        ud.head = add(0.2, 0.18, 0.18, P.accent, 0, 0.48, 0.16);
        add(0.06, 0.05, 0.12, 0xf5a623, 0, -0.02, 0.13, { parent: ud.head });     // beak
        ud.wings = [
            add(0.3, 0.05, 0.2, P.body, -0.26, 0.34, 0),
            add(0.3, 0.05, 0.2, P.body, 0.26, 0.34, 0),
        ];
        ud.tail = add(0.08, 0.04, 0.2, P.accent, 0, 0.3, -0.24, { rx: -0.3 });
        add(0.03, 0.12, 0.03, 0xf5a623, -0.06, 0.13, 0.02);                       // tucked legs
        add(0.03, 0.12, 0.03, 0xf5a623, 0.06, 0.13, 0.02);
        ud.eyes = [
            add(0.04, 0.05, 0.03, P.eye, -0.07, 0.02, 0.08, { parent: ud.head }),
            add(0.04, 0.05, 0.03, P.eye, 0.07, 0.02, 0.08, { parent: ud.head }),
        ];
    },

    duck(P, add, ud) {
        ud.body = add(0.36, 0.2, 0.5, P.body, 0, 0.1, 0);
        add(0.28, 0.1, 0.34, P.belly, 0, 0.22, 0.0);                              // back feathers
        add(0.09, 0.18, 0.09, P.accent, 0, 0.28, 0.2);                            // neck
        ud.head = add(0.16, 0.16, 0.16, P.accent, 0, 0.42, 0.2);
        add(0.1, 0.04, 0.14, 0xf59f2d, 0, -0.02, 0.13, { parent: ud.head });      // bill
        ud.wings = [
            add(0.08, 0.1, 0.3, P.accent2, -0.2, 0.16, -0.02),
            add(0.08, 0.1, 0.3, P.accent2, 0.2, 0.16, -0.02),
        ];
        ud.tail = add(0.12, 0.08, 0.12, P.body, 0, 0.18, -0.28, { rx: -0.4 });
        ud.eyes = [
            add(0.04, 0.04, 0.03, P.eye, -0.07, 0.03, 0.06, { parent: ud.head }),
            add(0.04, 0.04, 0.03, P.eye, 0.07, 0.03, 0.06, { parent: ud.head }),
        ];
    },

    frog(P, add, ud) {
        ud.body = add(0.32, 0.2, 0.34, P.body, 0, 0.14, 0);
        add(0.24, 0.1, 0.2, P.belly, 0, 0.08, 0.08);                              // belly
        const bulbL = add(0.1, 0.1, 0.1, P.body, -0.1, 0.28, 0.1);                // eye bulbs
        const bulbR = add(0.1, 0.1, 0.1, P.body, 0.1, 0.28, 0.1);
        ud.eyes = [
            add(0.06, 0.06, 0.03, P.eye, 0, 0.01, 0.05, { parent: bulbL }),
            add(0.06, 0.06, 0.03, P.eye, 0, 0.01, 0.05, { parent: bulbR }),
        ];
        ud.legs = [ // folded rear legs
            add(0.1, 0.1, 0.18, P.accent, -0.19, 0.08, -0.08),
            add(0.1, 0.1, 0.18, P.accent, 0.19, 0.08, -0.08),
        ];
        add(0.05, 0.08, 0.05, P.accent, -0.12, 0.05, 0.14);                       // front legs
        add(0.05, 0.08, 0.05, P.accent, 0.12, 0.05, 0.14);
        ud.throat = add(0.14, 0.08, 0.08, P.belly, 0, 0.1, 0.17);                 // vocal sac
    },

    spider(P, add, ud) {
        ud.body = add(0.3, 0.18, 0.3, P.body, 0, 0.24, 0.04);                     // cephalothorax
        add(0.34, 0.22, 0.3, P.accent, 0, 0.28, -0.22);                           // abdomen
        add(0.1, 0.06, 0.1, P.body, 0, 0.4, -0.22);                               // abdomen marking
        ud.head = add(0.18, 0.13, 0.14, P.body, 0, 0.24, 0.24);
        ud.eyes = [
            add(0.14, 0.045, 0.03, 0x0a0a0a, 0, 0.02, 0.075, { parent: ud.head, glow: P.glow, glowI: P.glowI }),
        ];
        ud.legs = [];
        for (let i = 0; i < 8; i++) {
            const side = i < 4 ? -1 : 1;
            const zOff = (i % 4) * 0.14 - 0.2;
            ud.legs.push(add(0.04, 0.3, 0.04, P.accent, side * 0.22, 0.15, zOff, { rz: side * 0.5 }));
        }
    },

    golem(P, add, ud) {
        ud.body = add(0.52, 0.44, 0.34, P.body, 0, 0.64, 0);                      // torso
        add(0.38, 0.22, 0.28, P.accent, 0, 0.36, 0);                              // hips
        ud.legs = [
            add(0.15, 0.28, 0.16, P.body, -0.15, 0.14, 0),
            add(0.15, 0.28, 0.16, P.body, 0.15, 0.14, 0),
        ];
        ud.arms = [
            add(0.14, 0.46, 0.15, P.accent, -0.36, 0.6, 0),
            add(0.14, 0.46, 0.15, P.accent, 0.36, 0.6, 0),
        ];
        ud.head = add(0.26, 0.24, 0.24, P.body, 0, 1.0, 0.03);
        ud.eyes = [
            add(0.17, 0.05, 0.03, 0x0a0a0a, 0, 0.0, 0.125, { parent: ud.head, glow: P.glow, glowI: P.glowI }),
        ];
        add(0.16, 0.1, 0.12, P.accent2, -0.26, 0.9, 0);                           // shoulder stones
        add(0.16, 0.1, 0.12, P.accent2, 0.26, 0.9, 0);
        add(0.3, 0.1, 0.1, P.belly, 0, 0.7, -0.2);                                // back slab (moss/magma/crystal)
    },
};

// (CREATURE_PLANS continued)
Object.assign(CREATURE_PLANS, {
    crab(P, add, ud) {
        ud.body = add(0.42, 0.18, 0.32, P.body, 0, 0.18, 0);
        add(0.3, 0.08, 0.22, P.accent, 0, 0.3, 0);                                // shell top
        ud.claws = [
            add(0.1, 0.08, 0.14, P.body, -0.3, 0.16, 0.16),                       // arm L
            add(0.14, 0.14, 0.16, P.accent, -0.36, 0.18, 0.3),                    // claw L
            add(0.1, 0.08, 0.14, P.body, 0.3, 0.16, 0.16),                        // arm R
            add(0.14, 0.14, 0.16, P.accent, 0.36, 0.18, 0.3),                     // claw R
        ];
        ud.legs = [
            add(0.05, 0.16, 0.05, P.accent, -0.24, 0.08, -0.05, { rz: -0.5 }),
            add(0.05, 0.16, 0.05, P.accent, -0.2, 0.08, -0.16, { rz: -0.5 }),
            add(0.05, 0.16, 0.05, P.accent, 0.24, 0.08, -0.05, { rz: 0.5 }),
            add(0.05, 0.16, 0.05, P.accent, 0.2, 0.08, -0.16, { rz: 0.5 }),
        ];
        add(0.035, 0.12, 0.035, P.body, -0.09, 0.36, 0.12);                       // eye stalks
        add(0.035, 0.12, 0.035, P.body, 0.09, 0.36, 0.12);
        ud.eyes = [
            add(0.06, 0.06, 0.05, P.eye, -0.09, 0.44, 0.12),
            add(0.06, 0.06, 0.05, P.eye, 0.09, 0.44, 0.12),
        ];
    },

    turtle(P, add, ud) {
        ud.body = add(0.4, 0.1, 0.46, P.belly, 0, 0.12, 0);                       // plastron
        add(0.44, 0.14, 0.5, P.body, 0, 0.22, 0);                                 // shell base
        add(0.32, 0.12, 0.38, P.accent, 0, 0.33, 0);                              // shell dome
        add(0.16, 0.06, 0.2, P.accent2, 0, 0.42, 0);                              // shell crown
        ud.head = add(0.16, 0.14, 0.16, P.belly, 0, 0.2, 0.32);
        ud.eyes = [
            add(0.04, 0.05, 0.03, P.eye, -0.055, 0.02, 0.085, { parent: ud.head }),
            add(0.04, 0.05, 0.03, P.eye, 0.055, 0.02, 0.085, { parent: ud.head }),
        ];
        ud.legs = [
            add(0.1, 0.1, 0.14, P.belly, -0.22, 0.07, 0.16),
            add(0.1, 0.1, 0.14, P.belly, 0.22, 0.07, 0.16),
            add(0.1, 0.1, 0.14, P.belly, -0.22, 0.07, -0.16),
            add(0.1, 0.1, 0.14, P.belly, 0.22, 0.07, -0.16),
        ];
        ud.tail = add(0.06, 0.05, 0.1, P.belly, 0, 0.12, -0.27);
    },

    snail(P, add, ud) {
        ud.body = add(0.16, 0.1, 0.5, P.body, 0, 0.05, 0.04);                     // foot
        ud.head = add(0.14, 0.12, 0.12, P.body, 0, 0.12, 0.26);                   // head rise
        ud.stalks = [
            add(0.03, 0.16, 0.03, P.body, -0.05, 0.13, 0.03, { parent: ud.head, rx: -0.2 }),
            add(0.03, 0.16, 0.03, P.body, 0.05, 0.13, 0.03, { parent: ud.head, rx: -0.2 }),
        ];
        ud.eyes = [
            add(0.05, 0.05, 0.05, P.eye, 0, 0.09, 0.01, { parent: ud.stalks[0] }),
            add(0.05, 0.05, 0.05, P.eye, 0, 0.09, 0.01, { parent: ud.stalks[1] }),
        ];
        ud.shell = [
            add(0.26, 0.26, 0.3, P.accent, 0, 0.24, -0.12),
            add(0.18, 0.18, 0.22, P.accent2, 0, 0.3, -0.08, { ry: 0.3 }),
            add(0.1, 0.1, 0.12, P.belly, 0, 0.36, -0.04, { ry: 0.6, glow: P.glow, glowI: P.glowI }),
        ];
    },

    ghost(P, add, ud) {
        ud.body = add(0.34, 0.42, 0.3, P.body, 0, 0.5, 0, { trans: true, opacity: 0.72, glow: P.glow, glowI: P.glowI });
        ud.eyes = [
            add(0.06, 0.09, 0.03, P.eye, -0.08, 0.58, 0.16),
            add(0.06, 0.09, 0.03, P.eye, 0.08, 0.58, 0.16),
        ];
        add(0.07, 0.05, 0.03, P.eye, 0, 0.44, 0.16);                              // mouth
        ud.arms = [
            add(0.09, 0.2, 0.09, P.body, -0.22, 0.46, 0, { trans: true, opacity: 0.72, rz: 0.5, glow: P.glow, glowI: P.glowI }),
            add(0.09, 0.2, 0.09, P.body, 0.22, 0.46, 0, { trans: true, opacity: 0.72, rz: -0.5, glow: P.glow, glowI: P.glowI }),
        ];
        ud.wisps = [
            add(0.2, 0.12, 0.18, P.body, 0, 0.22, 0, { trans: true, opacity: 0.6 }),
            add(0.12, 0.1, 0.12, P.body, -0.08, 0.1, 0.02, { trans: true, opacity: 0.5 }),
            add(0.1, 0.08, 0.1, P.body, 0.09, 0.05, -0.03, { trans: true, opacity: 0.45 }),
        ];
    },

    dragon(P, add, ud) {
        ud.body = add(0.3, 0.26, 0.46, P.body, 0, 0.5, 0);
        add(0.22, 0.14, 0.3, P.belly, 0, 0.42, 0.06);                             // chest plates
        ud.head = add(0.22, 0.18, 0.2, P.body, 0, 0.68, 0.3);
        add(0.1, 0.08, 0.12, P.accent, 0, -0.02, 0.15, { parent: ud.head });      // snout
        add(0.05, 0.12, 0.05, P.accent, -0.07, 0.13, -0.04, { parent: ud.head, rx: -0.4 }); // horns
        add(0.05, 0.12, 0.05, P.accent, 0.07, 0.13, -0.04, { parent: ud.head, rx: -0.4 });
        ud.eyes = [
            add(0.04, 0.05, 0.03, 0x0a0a0a, -0.08, 0.03, 0.1, { parent: ud.head, glow: P.glow, glowI: P.glowI }),
            add(0.04, 0.05, 0.03, 0x0a0a0a, 0.08, 0.03, 0.1, { parent: ud.head, glow: P.glow, glowI: P.glowI }),
        ];
        ud.wings = [
            add(0.4, 0.04, 0.26, P.accent, -0.32, 0.62, -0.04),
            add(0.4, 0.04, 0.26, P.accent, 0.32, 0.62, -0.04),
        ];
        ud.tail = [
            add(0.12, 0.12, 0.22, P.body, 0, 0.46, -0.32),
            add(0.08, 0.08, 0.18, P.accent, 0, 0.44, -0.48),
        ];
    },

    mushroom(P, add, ud) {
        ud.body = add(0.22, 0.28, 0.2, P.belly, 0, 0.2, 0);                       // stem body
        ud.cap = add(0.46, 0.14, 0.46, P.body, 0, 0.42, 0, { glow: P.glow, glowI: P.glowI });
        ud.capTop = add(0.3, 0.1, 0.3, P.body, 0, 0.53, 0, { glow: P.glow, glowI: P.glowI });
        ud.spots = [
            add(0.08, 0.05, 0.08, P.accent, -0.12, 0.5, 0.12),
            add(0.07, 0.05, 0.07, P.accent, 0.1, 0.5, -0.1),
            add(0.06, 0.04, 0.06, P.accent, 0.14, 0.49, 0.08),
        ];
        ud.eyes = [
            add(0.05, 0.07, 0.03, P.eye, -0.06, 0.24, 0.105),
            add(0.05, 0.07, 0.03, P.eye, 0.06, 0.24, 0.105),
        ];
        ud.legs = [
            add(0.08, 0.07, 0.1, P.belly, -0.07, 0.035, 0.01),
            add(0.08, 0.07, 0.1, P.belly, 0.07, 0.035, 0.01),
        ];
    },

    beetle(P, add, ud) {
        ud.body = add(0.28, 0.14, 0.38, P.body, 0, 0.14, 0);
        ud.shell = [ // elytra halves
            add(0.13, 0.1, 0.3, P.accent, -0.075, 0.24, -0.04, { glow: P.glow, glowI: P.glowI }),
            add(0.13, 0.1, 0.3, P.accent, 0.075, 0.24, -0.04, { glow: P.glow, glowI: P.glowI }),
        ];
        ud.head = add(0.14, 0.1, 0.12, P.body, 0, 0.16, 0.24);
        add(0.04, 0.18, 0.04, P.body, 0, 0.12, 0.04, { parent: ud.head, rx: 0.5 }); // horn
        ud.eyes = [
            add(0.035, 0.04, 0.03, P.eye, -0.045, 0.02, 0.065, { parent: ud.head }),
            add(0.035, 0.04, 0.03, P.eye, 0.045, 0.02, 0.065, { parent: ud.head }),
        ];
        ud.legs = [
            add(0.035, 0.12, 0.035, P.accent2, -0.16, 0.07, 0.1, { rz: -0.5 }),
            add(0.035, 0.12, 0.035, P.accent2, 0.16, 0.07, 0.1, { rz: 0.5 }),
            add(0.035, 0.12, 0.035, P.accent2, -0.16, 0.07, -0.1, { rz: -0.5 }),
            add(0.035, 0.12, 0.035, P.accent2, 0.16, 0.07, -0.1, { rz: 0.5 }),
        ];
    },

    fish(P, add, ud) { // koi / glowfish — surface swimmer, body low in the water
        ud.body = add(0.2, 0.18, 0.42, P.body, 0, 0.12, 0);
        add(0.16, 0.14, 0.18, P.accent, 0, 0.13, 0.1);                            // saddle patch
        add(0.12, 0.1, 0.14, P.accent2, 0, 0.15, -0.08);                          // rear patch
        ud.head = add(0.16, 0.14, 0.14, P.body, 0, 0.12, 0.24);
        add(0.08, 0.05, 0.05, P.accent, 0, -0.045, 0.05, { parent: ud.head });    // chin barbels
        ud.tail = add(0.05, 0.16, 0.16, P.accent2, 0, 0.12, -0.28);               // tail fin
        ud.fins = [
            add(0.14, 0.04, 0.1, P.accent, -0.13, 0.08, 0.08, { rz: 0.4 }),
            add(0.14, 0.04, 0.1, P.accent, 0.13, 0.08, 0.08, { rz: -0.4 }),
        ];
        add(0.04, 0.12, 0.14, P.accent2, 0, 0.24, -0.04);                         // dorsal fin
        ud.eyes = [
            add(0.04, 0.04, 0.03, P.eye, -0.075, 0.03, 0.05, { parent: ud.head }),
            add(0.04, 0.04, 0.03, P.eye, 0.075, 0.03, 0.05, { parent: ud.head }),
        ];
    },

    otter(P, add, ud) { // long low body paddling on the surface
        ud.body = add(0.26, 0.2, 0.56, P.body, 0, 0.16, -0.04);
        add(0.2, 0.12, 0.36, P.belly, 0, 0.1, 0.06);                              // pale chest
        ud.head = add(0.2, 0.17, 0.2, P.body, 0, 0.28, 0.3);
        add(0.12, 0.08, 0.08, P.belly, 0, -0.045, 0.11, { parent: ud.head });     // muzzle
        add(0.05, 0.04, 0.03, 0x201612, 0, -0.01, 0.16, { parent: ud.head });     // nose
        add(0.06, 0.06, 0.04, P.accent, -0.08, 0.09, 0.0, { parent: ud.head });   // ears
        add(0.06, 0.06, 0.04, P.accent, 0.08, 0.09, 0.0, { parent: ud.head });
        ud.paws = [
            add(0.08, 0.06, 0.12, P.accent, -0.15, 0.08, 0.18),
            add(0.08, 0.06, 0.12, P.accent, 0.15, 0.08, 0.18),
        ];
        ud.tail = add(0.1, 0.08, 0.34, P.accent, 0, 0.14, -0.44, { rx: 0.12 });   // thick rudder tail
        ud.eyes = [
            add(0.04, 0.05, 0.03, P.eye, -0.065, 0.035, 0.095, { parent: ud.head }),
            add(0.04, 0.05, 0.03, P.eye, 0.065, 0.035, 0.095, { parent: ud.head }),
        ];
    },

    dragonfly(P, add, ud) { // needle body, two shimmering wing pairs
        ud.body = add(0.12, 0.1, 0.3, P.body, 0, 0.3, 0.06);
        ud.tail = add(0.06, 0.06, 0.42, P.accent2, 0, 0.31, -0.28);               // long abdomen needle
        ud.head = add(0.13, 0.11, 0.1, P.body, 0, 0.31, 0.22);
        ud.eyes = [ // huge compound eyes
            add(0.06, 0.07, 0.06, P.eye, -0.05, 0.02, 0.02, { parent: ud.head }),
            add(0.06, 0.07, 0.06, P.eye, 0.05, 0.02, 0.02, { parent: ud.head }),
        ];
        ud.wings = [ // fore + hind pairs (animated as blur flicks)
            add(0.4, 0.02, 0.09, P.accent, -0.24, 0.36, 0.1, { trans: true, opacity: 0.55 }),
            add(0.4, 0.02, 0.09, P.accent, 0.24, 0.36, 0.1, { trans: true, opacity: 0.55 }),
            add(0.34, 0.02, 0.08, P.accent, -0.21, 0.34, -0.04, { trans: true, opacity: 0.45 }),
            add(0.34, 0.02, 0.08, P.accent, 0.21, 0.34, -0.04, { trans: true, opacity: 0.45 }),
        ];
    },

    owl(P, add, ud) { // upright rounded body, flat face, big amber eyes
        ud.body = add(0.34, 0.4, 0.28, P.body, 0, 0.34, 0);
        add(0.24, 0.3, 0.08, P.belly, 0, 0.32, 0.13);                             // speckled front
        ud.head = add(0.3, 0.24, 0.24, P.body, 0, 0.64, 0.02);
        add(0.24, 0.16, 0.05, P.belly, 0, 0.0, 0.11, { parent: ud.head });        // facial disc
        add(0.06, 0.08, 0.05, P.accent, -0.11, 0.14, 0.0, { parent: ud.head });   // ear tufts
        add(0.06, 0.08, 0.05, P.accent, 0.11, 0.14, 0.0, { parent: ud.head });
        add(0.05, 0.06, 0.06, 0xf5a623, 0, -0.03, 0.14, { parent: ud.head });     // beak
        ud.wings = [
            add(0.1, 0.32, 0.22, P.accent, -0.22, 0.36, -0.02),
            add(0.1, 0.32, 0.22, P.accent, 0.22, 0.36, -0.02),
        ];
        ud.tail = add(0.16, 0.05, 0.18, P.accent, 0, 0.16, -0.18, { rx: -0.35 });
        add(0.04, 0.1, 0.04, 0xf5a623, -0.07, 0.1, 0.04);                         // talons
        add(0.04, 0.1, 0.04, 0xf5a623, 0.07, 0.1, 0.04);
        ud.eyes = [
            add(0.07, 0.08, 0.03, P.eye, -0.07, 0.02, 0.13, { parent: ud.head }),
            add(0.07, 0.08, 0.03, P.eye, 0.07, 0.02, 0.13, { parent: ud.head }),
        ];
    },

    bat(P, add, ud) { // scrappy body between two big jagged wing panels
        ud.body = add(0.2, 0.24, 0.18, P.body, 0, 0.34, 0);
        add(0.14, 0.12, 0.06, P.belly, 0, 0.3, 0.09);                             // chest tuft
        ud.head = add(0.16, 0.14, 0.14, P.body, 0, 0.52, 0.04);
        add(0.05, 0.11, 0.04, P.accent, -0.06, 0.11, -0.01, { parent: ud.head }); // tall ears
        add(0.05, 0.11, 0.04, P.accent, 0.06, 0.11, -0.01, { parent: ud.head });
        add(0.05, 0.04, 0.04, P.accent, 0, -0.03, 0.08, { parent: ud.head });     // snub nose
        ud.wings = [ // inner arm + outer jagged panel per side
            add(0.26, 0.03, 0.16, P.accent, -0.2, 0.4, 0),
            add(0.26, 0.03, 0.16, P.accent, 0.2, 0.4, 0),
        ];
        ud.wingTips = [
            add(0.2, 0.025, 0.24, P.body, -0.4, 0.4, -0.03),
            add(0.2, 0.025, 0.24, P.body, 0.4, 0.4, -0.03),
        ];
        add(0.05, 0.08, 0.05, P.accent, -0.05, 0.2, -0.02);                       // tucked feet
        add(0.05, 0.08, 0.05, P.accent, 0.05, 0.2, -0.02);
        ud.eyes = [
            add(0.035, 0.045, 0.03, P.eye, -0.045, 0.01, 0.075, { parent: ud.head }),
            add(0.035, 0.045, 0.03, P.eye, 0.045, 0.01, 0.075, { parent: ud.head }),
        ];
    },

    hummingbird(P, add, ud) { // tiny gem: iridescent body, needle bill, blur wings
        ud.body = add(0.16, 0.16, 0.22, P.body, 0, 0.3, 0, { glow: P.glow, glowI: (P.glowI || 1) * 0.5 });
        add(0.12, 0.1, 0.08, P.accent, 0, 0.28, 0.1);                             // throat gorget flash
        ud.head = add(0.13, 0.12, 0.12, P.body, 0, 0.42, 0.08);
        add(0.025, 0.025, 0.22, 0x2a2118, 0, -0.01, 0.16, { parent: ud.head });   // needle bill
        ud.wings = [ // long blur-fast blades
            add(0.3, 0.02, 0.1, P.belly, -0.18, 0.34, -0.02, { trans: true, opacity: 0.6 }),
            add(0.3, 0.02, 0.1, P.belly, 0.18, 0.34, -0.02, { trans: true, opacity: 0.6 }),
        ];
        ud.tail = add(0.1, 0.03, 0.16, P.accent, 0, 0.26, -0.16, { rx: -0.35 });
        ud.eyes = [
            add(0.035, 0.04, 0.03, P.eye, -0.05, 0.02, 0.05, { parent: ud.head }),
            add(0.035, 0.04, 0.03, P.eye, 0.05, 0.02, 0.05, { parent: ud.head }),
        ];
    },

    phoenix(P, add, ud) { // regal firebird: crest, broad wings, plume tail
        ud.body = add(0.34, 0.32, 0.44, P.body, 0, 0.52, 0, { glow: P.glow, glowI: (P.glowI || 1) * 0.35 });
        add(0.26, 0.2, 0.14, P.belly, 0, 0.46, 0.2, { glow: P.glow, glowI: (P.glowI || 1) * 0.5 }); // molten breast
        ud.head = add(0.22, 0.2, 0.2, P.body, 0, 0.82, 0.22);
        add(0.07, 0.06, 0.14, 0xffc21f, 0, -0.02, 0.15, { parent: ud.head });     // beak
        ud.crest = [ // flame crest feathers
            add(0.05, 0.16, 0.05, P.belly, 0, 0.15, -0.03, { parent: ud.head, rx: -0.4, glow: P.glow, glowI: (P.glowI || 1) * 0.8 }),
            add(0.04, 0.13, 0.04, P.accent2, -0.06, 0.13, -0.06, { parent: ud.head, rx: -0.6 }),
            add(0.04, 0.13, 0.04, P.accent2, 0.06, 0.13, -0.06, { parent: ud.head, rx: -0.6 }),
        ];
        ud.wings = [ // broad two-part wings
            add(0.5, 0.05, 0.3, P.body, -0.4, 0.62, -0.02),
            add(0.5, 0.05, 0.3, P.body, 0.4, 0.62, -0.02),
        ];
        ud.wingTips = [
            add(0.3, 0.04, 0.22, P.belly, -0.76, 0.62, -0.06, { glow: P.glow, glowI: (P.glowI || 1) * 0.6 }),
            add(0.3, 0.04, 0.22, P.belly, 0.76, 0.62, -0.06, { glow: P.glow, glowI: (P.glowI || 1) * 0.6 }),
        ];
        ud.tail = [ // long trailing plumes
            add(0.08, 0.05, 0.4, P.belly, 0, 0.48, -0.4, { rx: 0.25, glow: P.glow, glowI: (P.glowI || 1) * 0.7 }),
            add(0.06, 0.04, 0.34, P.accent2, -0.1, 0.46, -0.36, { rx: 0.3 }),
            add(0.06, 0.04, 0.34, P.accent2, 0.1, 0.46, -0.36, { rx: 0.3 }),
        ];
        ud.eyes = [
            add(0.04, 0.05, 0.03, P.eye, -0.08, 0.03, 0.1, { parent: ud.head }),
            add(0.04, 0.05, 0.03, P.eye, 0.08, 0.03, 0.1, { parent: ud.head }),
        ];
    },

    elk(P, add, ud) { // tall megafauna: long legs, shoulder hump, antler racks
        ud.body = add(0.34, 0.34, 0.62, P.body, 0, 0.62, -0.04);
        add(0.28, 0.16, 0.24, P.accent, 0, 0.76, 0.14);                           // shoulder hump
        add(0.24, 0.14, 0.3, P.belly, 0, 0.5, 0.0);                               // underbelly
        ud.head = add(0.18, 0.2, 0.26, P.body, 0, 0.95, 0.36);
        add(0.1, 0.1, 0.12, P.belly, 0, -0.05, 0.15, { parent: ud.head });        // muzzle
        ud.antlers = [ // main beams + tines
            add(0.05, 0.24, 0.05, P.accent2, -0.09, 0.2, -0.05, { parent: ud.head, rz: 0.5 }),
            add(0.05, 0.24, 0.05, P.accent2, 0.09, 0.2, -0.05, { parent: ud.head, rz: -0.5 }),
            add(0.04, 0.16, 0.04, P.accent2, -0.17, 0.28, -0.02, { parent: ud.head, rz: 1.0 }),
            add(0.04, 0.16, 0.04, P.accent2, 0.17, 0.28, -0.02, { parent: ud.head, rz: -1.0 }),
        ];
        ud.legs = [
            add(0.09, 0.46, 0.09, P.accent, -0.12, 0.23, 0.2),
            add(0.09, 0.46, 0.09, P.accent, 0.12, 0.23, 0.2),
            add(0.09, 0.46, 0.09, P.accent, -0.12, 0.23, -0.22),
            add(0.09, 0.46, 0.09, P.accent, 0.12, 0.23, -0.22),
        ];
        ud.tail = add(0.08, 0.1, 0.06, P.belly, 0, 0.66, -0.36);
        ud.eyes = [
            add(0.04, 0.05, 0.03, P.eye, -0.09, 0.04, 0.11, { parent: ud.head }),
            add(0.04, 0.05, 0.03, P.eye, 0.09, 0.04, 0.11, { parent: ud.head }),
        ];
    },

    // Phase 2j — SWARM: a loose cloud of tiny glowing gnats (caught as one).
    // No single body: a scatter of little emissive cubes milling around a
    // faint core, so the whole cluster reads as "several" and sucks in together.
    swarm(P, add, ud) {
        add(0.12, 0.12, 0.12, P.body, 0, 0.5, 0, { trans: true, opacity: 0.35, glow: P.glow, glowI: (P.glowI || 1) * 0.6 }); // faint core
        ud.motes = [];
        const spots = [
            [-0.18, 0.62, 0.06], [0.2, 0.44, -0.1], [0.05, 0.7, -0.05], [-0.1, 0.36, 0.14],
            [0.16, 0.58, 0.16], [-0.22, 0.5, -0.14], [0.0, 0.5, 0.22], [0.24, 0.66, 0.02],
            [-0.05, 0.3, -0.12], [0.1, 0.78, 0.1],
        ];
        for (let i = 0; i < spots.length; i++) {
            const [x, y, z] = spots[i];
            const m = add(0.075, 0.075, 0.075, i % 2 ? P.accent : P.body, x, y, z, { glow: P.glow, glowI: P.glowI });
            m.userData.home = { x, y, z };
            m.userData.ph = i * 0.9;
            ud.motes.push(m);
        }
    },

    jelly(P, add, ud) {
        ud.body = add(0.36, 0.22, 0.36, P.body, 0, 0.52, 0, { trans: true, opacity: 0.62, glow: P.glow, glowI: P.glowI });
        add(0.24, 0.12, 0.24, P.accent, 0, 0.44, 0, { trans: true, opacity: 0.8, glow: P.glow, glowI: (P.glowI || 1.2) * 1.4 }); // core
        ud.eyes = [
            add(0.05, 0.06, 0.03, P.eye, -0.07, 0.52, 0.185),
            add(0.05, 0.06, 0.03, P.eye, 0.07, 0.52, 0.185),
        ];
        ud.tentacles = [
            add(0.045, 0.34, 0.045, P.accent, -0.12, 0.24, -0.1, { trans: true, opacity: 0.7 }),
            add(0.045, 0.34, 0.045, P.accent, 0.12, 0.24, -0.08, { trans: true, opacity: 0.7 }),
            add(0.045, 0.34, 0.045, P.accent, -0.1, 0.24, 0.1, { trans: true, opacity: 0.7 }),
            add(0.045, 0.34, 0.045, P.accent, 0.1, 0.24, 0.12, { trans: true, opacity: 0.7 }),
        ];
    },
});

// Per-plan capture geometry: base hit-sphere radius + body-center height
// (both scale with the type's size — small types are genuinely harder to hit)
export const PLAN_META = {
    slime:    { hitR: 0.34, centerY: 0.26 },
    bunny:    { hitR: 0.32, centerY: 0.34 },
    fox:      { hitR: 0.34, centerY: 0.38 },
    bird:     { hitR: 0.26, centerY: 0.32 },
    duck:     { hitR: 0.3,  centerY: 0.18 },
    frog:     { hitR: 0.28, centerY: 0.18 },
    spider:   { hitR: 0.32, centerY: 0.26 },
    golem:    { hitR: 0.44, centerY: 0.62 },
    crab:     { hitR: 0.32, centerY: 0.2, face: Math.PI / 2 }, // scuttles sideways
    turtle:   { hitR: 0.34, centerY: 0.24 },
    snail:    { hitR: 0.26, centerY: 0.2 },
    ghost:    { hitR: 0.3,  centerY: 0.48 },
    dragon:   { hitR: 0.34, centerY: 0.52 },
    mushroom: { hitR: 0.3,  centerY: 0.32 },
    beetle:   { hitR: 0.26, centerY: 0.16 },
    jelly:    { hitR: 0.3,  centerY: 0.48 },
    swarm:    { hitR: 0.46, centerY: 0.52 }, // generous: a cloud you catch as one
    fish:     { hitR: 0.32, centerY: 0.14 },
    otter:    { hitR: 0.34, centerY: 0.2 },
    dragonfly:{ hitR: 0.5,  centerY: 0.32 }, // generous plan radius: tiny scale shrinks it hard
    owl:      { hitR: 0.34, centerY: 0.44 },
    bat:      { hitR: 0.38, centerY: 0.38 },
    hummingbird: { hitR: 0.52, centerY: 0.32 },
    phoenix:  { hitR: 0.4,  centerY: 0.58 },
    elk:      { hitR: 0.42, centerY: 0.62 },
};
