/* ============================================================
   Cave theme PACKS — Phase 2g decoration (rock / crystal / fungi)
   ------------------------------------------------------------
   THE EXTENSION SURFACE the CAVE DEPTH PROGRAM grows. Each of the six
   themes registers a descriptor with the registry here; caves.js
   imports this module for its side effects, so all themes are
   installed before buildCaves() runs. The core cave files
   (caves.js / caves-data.js / heightfield.js) are NEVER edited — all
   decoration flows through the 2e hooks:
     decorate(ctx)  push voxel/crystal/fungi detail into the CULLED
                    per-cave layer (via DecorKit + rec.aux) so it
                    LODs + culls for free.
     lights(ctx)    a hero-crystal accent light (auto-culled).
     update(u)      the shared per-frame animator (shimmer, chime,
                    puffball burst, proximity brighten, singing).
     dispose(cave)  drop the per-cave animated-decor state.

   Phase 2g distributes the item sets so caves read DISTINCT:
     crystal      hero crystal + selenite fields + amethyst + singing
     geode        many geodes + amethyst pockets + amethyst hero
     fungal       brackets / stalks / puffballs / proximity mushrooms /
                  vines / pale plants / moss curtains / floor mats
     flooded      KEEPS the 2b pool; adds wet gloss + mushroom ring +
                  glowing mats + pale plants around the water
     mineral-ore  glowing ore veins + fossils + glowing fissures
     bat          guano / nitre under roosts + dark roots (kept dim)
   All themes also get the shared base rock pass (flowstone, rimstone,
   depth banding, host-zone tint, mouth moss, floor character, soot).
   ============================================================ */

import { registerCaveTheme, zoneGlowHue } from './caves-registry.js';
import { state } from '../state.js';
import { DecorKit, initDecor, updateDecor, disposeDecor } from './caves-decor.js';
import { dressRockBase, addOreVeins, addFossils, addFissures, addWetGloss, addGuano, addFloorLitter } from './caves-rock.js';
import { addHeroCrystal, addGeodes, addSelenite, addAmethyst, addSingingCrystal, addChamberChimes, addHeroGeode } from './caves-crystals.js';
import { addBrackets, addStalks, addPuffballs, addProximityMushrooms, addVines, addPalePlants, addPoolRing, addMossCurtains, addFloorMats, addSporeField, addBioVeins, addMossTrail } from './caves-fungi.js';
import { addNests } from './caves-nests.js'; // Phase 2j item 74 — nests/eggs storytelling
import { addFloorTracks } from './caves-gameplay.js'; // Phase 2k item 84 — floor tracks/footprints

// Build-time instrumentation (proves each theme's hooks ran; read by the rig).
export const themeBuildLog = { decorate: {}, lights: {}, byCave: [] };
export function resetThemeBuildLog() { themeBuildLog.decorate = {}; themeBuildLog.lights = {}; themeBuildLog.byCave = []; }
function note(map, theme) { map[theme] = (map[theme] || 0) + 1; }

// Theme-keyed crystal colours (item 59 — colour by theme, not just zone hue).
const CRYSTAL = 0x74e0ff;   // crystal-cave icy cyan
const AMETHYST = 0x9a5cff;  // geode purple
const FUNGAL = 0x7dffb0;    // bioluminescent green
const TEAL = 0x3fe0d0;      // flooded (keep the 2b pool accent)

const cnt = (base, ds) => Math.max(1, Math.round(base * ds));

// Shared decorate wrapper: fetch the cull record, run the base rock pass, then
// the theme-specific dressing, then flush the batched voxel detail into aux.
function decorateWith(theme, apply) {
    return (ctx) => {
        const rec = state.caveRender && state.caveRender[ctx.ci];
        if (!rec) return;
        note(themeBuildLog.decorate, theme);
        const decor = initDecor(ctx.ci, ctx.cave);
        const kit = new DecorKit(rec);
        dressRockBase(kit, ctx.cave, ctx);
        try { apply(kit, rec, ctx, decor); } finally { kit.flush(decor); } // item 171: shimmer registry
    };
}
// A hero-crystal accent light (only where decorate placed a hero).
function heroLights(theme) {
    return (ctx) => {
        note(themeBuildLog.lights, theme);
        const hp = ctx.cave._heroPos;
        if (hp && ctx.addLight) ctx.addLight(hp.color, 3.6, 10, hp.x, hp.y, hp.z, 1.1);
    };
}
const disposeTheme = (cave) => disposeDecor(cave);

/* ---------------------------------------------------------- */
registerCaveTheme('crystal', {
    label: 'Crystal forest',
    glowHue: () => 0x6fe3ff,
    spawnBias: ['crystalGolem', 'jewelScarab', 'starSnail', 'crystalWarden', 'wallCreeper', 'echoWisp'],
    decorate: decorateWith('crystal', (kit, rec, ctx, decor) => {
        addHeroCrystal(rec, ctx.cave, ctx, decor, CRYSTAL);
        addSelenite(rec, ctx.cave, ctx, decor);
        if (!ctx.low) addAmethyst(rec, ctx.cave, ctx, decor, AMETHYST);
        addChamberChimes(ctx.cave, decor, CRYSTAL);
        if (!ctx.low && ctx.rng() < 0.55) addSingingCrystal(rec, ctx.cave, ctx, decor, 0xbfe9ff);
        if (!ctx.low && ctx.rng() < 0.2) addHeroGeode(rec, ctx.cave, ctx, decor, CRYSTAL); // item 158
        addFloorTracks(kit, ctx.cave, ctx);   // item 84
    }),
    lights: heroLights('crystal'),
    update: updateDecor,
    dispose: disposeTheme,
});

