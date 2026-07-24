/* ============================================================
   Cave WATER & fluids (Phase 2i, items 39–48)
   ------------------------------------------------------------
   The `flooded` theme's wet features live here — DATA + FIELD +
   RENDER kept in one module so caves.js / caves-data.js /
   heightfield.js stay lean. Everything visual rides the Phase 2e
   cull layer (rec.aux / rec.lights), so open-world frames pay
   nothing, and the field helpers are pure so heightfield can call
   them with no import cycle (this module never imports heightfield;
   getGroundY is passed in at build time).

   DATA (designFloodedWater, called from caves-data.placeCaves on a
   separate seeded stream so base geometry/theme distribution is
   untouched): the ONE wet cave gains
     - cave.waterKind : 'water' | 'ice' | 'hotspring' (from host zone;
       ice/snow -> frozen ICE, volcanic -> steaming HOT SPRING, else
       a mirror-still WATER pool)
     - cave.pools[]   : several pools at VARIED floor heights (45),
       each { x, z, r, level, floorY, kind } sitting on the local
       cave floor inside the passage
     - cave.pool      : the primary water/hotspring pool (or null for
       an all-ice cave) — kept for the 2b/2g/2h hooks that read it
     - cave.stream    : a thin flowing water strip along a passage
       floor channel (40) — wadeable, gentle
     - cave.waterfall : a ceiling-crack falling sheet feeding the pool
       (41)

   FIELD (pure; heightfield calls these per pooled cave):
     caveWaterIsWater  pools (not ice) + stream count as water — wade,
                       splash, aquatic containment (isWaterAt)
     caveWaterCarveH   carve the pool basins below the water line (ice
                       does NOT carve — it stays a solid walkable slab)
     caveWaterLevelAt  the surface height inside a pool / stream (so
                       the ball splash + wade depth are correct even
                       for a high pool up a mountain flank)
     caveWetEdgeOne    the slippery wet rim of a pool / stream bank (44)

   RENDER (buildCaveWater from caves.buildCaves) + per-frame
   updateCaveWater (drips->ripple rings 39, waterfall scroll + splash,
   rising mist / steam 43/47, hot-spring bubbling) + condensation
   drips intensifying near water (48). Solid ICE (46): a glossy disc
   on the floor, isWaterAt false, getGroundY = the ice surface.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { spawnParticleBurst, spawnWaterRipple } from '../particles.js';
import { pushAux } from './caves-decor.js';

const STREAM_DEPTH = 0.16;                 // shallow, gentle wade depth for streams
const ICE_ZONES = new Set(['ice', 'snow']); // host zones that freeze the pool (46)

function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(x, a, b) { if (a === b) return x < a ? 0 : 1; let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

function zoneKind(zoneId) {
    if (ICE_ZONES.has(zoneId)) return 'ice';
    if (zoneId === 'volcanic') return 'hotspring';
    return 'water';
}

// item 80: host-zone humidity multiplier for condensation droplet density.
const HUMID_ZONE = { jungle: 1.3, swamp: 1.35, mushroom: 1.2, meadow: 1.0, lakeside: 1.15, alpine: 0.85, ice: 0.7, snow: 0.7, desert: 0.5, volcanic: 0.9 };
function humidityFactor(zoneId) { return HUMID_ZONE[zoneId] !== undefined ? HUMID_ZONE[zoneId] : 1.0; }

/* ------------------------------------------------------------
   DATA — enrich the wet cave with its water features.
   ------------------------------------------------------------ */
function nearestNode(cave, x, z) {
    let best = null, bd = Infinity;
    for (const path of cave.paths) for (const n of path) {
        const d = (n.x - x) ** 2 + (n.z - z) ** 2;
        if (d < bd) { bd = d; best = n; }
    }
    return best;
}

function perpAt(path, i) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz) || 1;
    return { nx: -tz / l, nz: tx / l };
}

