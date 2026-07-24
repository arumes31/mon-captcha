/* ============================================================
   Creature Spawning
   ------------------------------------------------------------
   Fills the arena with CREATURE_SPAWN_COUNT creatures (reduced
   on the low tier). The deck is guaranteed win-able: at least 6
   commons (6 points from commons alone), a spread of aquatics
   (pond + river) and true fliers, and EXACTLY 1-2 legendaries
   per world — the weighted filler never rolls legendary, so
   they stay genuinely rare sightings. Fire-flavored types bias
   toward the magma vent; aquatics spawn on the pond or along
   the river; spacing respects body size.
   ============================================================ */

import { CONFIG } from '../config.js';
import { state, reuse } from '../state.js';
import { getTerrainHeight, getGroundY, isWaterAt, riverSpan, riverPointAt, VENT, PARTITION, SPAWN, CAVES, caveAt } from '../heightfield.js';
import { collidesObstacle } from '../player.js';
import { PLAN_META } from './plans.js';
import { CREATURE_TYPES } from './bestiary.js';
import { makeCreature } from './factory.js';
import { ZONES } from '../zones.js';
import { spawnCaveLife } from './cave-spawn.js';

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Cave-flavoured types (bats, cave spiders, crystal/gem kin, drifting spirits,
// glow shrooms) — biased to spawn inside the seeded caves like fire types bias
// to the magma vent. glowfish stays out (caves hold no water).
const CAVE_DWELLERS = new Set([
    'gloamBat', 'widowWeaver', 'starSnail', 'crystalGolem', 'mistyGhost', 'glowcap', 'jewelScarab',
]);

// Random point inside a cave's walkable passage: pick an interior node on the
// main tunnel path, offset laterally within its half-width (clear of the walls)
function pointInCave(c) {
    const path = c.paths[0];
    const i = 1 + Math.floor(Math.random() * (path.length - 2));
    const n = path[i], prev = path[i - 1];
    let tx = n.x - prev.x, tz = n.z - prev.z;
    const l = Math.hypot(tx, tz) || 1;
    const lat = (Math.random() * 2 - 1) * Math.max(0, n.hw - 0.8);
    return { x: n.x + (-tz / l) * lat, z: n.z + (tx / l) * lat };
}

/* ------------------------------------------------------------
   Zone spawn bias. Each zone descriptor names its signature
   creature ids; here that inverts into id -> home sector list.
   Biased types spawn inside a home sector most of the time
   (ice types in ice, golems in the highlands, …); everything
   else — and every miss — falls back to uniform placement.
   ------------------------------------------------------------ */
const HOME_SECTORS = (() => {
    const map = new Map();
    for (let s = 0; s < ZONES.length; s++) {
        for (const id of ZONES[s].creatures) {
            if (!map.has(id)) map.set(id, []);
            map.get(id).push(s);
        }
    }
    return map;
})();

// Random point inside a sector's angular wedge (respecting the arena bounds)
function pointInSector(s, halfArena) {
    const bearing = PARTITION.rot + (s + 0.12 + Math.random() * 0.76) * PARTITION.sectorWidth;
    const rad = CONFIG.POND_RADIUS + 3 + Math.random() * (halfArena - CONFIG.POND_RADIUS - 5);
    const x = Math.cos(bearing) * rad, z = Math.sin(bearing) * rad;
    if (Math.abs(x) > halfArena || Math.abs(z) > halfArena) return null;
    return { x, z };
}

export function spawnCreatures() {
    const halfArena = CONFIG.ARENA_SIZE / 2 - CONFIG.CREATURE_BOUNDARY_MARGIN;
    const target = state.qualityLevel === 'low'
        ? CONFIG.CREATURE_SPAWN_COUNT_LOW
        : CONFIG.CREATURE_SPAWN_COUNT;

    // ---- spawn deck ----
    // guarantees first: commons (win fuel), water dwellers, true fliers,
    // and 1-2 legendaries; then weighted filler WITHOUT legendaries
    // Phase 2j: cave-EXCLUSIVE types (t.cave) are kept OUT of every surface pool
    // — they are placed only inside the caves by spawnCaveLife, so the surface
    // deck (and thus the 6-point win feasibility) is unchanged.
    const commons = CREATURE_TYPES.filter(t => t.tier === 'common' && !t.cave);
    const aquatics = CREATURE_TYPES.filter(t => t.aquatic && t.tier !== 'legendary' && !t.cave);
    const fliers = CREATURE_TYPES.filter(t => t.hover && t.tier !== 'legendary' && !t.cave);
    const legendaries = CREATURE_TYPES.filter(t => t.tier === 'legendary' && !t.cave);
    const deck = [];
    for (let i = 0; i < 8; i++) deck.push(pick(commons));
    for (let i = 0; i < 5; i++) deck.push(pick(aquatics));
    for (let i = 0; i < 4; i++) deck.push(pick(fliers));
    deck.push(pick(legendaries));
    if (Math.random() < 0.5) deck.push(pick(legendaries)); // sometimes a second
    // guarantee cave life: at least one dweller per cave (biased inside below)
    const dwellers = CREATURE_TYPES.filter(t => CAVE_DWELLERS.has(t.id) && !t.aquatic);
    for (let i = 0; i < CAVES.length + 1 && dwellers.length; i++) deck.push(pick(dwellers));

    const weights = { common: 6, uncommon: 3.4, rare: 1.6, legendary: 0 };
    const fillPool = CREATURE_TYPES.filter(t => t.tier !== 'legendary' && !t.cave);
    let totalW = 0;
    for (const t of fillPool) totalW += weights[t.tier] || 1;
    while (deck.length < target) {
        let roll = Math.random() * totalW;
        for (const t of fillPool) {
            roll -= weights[t.tier] || 1;
            if (roll <= 0) { deck.push(t); break; }
        }
    }

    const span = riverSpan();
    let spawned = 0, attempts = 0;
    while (spawned < deck.length && attempts < CONFIG.CREATURE_SPAWN_ATTEMPTS) {
        attempts++;
        const def = deck[spawned];
        let x, z;
        if (def.aquatic) {
            if (Math.random() < 0.55) {
                // pond surface
                const a = Math.random() * Math.PI * 2;
                const rad = Math.random() * (CONFIG.POND_RADIUS - 1.8);
                x = Math.cos(a) * rad;
                z = Math.sin(a) * rad;
            } else {
                // somewhere along the river channel
                const u = span.uMin + 2 + Math.random() * (span.uMax - span.uMin - 3);
                const pt = riverPointAt(u, (Math.random() * 2 - 1) * 0.9);
                x = pt.x; z = pt.z;
            }
            if (!isWaterAt(x, z, -0.6)) continue; // must be open water
        } else if (def.fire && Math.random() < 0.6) {
            // fire-flavored types haunt the magma vent's scorched flank
            const a = Math.random() * Math.PI * 2;
            const rad = 2.4 + Math.random() * 3.6;
            x = VENT.x + Math.cos(a) * rad;
            z = VENT.z + Math.sin(a) * rad;
            if (Math.abs(x) > halfArena || Math.abs(z) > halfArena) continue;
            if (!def.hover && (isWaterAt(x, z, 1.0) || collidesObstacle(x, z))) continue;
        } else {
            let pt = null;
            if (def.tier === 'common' && !def.aquatic && spawned < 4 && Math.random() < 0.75) {
                // win fuel: the first few commons stay within an easy walk of the
                // (seeded) spawn pad, so 6 points never means crossing the valley
                const a = Math.random() * Math.PI * 2;
                const rad = 5 + Math.random() * 13;
                const nx = SPAWN.x + Math.cos(a) * rad, nz = SPAWN.z + Math.sin(a) * rad;
                if (Math.abs(nx) <= halfArena && Math.abs(nz) <= halfArena) pt = { x: nx, z: nz };
            } else if (CAVES.length && CAVE_DWELLERS.has(def.id) && Math.random() < 0.82) {
                // cave bias: dwellers head into a seeded cave interior
                pt = pointInCave(CAVES[Math.floor(Math.random() * CAVES.length)]);
            } else {
                // zone bias: signature types head home ~3 tries out of 4
                const homes = HOME_SECTORS.get(def.id);
                if (homes && Math.random() < 0.75) {
                    pt = pointInSector(homes[Math.floor(Math.random() * homes.length)], halfArena);
                }
            }
            if (pt) { x = pt.x; z = pt.z; }
            else {
                x = (Math.random() * 2 - 1) * halfArena;
                z = (Math.random() * 2 - 1) * halfArena;
            }
            if (!def.hover) {
                if (isWaterAt(x, z, 1.2)) continue; // never spawn wading
                if (collidesObstacle(x, z)) continue;
                if (getTerrainHeight(x, z) > 6.5) continue; // not on the snow cap
            }
        }
        // planar spacing scaled by body size so megafauna get elbow room
        let tooClose = false;
        for (const other of state.creatures) {
            const need = CONFIG.CREATURE_MIN_SPACING + (def.scale + other.def.scale) * 0.35;
            reuse.tmpVec3.set(x, other.pos.y, z);
            if (other.pos.distanceToSquared(reuse.tmpVec3) < need * need) { tooClose = true; break; }
        }
        if (tooClose) continue;

        let y;
        if (def.aquatic) y = CONFIG.POND_WATER_LEVEL;
        else if (def.hover) y = Math.max(getGroundY(x, z), CONFIG.POND_WATER_LEVEL) + def.hover;
        else y = getGroundY(x, z); // rendered voxel-surface for land creatures
        makeRecord(def, x, y, z);
        spawned++;
    }

    // safety valve: if placement starved out (crowded seeds), drop the
    // remaining deck — but commons were pushed first, so points stay easy
    if (spawned < deck.length) {
        console.warn(`[captcha] spawned ${spawned}/${deck.length} creatures`);
    }

    // Phase 2j: place the cave-EXCLUSIVE life inside the caves (bat colonies,
    // the cathedral legendary, glowfish shoals, wardens, sleepers, swarms,
    // skitterers, echo-locators…). Bonus content — runs AFTER the win-fuel deck.
    spawnCaveLife(halfArena);
}

/* ------------------------------------------------------------
   Build + register one creature record from a type def at (x,y,z).
   Shared by the surface deck and cave-spawn.js so the record shape
   (and every behavior/capture scratch field) stays in one place.
   `extra` is merged in for per-type state (cave homes, pool refs…).
   ------------------------------------------------------------ */
export function makeRecord(def, x, y, z, extra) {
    const built = makeCreature(def);
    const meta = PLAN_META[def.plan];
    built.group.position.set(x, y, z);
    const record = {
        group: built.group,
        parts: built.parts,
        materials: built.materials,
        def, meta,
        type: def.id,
        pos: built.group.position,
        heading: Math.random() * Math.PI * 2,
        phase: Math.random() * Math.PI * 2,
        home: { x, z },                         // anchor for orbit/waypoint patterns
        // tiny types stay honestly hard — but never sub-pixel — to hit
        hitRadius: Math.max(meta.hitR * def.scale, 0.16),
        centerY: meta.centerY * def.scale,      // per-type body center offset
        inCave: !def.aquatic && !!caveAt(x, z), // cave-passage confinement state
        alive: true,
        capturing: false,
        breakoutUntil: 0,                       // post-breakout adrenaline window
        gaitOn: true, gaitT: 0.3 + Math.random(),
        restT: 0, wayActive: false, wayX: 0, wayZ: 0,
        hideK: 0, taunting: false, lookFrozen: false,
        scaredUntil: 0,
        blinkT: 0, blinkJumped: false, blinkCd: 0, nextSpecial: 2 + Math.random() * 4,
        nextBlink: 1 + Math.random() * 4, blinkUntil: 0,
        pulseK: 0,
        // aquatic patrol & koi leaps
        swimDir: Math.random() < 0.5 ? 1 : -1, leapT: 0, leapK: 0,
        // aerial altitude patterns
        altK: 1, dartAlt: 1, lastGaitOn: true,
        // intelligence layer scratch (smart.js)
        dodgePendingAt: 0, dodgeDir: 0, dodgeUntil: 0, dodgeCdUntil: 0,
        coverNextT: 0, coverHeading: null, alarmCdUntil: 0,
        // legendary presence
        stingReady: true, stingCdUntil: 0,
    };
    if (extra) Object.assign(record, extra);
    state.creatures.push(record);
    // tag every part so the targeting raycast can name what it hit
    for (const part of built.parts) part.userData.creature = record;
    return record;
}