registerCaveTheme('geode', {
    label: 'Geode pocket',
    glowHue: () => 0xb98cff,
    spawnBias: ['jewelScarab', 'crystalGolem', 'glowcap', 'crystalWarden', 'wallCreeper', 'lanternMoth'],
    decorate: decorateWith('geode', (kit, rec, ctx, decor) => {
        addGeodes(rec, ctx.cave, ctx, decor, AMETHYST, cnt(4, ctx.profile.densityScale));
        addAmethyst(rec, ctx.cave, ctx, decor, 0xb060ff);
        addHeroCrystal(rec, ctx.cave, ctx, decor, AMETHYST);
        addChamberChimes(ctx.cave, decor, AMETHYST);
        if (!ctx.low && ctx.rng() < 0.3) addHeroGeode(rec, ctx.cave, ctx, decor, 0xb060ff); // item 158
    }),
    lights: heroLights('geode'),
    update: updateDecor,
    dispose: disposeTheme,
});

registerCaveTheme('fungal', {
    label: 'Fungal overgrowth',
    glowHue: () => 0x7dffb0,
    spawnBias: ['glowcap', 'starSnail', 'widowWeaver', 'sporeSwarm', 'shadeGel', 'paleSalamander'],
    decorate: decorateWith('fungal', (kit, rec, ctx, decor) => {
        const ds = ctx.profile.densityScale;
        addBrackets(rec, ctx.cave, ctx, 0xe0a84a);
        const stalkAnchors = addStalks(rec, ctx.cave, ctx, 0x8affd0);
        addPuffballs(rec, ctx.cave, ctx, decor, 0xd7e79a, cnt(4, ds));
        const mushAnchors = addProximityMushrooms(rec, ctx.cave, ctx, decor, FUNGAL, cnt(5, ds));
        addVines(rec, ctx.cave, ctx);
        addPalePlants(rec, ctx.cave, ctx);
        if (!ctx.low) addMossCurtains(rec, ctx.cave, ctx);
        addFloorMats(rec, ctx.cave, ctx, decor, 0x6effa8);
        addNests(kit, ctx.cave, ctx, 0xcfe79a, 'shed'); // spore-sac clutch + shed skin (items 74/164)
        addFloorTracks(kit, ctx.cave, ctx);     // item 84
        // items 150/156: spore drift anchored at the mushroom/stalk clusters
        addSporeField(rec, ctx.cave, ctx, decor, [...(stalkAnchors || []), ...(mushAnchors || [])], 0xcfe79a);
        addBioVeins(kit, ctx.cave, ctx, FUNGAL);        // item 151
        if (mushAnchors && mushAnchors.length) addMossTrail(kit, ctx.cave, ctx, mushAnchors[0], FUNGAL); // item 157
    }),
    update: updateDecor,
    dispose: disposeTheme,
});

registerCaveTheme('flooded', {
    label: 'Flooded pool',
    glowHue: () => TEAL, // keep the 2b teal pool accent (never regress the wet cave)
    spawnBias: ['mistyGhost', 'gloamBat', 'starSnail', 'caveGlowfish', 'paleSalamander', 'lanternMoth'],
    decorate: decorateWith('flooded', (kit, rec, ctx, decor) => {
        addWetGloss(kit, ctx.cave, ctx);
        addPoolRing(rec, ctx.cave, ctx, 0x7fe9c8);
        addFloorMats(rec, ctx.cave, ctx, decor, 0x54e0c8);
        addPalePlants(rec, ctx.cave, ctx);
        addVines(rec, ctx.cave, ctx);
        addNests(kit, ctx.cave, ctx, 0xcfeef0, 'shed'); // pale amphibian eggs + shed skin (items 74/164)
        addFloorLitter(kit, ctx.cave, ctx, 'shells');   // item 172
    }),
    update: updateDecor,
    dispose: disposeTheme,
});

registerCaveTheme('mineral-ore', {
    label: 'Ore veins',
    glowHue: () => 0xffb84d,
    spawnBias: ['crystalGolem', 'jewelScarab', 'slumberTroll', 'wallCreeper', 'echoWisp'],
    decorate: decorateWith('mineral-ore', (kit, rec, ctx, decor) => {
        addOreVeins(kit, ctx.cave, ctx);
        addFossils(kit, ctx.cave, ctx);
        addFissures(kit, ctx.cave, ctx, 0xff6a2a);
        addFloorTracks(kit, ctx.cave, ctx);   // item 84
    }),
    update: updateDecor,
    dispose: disposeTheme,
});

registerCaveTheme('bat', {
    label: 'Bat roost',
    glowHue: (cave) => zoneGlowHue(cave.zoneId),
    spawnBias: ['gloamBat', 'widowWeaver', 'colonyBat', 'echoWisp', 'lanternMoth'],
    decorate: decorateWith('bat', (kit, rec, ctx, decor) => {
        addGuano(kit, ctx.cave, ctx);
        addVines(rec, ctx.cave, ctx);
        addNests(kit, ctx.cave, ctx, 0xe0d0b0, 'feathers'); // pale eggs + feathers (items 74/164)
        addFloorTracks(kit, ctx.cave, ctx);     // item 84 — clear prints on the bat-cave floor
        addFloorLitter(kit, ctx.cave, ctx, 'bones');        // item 172
        if (!ctx.low) addFissures(kit, ctx.cave, ctx, 0x5a4a3a); // faint dim under-glow
    }),
    update: updateDecor,
    dispose: disposeTheme,
});