function addPoolAt(cave, pools, x, z, baseR, kind, rng, primary) {
    const n = nearestNode(cave, x, z);
    const localFloor = n ? n.floorY : 0.25;
    const hw = n ? n.hw : CONFIG.CAVE_MIN_NAV_HW;
    const r = Math.max(0.6, Math.min(baseR, hw - 0.42));
    let level, floorY;
    if (kind === 'ice') { level = localFloor + 0.04; floorY = localFloor; }
    else { level = localFloor - 0.10; floorY = level - (0.34 + rng() * 0.18); }
    pools.push({ x, z, r, level, floorY, kind, primary: !!primary });
    return pools[pools.length - 1];
}

function makeStream(cave, rng) {
    const main = cave.paths[0];
    if (main.length < 6) return null;
    const runLen = 3 + Math.floor(rng() * 3); // 3..5 segments
    const start = 1 + Math.floor(rng() * Math.max(1, main.length - runLen - 2));
    const pts = [];
    for (let i = start; i <= start + runLen && i < main.length; i++) pts.push({ x: main[i].x, z: main[i].z, floorY: main[i].floorY });
    if (pts.length < 3) return null;
    return { pts, hw: 0.42 };
}

function makeWaterfall(cave, pool) {
    const n = nearestNode(cave, pool.x, pool.z);
    const ceilTop = n ? (n.floorY + n.ceilH) : pool.level + 3.2;
    const crackY = Math.min(ceilTop - 0.35, pool.level + 3.4);
    // slide the entry off the pool centre so the sheet reads against the chamber
    const off = pool.r * 0.45;
    return { x: pool.x + off, z: pool.z, crackY, baseY: pool.level };
}

export function designFloodedWater(cave, rng) {
    const kind = zoneKind(cave.zoneId);
    cave.waterKind = kind;
    const pools = [];
    const p0 = cave.pool || (cave.chambers[0] && { x: cave.chambers[0].x, z: cave.chambers[0].z, r: 1.6 });
    if (p0) addPoolAt(cave, pools, p0.x, p0.z, p0.r || 1.6, kind, rng, true);

    // extra pools at OTHER chambers -> varied floor heights (item 45)
    for (const ch of cave.chambers) {
        if (pools.length >= 4) break;
        if (pools.some(p => (p.x - ch.x) ** 2 + (p.z - ch.z) ** 2 < (p.r + 1.4) ** 2)) continue;
        addPoolAt(cave, pools, ch.x, ch.z, 0.8 + rng() * 0.5, kind, rng, false);
    }
    // top up with the lowest passage nodes so there are SEVERAL pools at varied
    // heights, not just one (item 45) — spaced so they never merge or clip walls.
    const target = 3;
    if (pools.length < target) {
        const main = cave.paths[0];
        const cand = main.slice(2, main.length - 2).slice().sort((a, b) => a.floorY - b.floorY);
        for (const n of cand) {
            if (pools.length >= target) break;
            if (pools.some(p => (p.x - n.x) ** 2 + (p.z - n.z) ** 2 < (p.r + 2.0) ** 2)) continue;
            addPoolAt(cave, pools, n.x, n.z, 0.66 + rng() * 0.4, kind, rng, false);
        }
    }

    cave.pools = pools;
    cave.pool = pools.find(p => p.kind !== 'ice') || null; // primary (null for all-ice)
    cave.stream = kind === 'ice' ? null : makeStream(cave, rng);
    cave.waterfall = (kind === 'water' && cave.pool) ? makeWaterfall(cave, cave.pool) : null;
}

/* ------------------------------------------------------------
   FIELD helpers (pure). Called by heightfield per pooled cave.
   ------------------------------------------------------------ */
function streamSample(s, x, z) {
    const pts = s.pts;
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const abx = b.x - a.x, abz = b.z - a.z;
        const len2 = abx * abx + abz * abz || 1e-6;
        let t = ((x - a.x) * abx + (z - a.z) * abz) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const px = a.x + abx * t, pz = a.z + abz * t;
        const lat = Math.hypot(x - px, z - pz);
        if (!best || lat < best.lat) best = { lat, px, pz };
    }
    return best;
}

// pools of kind water/hotspring + the stream read as water; ICE stays dry/solid.
export function caveWaterIsWater(cave, x, z, pad) {
    const pools = cave.pools;
    if (pools) for (let i = 0; i < pools.length; i++) {
        const p = pools[i];
        if (p.kind === 'ice') continue;
        const dx = x - p.x, dz = z - p.z, rr = p.r + pad;
        if (dx * dx + dz * dz < rr * rr) return true;
    }
    const s = cave.stream;
    if (s) { const q = streamSample(s, x, z); if (q && q.lat < s.hw + pad) return true; }
    return false;
}

// Carve pool basins below the water line. ICE never carves (solid slab), so
// getGroundY returns the ice surface and the player walks on it (item 46).
export function caveWaterCarveH(cave, x, z, h) {
    const pools = cave.pools;
    if (!pools) return h;
    for (let i = 0; i < pools.length; i++) {
        const p = pools[i];
        if (p.kind === 'ice') continue;
        const pdr = Math.hypot(x - p.x, z - p.z);
        if (pdr < p.r + 0.6) {
            const t = Math.min(1, pdr / p.r);
            const basin = p.floorY + t * t * 0.55;
            const k = 1 - smoothstep(pdr, p.r - 0.4, p.r + 0.6);
            h = lerp(h, Math.min(h, basin), k);
        }
    }
    return h;
}

// Surface level inside a pool / stream, or null. terrainH is the carved ground
// (passed by heightfield) so a stream's shallow sheet sits just above the floor.
export function caveWaterLevelAt(cave, x, z, terrainH) {
    const pools = cave.pools;
    if (pools) for (let i = 0; i < pools.length; i++) {
        const p = pools[i];
        if (p.kind === 'ice') continue;
        const dx = x - p.x, dz = z - p.z, rr = p.r + 0.3;
        if (dx * dx + dz * dz < rr * rr) return p.level;
    }
    const s = cave.stream;
    if (s) { const q = streamSample(s, x, z); if (q && q.lat < s.hw + 0.2) return terrainH + STREAM_DEPTH; }
    return null;
}

// The wet rim just OUTSIDE a pool / beside the stream — slippery footing (44).
export function caveWetEdgeOne(cave, x, z) {
    const pools = cave.pools;
    if (pools) for (let i = 0; i < pools.length; i++) {
        const p = pools[i];
        if (p.kind === 'ice') continue;
        const d = Math.hypot(x - p.x, z - p.z);
        if (d > p.r - 0.25 && d < p.r + 0.95) return true;
    }
    const s = cave.stream;
    if (s) { const q = streamSample(s, x, z); if (q && q.lat > s.hw && q.lat < s.hw + 0.7) return true; }
    return false;
}

/* ------------------------------------------------------------
   RENDER — textures (disposed via state.caveWaterTex) + builders.
   ------------------------------------------------------------ */
function texList() { return (state.caveWaterTex = state.caveWaterTex || []); }

function mistTex() {
    const s = 32;
    const cv = document.createElement('canvas'); cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    const t = new THREE.CanvasTexture(cv); texList().push(t); return t;
}

function makeFallTex() {
    const w = 32, h = 128;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.clearRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
        const x = Math.random() * w, y0 = Math.random() * h, len = 30 + Math.random() * 80, wid = 1 + Math.random() * 2.5;
        const a = 0.25 + Math.random() * 0.5;
        const grad = g.createLinearGradient(0, y0, 0, y0 + len);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.5, `rgba(235,248,255,${a})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad; g.fillRect(x, y0, wid, len);
        if (y0 + len > h) g.fillRect(x, y0 - h, wid, len);
    }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; texList().push(t); return t;
}

function addCrystalCluster(glow, x, floorY, z, rng) {
    const shards = 3 + Math.floor(rng() * 3);
    for (let s = 0; s < shards; s++) {
        const ox = (rng() - 0.5) * 0.8, oz = (rng() - 0.5) * 0.8, h = 0.5 + rng() * 1.0;
        glow.push({
            x: x + ox, y: floorY + h * 0.5, z: z + oz,
            sx: 0.15 + rng() * 0.12, sy: h / CONFIG.VOXEL_SIZE, sz: 0.15 + rng() * 0.12,
            rx: (rng() - 0.5) * 0.5, ry: rng() * Math.PI, rz: (rng() - 0.5) * 0.5, bright: 0.85 + rng() * 0.15,
        });
    }
}

// item 83: the pool surface mirrors the cave's own crystal/theme glow colour
// (a material tint blend, not an extra light) for mood lighting "for free".
function buildPoolDisc(cave, p, surfY, rec, glow, rng, getGroundY) {
    const water = p.kind === 'water';
    let baseCol = new THREE.Color(water ? 0x0f5a63 : 0x2a7f6e);
    let emisCol = new THREE.Color(water ? 0x0c454e : 0x1a5a3a);
    if (cave._glow) {
        const tint = new THREE.Color(cave._glow);
        baseCol = baseCol.lerp(tint, 0.2);
        emisCol = emisCol.lerp(tint, 0.32);
    }
    const mat = new THREE.MeshStandardMaterial({
        color: baseCol, emissive: emisCol, emissiveIntensity: water ? 0.8 : 1.0,
        roughness: water ? 0.06 : 0.14, metalness: water ? 0.42 : 0.22, transparent: true, opacity: water ? 0.92 : 0.9,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(p.r + 0.15, 30), mat);
    disc.rotation.x = -Math.PI / 2; disc.position.set(p.x, surfY, p.z); disc.receiveShadow = false;
    pushAux(rec, disc);
    p._mat = mat; p._mesh = disc; // _mesh: item 93 drain/fill anim reads this
    if (water) { // mirror-still waterline crystals (culled glow layer)
        const nC = 3 + Math.floor(rng() * 3);
        for (let i = 0; i < nC; i++) {
            const a = rng() * Math.PI * 2, rr = p.r + 0.1 + rng() * 0.4;
            const x = p.x + Math.cos(a) * rr, z = p.z + Math.sin(a) * rr;
            addCrystalCluster(glow, x, getGroundY(x, z), z, rng);
        }
    }
}

function buildIceDisc(cave, p, surfY, rec) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xbfe6f2, emissive: 0x24424f, emissiveIntensity: 0.16, roughness: 0.05, metalness: 0.6, transparent: true, opacity: 0.97 });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(p.r + 0.12, 28), mat);
    disc.rotation.x = -Math.PI / 2; disc.position.set(p.x, surfY, p.z); disc.receiveShadow = true;
    pushAux(rec, disc);
    const ring = new THREE.Mesh(new THREE.RingGeometry(p.r + 0.05, p.r + 0.4, 28),
        new THREE.MeshStandardMaterial({ color: 0xe8f4fb, roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0.5 }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, surfY - 0.01, p.z);
    pushAux(rec, ring);
}

// item 92: base colour stays kind-appropriate (cool-white ice, warm hotspring)
// but the plain WATER case blends toward the cave's own theme accent so a
// crystal-adjacent pool (should one ever exist) reads spectrum-shifted too.
function addPoolLight(p, rec, profile, cave) {
    let col = p.kind === 'ice' ? 0x9fd8ff : p.kind === 'hotspring' ? 0xffb27a : 0x3fe0d0;
    if (p.kind === 'water' && cave && cave._glow) col = new THREE.Color(col).lerp(new THREE.Color(cave._glow), 0.4).getHex();
    const pl = new THREE.PointLight(col, (p.kind === 'ice' ? 3.4 : 4.0) * profile.lightMul, 8, 2);
    pl.position.set(p.x, p.level + 0.8, p.z); pl.castShadow = false;
    state.scene.add(pl);
    rec.lights.push({ light: pl, base: pl.intensity, flick: 1.5 + Math.random() });
}

function buildStreamRibbon(cave, rec, getGroundY) {
    const s = cave.stream, hw = s.hw, pos = [];
    for (let i = 0; i < s.pts.length - 1; i++) {
        const a = s.pts[i], b = s.pts[i + 1];
        let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const nx = -tz, nz = tx;
        const ay = getGroundY(a.x, a.z) + 0.06, by = getGroundY(b.x, b.z) + 0.06;
        const alx = a.x + nx * hw, alz = a.z + nz * hw, arx = a.x - nx * hw, arz = a.z - nz * hw;
        const blx = b.x + nx * hw, blz = b.z + nz * hw, brx = b.x - nx * hw, brz = b.z - nz * hw;
        pos.push(alx, ay, alz, arx, ay, arz, brx, by, brz, alx, ay, alz, brx, by, brz, blx, by, blz);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x1f6a70, emissive: 0x0e4a50, emissiveIntensity: 0.7, roughness: 0.1, metalness: 0.35, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, mat);
    pushAux(rec, mesh);
    cave._water.streamMat = mat;
}

function buildWaterfall(cave, rec) {
    const w = cave.waterfall, tex = makeFallTex();
    const H = Math.max(1.2, w.crackY - w.baseY), width = 0.85, y = (w.crackY + w.baseY) / 2;
    const meshes = [];
    for (let k = 0; k < 2; k++) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(width, H),
            new THREE.MeshBasicMaterial({ map: tex, color: 0xd8f0f8, transparent: true, opacity: 0.82, depthWrite: false, side: THREE.DoubleSide }));
        m.position.set(w.x, y, w.z); m.rotation.y = k * Math.PI / 2; m.renderOrder = 2;
        pushAux(rec, m); meshes.push(m);
    }
    const foam = new THREE.Mesh(new THREE.CircleGeometry(width * 0.9, 18),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false }));
    foam.rotation.x = -Math.PI / 2; foam.position.set(w.x, w.baseY + 0.05, w.z); foam.renderOrder = 2;
    pushAux(rec, foam);
    cave._water.fall = { meshes, x: w.x, z: w.z, baseY: w.baseY };
}

// item 88: denser mist pooling in LOW chambers (a low floorY relative to the
// cave's dry-passage baseline reads as a damp low-lying basin) than a shallow
// pool up near a mouth.
function buildMist(cave, rec, rng) {
    const hot = cave.waterKind === 'hotspring';
    const anchors = cave.pools.filter(p => p.kind !== 'ice');
    if (!anchors.length) return;
    const lowest = Math.min(...anchors.map(a => a.floorY));
    const depthBoost = Math.max(0, 0.35 - lowest) * 0.55; // 0 near a mouth-level pool, up to ~0.4 deep
    const per = hot ? 10 : 6;
    const count = Math.min(72, Math.round(anchors.length * per * (1 + depthBoost)));
    const pos = new Float32Array(count * 3);
    const motes = [];
    for (let i = 0; i < count; i++) {
        const a = anchors[Math.floor(rng() * anchors.length)];
        const ang = rng() * Math.PI * 2, rr = rng() * a.r * 0.8;
        motes.push({
            x: a.x + Math.cos(ang) * rr, z: a.z + Math.sin(ang) * rr,
            base: a.level + 0.04, y: a.level + 0.04, rise: (hot ? 0.5 : 0.28) + rng() * (hot ? 0.4 : 0.2),
            top: a.level + (hot ? 2.6 : 1.5) + rng() * 0.6, ph: rng() * 6.283, amp: 0.1 + rng() * 0.18,
        });
        pos[i * 3 + 1] = -1000;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
        color: hot ? 0xe8efe9 : 0xcfe6ea, size: hot ? 0.5 : 0.38, transparent: true,
        opacity: (hot ? 0.4 : 0.26) + depthBoost, map: mistTex(), depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat); pts.frustumCulled = false;
    pushAux(rec, pts);
    cave._water.mist = { pts, arr: pos, motes };
}

// Condensation drips intensifying near water (48) — pushed to the shared drip
// system so they LOD/cull with the cave; pool:false = no ripple ring.
function buildCondensation(cave, drips, rng, ci) {
    const main = cave.paths[0];
    for (let i = 1; i < main.length - 1; i++) {
        const n = main[i];
        let dw = Infinity;
        for (const p of cave.pools) { if (p.kind === 'ice') continue; dw = Math.min(dw, Math.hypot(n.x - p.x, n.z - p.z) - p.r); }
        if (cave.stream) { const q = streamSample(cave.stream, n.x, n.z); if (q) dw = Math.min(dw, q.lat); }
        const near = Math.max(0, 1 - dw / 6); // 1 at the water, 0 by ~6u away
        if (rng() < (0.12 + near * 0.5) * humidityFactor(cave.zoneId)) {
            const sh = n.ceilH * 0.42, lat = (rng() - 0.5) * n.hw * 0.8, perp = perpAt(main, i);
            const x = n.x + perp.nx * lat, z = n.z + perp.nz * lat;
            drips.push({ ci, x, z, topY: n.floorY + sh + (n.ceilH - sh) * 0.8 - 0.15, floorY: n.floorY + 0.05, phase: rng(), speed: 0.4 + rng() * 0.5, pool: false, lastT: 0 });
        }
    }
}

// Called from caves.buildCaves for the wet cave (replaces the old buildPool).
export function buildCaveWater(cave, glow, drips, profile, rng, ci, rec, getGroundY) {
    cave._water = { pools: [], fall: null, mist: null, streamMat: null, sprayAcc: 0, bubAcc: 0, drainPool: null };
    const low = profile.tier === 'low';
    for (const p of cave.pools) {
        const surfY = p.kind === 'ice' ? getGroundY(p.x, p.z) + 0.04 : p.level + 0.03;
        if (p.kind === 'ice') buildIceDisc(cave, p, surfY, rec);
        else buildPoolDisc(cave, p, surfY, rec, glow, rng, getGroundY);
        // drip -> ripple ring coupling directly over each water/hotspring pool (39)
        if (p.kind !== 'ice' && profile.drips) {
            const nd = p.primary ? 3 : 2;
            for (let i = 0; i < nd; i++) {
                const a = rng() * Math.PI * 2, rr = rng() * p.r * 0.72;
                drips.push({ ci, x: p.x + Math.cos(a) * rr, z: p.z + Math.sin(a) * rr, topY: p.level + 2.6, floorY: p.level + 0.03, phase: rng(), speed: 0.3 + rng() * 0.28, pool: true, lastT: 0 });
            }
        }
        // accent light for ice + non-primary pools (the core lights the primary)
        if (p.kind === 'ice' || !p.primary) addPoolLight(p, rec, profile, cave);
        cave._water.pools.push(p);
    }
    if (cave.stream) buildStreamRibbon(cave, rec, getGroundY);       // underground stream (40)
    if (cave.waterfall) buildWaterfall(cave, rec);                   // ceiling-crack waterfall (41)
    if (!low) buildMist(cave, rec, rng);                            // rising mist / steam (43/47)
    if (!low && profile.drips) buildCondensation(cave, drips, rng, ci); // condensation (48)
    // item 93: a slow drain/fill breathing animation on one non-primary, non-ice
    // pool "near a vent" — purely a visual disc-level wobble (never touches the
    // real carved floor/collision), for subtle life in a multi-pool cave.
    const candidates = cave.pools.filter(p => !p.primary && p.kind !== 'ice' && p._mesh);
    if (candidates.length) {
        const dp = candidates[Math.floor(rng() * candidates.length)];
        dp._drainBaseY = dp._mesh.position.y;
        dp._drainPh = rng() * 6.283;
        cave._water.drainPool = dp;
    }
}

/* ------------------------------------------------------------
   Per-frame — only for observed caves (band !== far). The core
   drip loop already spawns the ripple rings for pool:true drips.
   ------------------------------------------------------------ */
export function updateCaveWater(cave, rec, dt, elapsed, band) {
    const w = cave._water;
    if (!w) return;
    const near = band === 'near';

    if (w.mist) { // rising motes, wrapping at the top
        const { pts, arr, motes } = w.mist;
        for (let i = 0; i < motes.length; i++) {
            const m = motes[i];
            m.y += m.rise * dt; if (m.y > m.top) m.y = m.base;
            arr[i * 3] = m.x + Math.sin(elapsed * 0.5 + m.ph) * m.amp;
            arr[i * 3 + 1] = m.y;
            arr[i * 3 + 2] = m.z + Math.cos(elapsed * 0.4 + m.ph) * m.amp;
        }
        pts.geometry.attributes.position.needsUpdate = true;
    }

    if (w.fall) { // falling-sheet scroll + splash bursts / ripples at the base
        for (const m of w.fall.meshes) m.material.map.offset.y -= dt * 1.4;
        if (near && !state.isPaused) {
            w.sprayAcc += dt;
            if (w.sprayAcc > 0.14) {
                w.sprayAcc = 0;
                const jx = (Math.random() - 0.5) * 0.7, jz = (Math.random() - 0.5) * 0.7;
                spawnParticleBurst(w.fall.x + jx, w.fall.baseY + 0.1, w.fall.z + jz, 0xeaf6ff, 2);
                if (Math.random() < 0.4) spawnWaterRipple(w.fall.x + jx, w.fall.z + jz, w.fall.baseY + 0.02);
            }
        }
    }

    if (cave.waterKind === 'hotspring' && near && !state.isPaused) { // bubbling steam vents (47)
        w.bubAcc += dt;
        if (w.bubAcc > 0.5) {
            w.bubAcc = 0;
            const p = w.pools.find(pp => pp.kind !== 'ice');
            if (p) {
                const a = Math.random() * Math.PI * 2, rr = Math.random() * p.r * 0.7;
                const bx = p.x + Math.cos(a) * rr, bz = p.z + Math.sin(a) * rr;
                spawnParticleBurst(bx, p.level + 0.05, bz, 0xdff0e6, 3);
                if (Math.random() < 0.5) spawnWaterRipple(bx, bz, p.level + 0.02);
            }
        }
    }

    if (w.streamMat) w.streamMat.emissiveIntensity = 0.6 + 0.25 * Math.sin(elapsed * 2.1);
    for (const p of w.pools) if (p._mat) p._mat.emissiveIntensity = (p.kind === 'hotspring' ? 0.9 : 0.75) + 0.12 * Math.sin(elapsed * 1.3 + p.x);

    if (w.drainPool) { // item 93: slow draining/filling breathing on one pool
        const dp = w.drainPool, cyc = 0.5 + 0.5 * Math.sin(elapsed * 0.14 + dp._drainPh);
        dp._mesh.position.y = dp._drainBaseY - (1 - cyc) * 0.1;
        dp._mesh.scale.setScalar(0.88 + cyc * 0.12);
        if (dp._mat) dp._mat.opacity = (dp.kind === 'hotspring' ? 0.9 : 0.92) * (0.75 + cyc * 0.25);
    }
}

/* ------------------------------------------------------------
   Teardown — meshes/lights live in rec.aux/rec.lights (freed by the
   core cave teardown); here we only drop the shared water textures.
   ------------------------------------------------------------ */
export function disposeCaveWater() {
    if (state.caveWaterTex) { for (const t of state.caveWaterTex) { try { t.dispose(); } catch (e) {} } state.caveWaterTex = null; }
}
