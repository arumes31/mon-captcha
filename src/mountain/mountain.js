/* ============================================================
   Mountain Features — waterfall, spring basin & magma vent
   ------------------------------------------------------------
   The mountain's SHAPE lives in heightfield.js; this module owns
   its dressing:
     - the waterfall ribbon draped down the rock face (scrolling
       procedural streak texture), spray bursts + ripples at the
       plunge pool, and the looping rush sound whose volume falls
       off with the player's distance
     - the elevated spring-basin pool surface
     - the magma vent: emissive lava disk (bloom catches it),
       lazily rising ember motes (own additive Points loop) and a
       gentle no-walk push-back so the player never stands in it
   Ember/spray extras are skipped on the 'low' quality tier.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { mulberry32 } from '../random.js';
import { getTerrainHeight, getGroundY, getBasinLevel, getVentFloor, WATERFALL, BASIN, VENT, BORDER_FALL, MOUNTAINS } from '../heightfield.js';
import { spawnParticleBurst, spawnWaterRipple } from '../particles.js';
import { startWaterfallLoop, setWaterfallVolume } from '../audio.js';
import { weatherState } from '../weather/weather.js';
import { SUN_DIRECTION } from '../engine.js';

/* ------------------------------------------------------------
   Build — called from buildTerrain (step 5.5)
   ------------------------------------------------------------ */
export function buildMountainFeatures() {
    buildBasinPool();
    buildWaterfall();
    buildBorderWaterfall();
    buildMagmaVent();
    buildWaterfallMist();     // items 60 & 126: persistent mist at both plunge pools + the cascade source
    buildIcicles();           // item 122: ice formations near the mountain-cascade lip in cold weather
    buildCascadeRainbow();    // items 66 & 75: sunlit spray rainbow near the mountain cascade
    buildRockfallDebris();    // item 116: occasional tumbling scree on steep mountain flanks
    buildPeakCloudCollars();  // item 117: a thin cloud band wrapping each peak at a fixed altitude
    buildSnowStreamers();     // item 119: wind-blown snow streamers off the ridge
    startWaterfallLoop(); // silent until the player nears the falls
    state.sprayAcc = 0;
    state.borderSprayAcc = 0;
}

/* ------------------------------------------------------------
   Items 60 & 126 — persistent light mist at the cascade's source
   lip (visible from a distance, item 126) and at BOTH plunge pools
   (item 60), distinct from the per-splash particle bursts below.
   ------------------------------------------------------------ */
function buildWaterfallMist() {
    const seedR = mulberry32(CONFIG.WORLD_SEED ^ 0x9a1e50);
    const clusters = [
        { x: WATERFALL.lipX, z: WATERFALL.lipZ, y: getBasinLevel() + 0.35, spread: 1.0, n: 8 },
        { x: WATERFALL.poolX, z: WATERFALL.poolZ, y: CONFIG.POND_WATER_LEVEL + 0.2, spread: 1.6, n: 14 },
        { x: BORDER_FALL.poolX, z: BORDER_FALL.poolZ, y: CONFIG.POND_WATER_LEVEL + 0.25, spread: BORDER_FALL.width * 0.9, n: 22 },
    ];
    const N = clusters.reduce((a, c) => a + c.n, 0);
    const pos = new Float32Array(N * 3);
    const puffs = [];
    let idx = 0;
    for (const c of clusters) {
        for (let i = 0; i < c.n; i++, idx++) {
            puffs.push({
                cx: c.x, cz: c.z, baseY: c.y,
                ox: (seedR() * 2 - 1) * c.spread, oz: (seedR() * 2 - 1) * c.spread,
                speed: 0.10 + seedR() * 0.12, phase: seedR(), sway: 0.4 + seedR() * 0.6,
            });
            pos[idx * 3 + 1] = -1000;
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
        color: 0xeef6fb, size: 1.3, transparent: true, opacity: 0.2,
        map: makeMistSprite(), blending: THREE.NormalBlending, depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    state.scene.add(pts);
    state.waterfallMist = pts;
    state.waterfallMistData = puffs;
    state.waterfallMistTex = mat.map;
}

// item 122 — small hanging icicle cones near the mountain-cascade lip,
// faded in/out by how "snowfall" the current blended weather reads.
function buildIcicles() {
    const seedR = mulberry32(CONFIG.WORLD_SEED ^ 0x1c3e55);
    const n = 6;
    const geo = new THREE.ConeGeometry(0.09, 0.5, 6);
    const mat = new THREE.MeshStandardMaterial({
        color: 0xdcf1fb, roughness: 0.2, metalness: 0.05, transparent: true, opacity: 0,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.castShadow = false; mesh.receiveShadow = false;
    const dummy = new THREE.Object3D();
    const top = { x: WATERFALL.lipX, z: WATERFALL.lipZ, y: getBasinLevel() + 0.05 };
    for (let i = 0; i < n; i++) {
        const jitter = (seedR() - 0.5) * 0.6;
        dummy.position.set(top.x + jitter, top.y - 0.25 - seedR() * 0.25, top.z + (seedR() - 0.5) * 0.4);
        dummy.rotation.set(Math.PI, 0, seedR() * 0.3 - 0.15); // apex down
        const s = 0.6 + seedR() * 0.9;
        dummy.scale.set(s, s * (0.7 + seedR() * 0.6), s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    state.scene.add(mesh);
    state.icicleMesh = mesh;
}

// items 66 & 75 — a soft sunlit rainbow sprite hanging in the mountain
// cascade's spray, opposite the sun (a real rainbow's anti-solar point),
// faded in only while the sun is strong and the camera looks away from it.
function buildCascadeRainbow() {
    const away = SUN_DIRECTION.clone().negate();
    away.y = 0;
    if (away.lengthSq() < 1e-6) away.set(1, 0, 0); else away.normalize();
    const baseY = CONFIG.POND_WATER_LEVEL + 3.2;
    const px = WATERFALL.poolX + away.x * 2.4, pz = WATERFALL.poolZ + away.z * 2.4;
    const tex = makeRainbowTexture();
    const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const spr = new THREE.Sprite(mat);
    spr.position.set(px, baseY, pz);
    spr.scale.set(5, 3, 1);
    state.scene.add(spr);
    state.cascadeRainbow = spr;
    state.cascadeRainbowTex = tex;
}

// item 116 — rare tumbling scree/rock debris down a mountain's steep flank.
// Mostly idle: each debris point only "falls" for a short window once every
// several seconds, so it reads as an occasional living-world event, not rain.
function buildRockfallDebris() {
    const seedR = mulberry32(CONFIG.WORLD_SEED ^ 0x2c0b1e);
    const items = [];
    for (const mt of MOUNTAINS) {
        for (let i = 0; i < 3; i++) {
            const ang = seedR() * Math.PI * 2;
            items.push({
                mt, ang,
                rStart: mt.r * (0.25 + seedR() * 0.15),
                rEnd: mt.r * (0.85 + seedR() * 0.1),
                lateral: (seedR() - 0.5) * 0.6,
                period: 9 + seedR() * 8,
                phase: seedR(),
            });
        }
    }
    const N = items.length;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) pos[i * 3 + 1] = -1000;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
        color: 0x8a8072, size: 0.22, transparent: true, opacity: 0.85, depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    state.scene.add(pts);
    state.rockfallPts = pts;
    state.rockfallData = items;
}

// item 117 — a thin band of soft cloud sprites slowly circling each peak at
// a fixed altitude band, reusing the mist sprite technique.
function buildPeakCloudCollars() {
    const seedR = mulberry32(CONFIG.WORLD_SEED ^ 0x5c10ad);
    const per = 7;
    const collars = [];
    for (const mt of MOUNTAINS) {
        const peakY = getTerrainHeight(mt.x, mt.z);
        collars.push({
            mt, y: peakY - mt.peak * 0.22, radius: mt.r * 0.4,
            baseAng: seedR() * Math.PI * 2, spin: 0.03 + seedR() * 0.03, n: per,
        });
    }
    const N = collars.length * per;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) pos[i * 3 + 1] = -1000;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
        color: 0xf3f6fa, size: 3.2, transparent: true, opacity: 0.15,
        map: makeMistSprite(), blending: THREE.NormalBlending, depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    state.scene.add(pts);
    state.peakCloudPts = pts;
    state.peakCloudData = collars;
    state.peakCloudTex = mat.map;
}

// item 119 — wind-blown snow streamers off each ridge, visible only during
// snowfall/windy weather with a live gust (reads state.weatherWind/-Dir,
// both published every frame by weather.js's updateWeather).
function buildSnowStreamers() {
    const seedR = mulberry32(CONFIG.WORLD_SEED ^ 0x77cee2);
    const per = 8;
    const streamers = [];
    for (const mt of MOUNTAINS) {
        const peakY = getTerrainHeight(mt.x, mt.z);
        for (let i = 0; i < per; i++) {
            streamers.push({
                mt, baseY: peakY - mt.peak * 0.15 - seedR() * mt.peak * 0.25,
                ang: seedR() * Math.PI * 2, rad: mt.r * (0.3 + seedR() * 0.5),
                phase: seedR(), speed: 0.4 + seedR() * 0.4,
            });
        }
    }
    const N = streamers.length;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) pos[i * 3 + 1] = -1000;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
        color: 0xf4f8ff, size: 0.28, transparent: true, opacity: 0.7, depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.visible = false;
    state.scene.add(pts);
    state.snowStreamPts = pts;
    state.snowStreamData = streamers;
}

// Soft round sprite shared by the mist/cloud-collar Points groups.
function makeMistSprite() {
    const s = 32;
    const cv = document.createElement('canvas'); cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
}

// Procedural rainbow arc: a hue-banded gradient masked to a thin ring band
// by a radial destination-in pass (no external asset).
function makeRainbowTexture() {
    const w = 128, h = 64;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, w, 0);
    const stops = [
        [0, 'rgba(255,80,80,0)'], [0.15, 'rgba(255,90,90,0.55)'], [0.3, 'rgba(255,190,80,0.5)'],
        [0.45, 'rgba(255,250,120,0.45)'], [0.6, 'rgba(120,230,140,0.45)'], [0.75, 'rgba(110,170,255,0.5)'],
        [0.9, 'rgba(170,120,255,0.5)'], [1, 'rgba(170,120,255,0)'],
    ];
    for (const [t, col] of stops) grad.addColorStop(t, col);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in';
    const rg = g.createRadialGradient(w / 2, h * 1.4, h * 0.6, w / 2, h * 1.4, h * 1.55);
    rg.addColorStop(0, 'rgba(255,255,255,0)');
    rg.addColorStop(0.55, 'rgba(255,255,255,1)');
    rg.addColorStop(0.75, 'rgba(255,255,255,1)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, w, h);
    return new THREE.CanvasTexture(c);
}

/* ------------------------------------------------------------
   Border waterfall — the MAIN river's source: a wide sheet
   pouring in over the perimeter cliff into the plunge pool.
   Taller and broader than the mountain cascade.
   ------------------------------------------------------------ */
function buildBorderWaterfall() {
    const poolY = CONFIG.POND_WATER_LEVEL + 0.06;
    const lipGround = getTerrainHeight(BORDER_FALL.lipX, BORDER_FALL.lipZ);
    const top = { x: BORDER_FALL.lipX, z: BORDER_FALL.lipZ, y: lipGround + 2.6 }; // just over the wall crest
    const bot = { x: BORDER_FALL.poolX, z: BORDER_FALL.poolZ, y: poolY };
    let px = -(bot.z - top.z), pz = bot.x - top.x;
    const pl = Math.hypot(px, pz) || 1;
    px /= pl; pz /= pl;
    const HALF_W = BORDER_FALL.width * 0.92;   // wide sheet

    const SEGS = 14;
    const positions = [], uvs = [], indices = [];
    for (let i = 0; i <= SEGS; i++) {
        const t = i / SEGS;
        const x = THREE.MathUtils.lerp(top.x, bot.x, t);
        const z = THREE.MathUtils.lerp(top.z, bot.z, t);
        const yLine = THREE.MathUtils.lerp(top.y, bot.y, t * t * (3 - 2 * t)); // ease down the cliff
        const y = Math.max(yLine, getTerrainHeight(x, z) + 0.16);
        positions.push(x - px * HALF_W, y, z - pz * HALF_W, x + px * HALF_W, y, z + pz * HALF_W);
        uvs.push(0, t * 3.2, 1, t * 3.2);
        if (i < SEGS) { const a = i * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
        map: makeFallTexture(), color: 0xe4f4fd, transparent: true,
        opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
    });
    const falls = new THREE.Mesh(geo, mat);
    falls.renderOrder = 2;
    state.scene.add(falls);
    state.borderFallMesh = falls;
    state.borderFallTex = mat.map;

    const foamGeo = new THREE.CircleGeometry(BORDER_FALL.width + 0.6, 24);
    const foamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false });
    const foam = new THREE.Mesh(foamGeo, foamMat);
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(bot.x, CONFIG.POND_WATER_LEVEL + 0.05, bot.z);
    foam.renderOrder = 2;
    state.scene.add(foam);
    state.borderFallFoam = foam;
}

// Elevated spring pool inside the basin (simple tinted disc — the big
// reflective Water plane only serves the main 0-level network)
function buildBasinPool() {
    const geo = new THREE.CircleGeometry(BASIN.r + 0.35, 28);
    const mat = new THREE.MeshStandardMaterial({
        color: 0x2d8fa3, roughness: 0.15, metalness: 0.1,
        transparent: true, opacity: 0.82,
        emissive: 0x0c2f38, emissiveIntensity: 0.5,
    });
    const pool = new THREE.Mesh(geo, mat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(BASIN.x, getBasinLevel() + 0.02, BASIN.z);
    state.scene.add(pool);
    state.basinPool = pool;
}

// Vertical streak texture for the falling water (repeat-wrapped so the
// per-frame offset.y scroll reads as falling)
function makeFallTexture() {
    const w = 64, h = 256;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    const r = mulberry32(CONFIG.WORLD_SEED ^ 0xfa11);
    for (let i = 0; i < 46; i++) { // long soft streaks
        const x = r() * w;
        const y0 = r() * h;
        const len = 60 + r() * 160;
        const wid = 1.5 + r() * 3.5;
        const grad = g.createLinearGradient(0, y0, 0, y0 + len);
        const a = 0.25 + r() * 0.5;
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.5, `rgba(240,250,255,${a})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(x, y0, wid, len);
        if (y0 + len > h) g.fillRect(x, y0 - h, wid, len); // wrap seam
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex; // caller tracks the texture for disposal
}

// Ribbon draped from the basin lip down the rock face to the plunge pool
function buildWaterfall() {
    const top = { x: WATERFALL.lipX, z: WATERFALL.lipZ, y: getBasinLevel() + 0.05 };
    const bot = { x: WATERFALL.poolX, z: WATERFALL.poolZ, y: CONFIG.POND_WATER_LEVEL + 0.06 };
    // ribbon side direction: perpendicular to the fall line
    let px = -(bot.z - top.z), pz = bot.x - top.x;
    const pl = Math.hypot(px, pz) || 1;
    px /= pl; pz /= pl;
    const HALF_W = 0.8;

    const SEGS = 10;
    const positions = [];
    const uvs = [];
    const indices = [];
    for (let i = 0; i <= SEGS; i++) {
        const t = i / SEGS;
        const x = THREE.MathUtils.lerp(top.x, bot.x, t);
        const z = THREE.MathUtils.lerp(top.z, bot.z, t);
        // ease-in drop hugging the face, held just proud of the rock
        const yLine = THREE.MathUtils.lerp(top.y, bot.y, t * t * (3 - 2 * t));
        const y = Math.max(yLine, getTerrainHeight(x, z) + 0.14);
        positions.push(x - px * HALF_W, y, z - pz * HALF_W, x + px * HALF_W, y, z + pz * HALF_W);
        uvs.push(0, t * 2.4, 1, t * 2.4);
        if (i < SEGS) {
            const a = i * 2;
            indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
        map: makeFallTexture(),
        color: 0xdff2fb,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const falls = new THREE.Mesh(geo, mat);
    falls.renderOrder = 2;
    state.scene.add(falls);
    state.waterfallMesh = falls;
    state.fallTex = mat.map;

    // static foam pad where the falls hit the pool
    const foamGeo = new THREE.CircleGeometry(1.5, 20);
    const foamMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false,
    });
    const foam = new THREE.Mesh(foamGeo, foamMat);
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(bot.x, CONFIG.POND_WATER_LEVEL + 0.045, bot.z);
    foam.renderOrder = 2;
    state.scene.add(foam);
    state.waterfallFoam = foam;
}

/* ------------------------------------------------------------
   Magma vent — lava disc + closed-form rising ember points
   ------------------------------------------------------------ */
function buildMagmaVent() {
    const floorY = getVentFloor();

    const lavaGeo = new THREE.CircleGeometry(VENT.r, 24);
    const lavaMat = new THREE.MeshStandardMaterial({
        color: 0xff5a1f,
        emissive: 0xff4a12,
        emissiveIntensity: 2.1, // bloom catches the pocket
        roughness: 0.9,
    });
    const lava = new THREE.Mesh(lavaGeo, lavaMat);
    lava.rotation.x = -Math.PI / 2;
    lava.position.set(VENT.x, floorY + 0.12, VENT.z);
    state.scene.add(lava);
    state.lavaMesh = lava;

    // ember motes: fixed pool animated in closed form (phase loops)
    const N = 26;
    const pos = new Float32Array(N * 3);
    const seedR = mulberry32(CONFIG.WORLD_SEED ^ 0xe3be5);
    const embers = [];
    for (let i = 0; i < N; i++) {
        embers.push({
            ox: (seedR() * 2 - 1) * VENT.r * 0.8,
            oz: (seedR() * 2 - 1) * VENT.r * 0.8,
            speed: 0.16 + seedR() * 0.22,      // cycles per second
            phase: seedR(),
            sway: 0.5 + seedR() * 0.8,
        });
        pos[i * 3 + 1] = -1000;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
        color: 0xffa040, size: 0.16, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    state.scene.add(points);
    state.emberPoints = points;
    state.emberData = { embers, baseY: floorY + 0.15 };

    // item 231: a warm bounce point-light at the vent pocket, so nearby rock
    // picks up lava glow beyond the emissive disc itself. Skipped entirely on
    // a confirmed software renderer (matches lava.js's course lights).
    if (!state.softwareRenderer) {
        const light = new THREE.PointLight(0xff5a1f, 1.9, 6.5, 2);
        light.position.set(VENT.x, floorY + 1.1, VENT.z);
        state.scene.add(light);
        state.ventBounceLight = light;
    }
}

/* ------------------------------------------------------------
   Per-frame update — ribbon scroll, spray, embers, lava pulse,
   waterfall volume, magma push-back. Called from the game loop.
   ------------------------------------------------------------ */
const _camDir = new THREE.Vector3();
export function updateMountainFeatures(dt, elapsed) {
    const low = state.qualityLevel === 'low';

    // falling-water scroll + breathing opacity
    if (state.waterfallMesh) {
        state.waterfallMesh.material.map.offset.y -= dt * 1.35;
        state.waterfallMesh.material.opacity = 0.8 + Math.sin(elapsed * 3.1) * 0.06;
    }
    if (state.waterfallFoam) {
        state.waterfallFoam.material.opacity = 0.34 + Math.sin(elapsed * 4.3) * 0.08;
        const s = 1 + Math.sin(elapsed * 2.2) * 0.06;
        state.waterfallFoam.scale.set(s, s, 1);
    }

    // border waterfall sheet scroll + breathing
    if (state.borderFallMesh) {
        state.borderFallMesh.material.map.offset.y -= dt * 1.5;
        state.borderFallMesh.material.opacity = 0.84 + Math.sin(elapsed * 2.7) * 0.07;
    }
    if (state.borderFallFoam) {
        state.borderFallFoam.material.opacity = 0.38 + Math.sin(elapsed * 3.6) * 0.09;
        const s = 1 + Math.sin(elapsed * 1.9) * 0.07;
        state.borderFallFoam.scale.set(s, s, 1);
    }

    // item 76: a post-rain "wetness" accumulator — ramps up while it's raining,
    // decays slowly otherwise — widens the splash radius/rate so heavier flow
    // visibly follows recent weather instead of the falls looking constant.
    const wRain = weatherState();
    const isRaining = wRain.cur === 'rain' || wRain.cur === 'thunderstorm' || wRain.next === 'rain' || wRain.next === 'thunderstorm';
    state.mountainWet = THREE.MathUtils.clamp((state.mountainWet || 0) + (isRaining ? dt * 0.15 : -dt * 0.04), 0, 1);
    const wetMul = 1 + state.mountainWet * 0.6;

    // spray bursts + ripples at both plunge pools (skipped on 'low')
    if (!low && !state.isPaused) {
        state.sprayAcc = (state.sprayAcc || 0) + dt;
        if (state.sprayAcc > 0.16 / wetMul) {
            state.sprayAcc = 0;
            const jx = (Math.random() - 0.5) * 1.4 * wetMul, jz = (Math.random() - 0.5) * 1.4 * wetMul;
            spawnParticleBurst(WATERFALL.poolX + jx, CONFIG.POND_WATER_LEVEL + 0.12, WATERFALL.poolZ + jz, 0xeaf6ff, 2);
            if (Math.random() < 0.3) spawnWaterRipple(WATERFALL.poolX + jx, WATERFALL.poolZ + jz);
        }
        state.borderSprayAcc = (state.borderSprayAcc || 0) + dt;
        if (state.borderSprayAcc > 0.1 / wetMul) { // heavier spray at the big border falls
            state.borderSprayAcc = 0;
            const jx = (Math.random() - 0.5) * BORDER_FALL.width * 1.5 * wetMul;
            const jz = (Math.random() - 0.5) * BORDER_FALL.width * 1.5 * wetMul;
            spawnParticleBurst(BORDER_FALL.poolX + jx, CONFIG.POND_WATER_LEVEL + 0.14, BORDER_FALL.poolZ + jz, 0xeaf6ff, 3);
            if (Math.random() < 0.35) spawnWaterRipple(BORDER_FALL.poolX + jx, BORDER_FALL.poolZ + jz);
        }
    }

    // lava glow pulse
    if (state.lavaMesh) {
        state.lavaMesh.material.emissiveIntensity = 1.9 + Math.sin(elapsed * 1.7) * 0.5;
    }

    // rising embers (closed-form loop; hidden on 'low')
    if (state.emberPoints && state.emberData) {
        state.emberPoints.visible = !low;
        if (!low) {
            const arr = state.emberPoints.geometry.attributes.position.array;
            const { embers, baseY } = state.emberData;
            for (let i = 0; i < embers.length; i++) {
                const e = embers[i];
                const t = (elapsed * e.speed + e.phase) % 1;
                arr[i * 3] = VENT.x + e.ox + Math.sin(elapsed * 0.9 + e.phase * 17) * e.sway * t;
                arr[i * 3 + 1] = baseY + t * 2.6;
                arr[i * 3 + 2] = VENT.z + e.oz + Math.cos(elapsed * 0.8 + e.phase * 23) * e.sway * t;
            }
            state.emberPoints.geometry.attributes.position.needsUpdate = true;
            state.emberPoints.material.opacity = 0.55 + Math.sin(elapsed * 3.7) * 0.25;
        }
    }

    // item 231: vent bounce light stays live-gated to the CURRENT tier so an
    // FPS-driven step-down to 'low' also turns it off, not just the build-time
    // softwareRenderer check.
    if (state.ventBounceLight) state.ventBounceLight.visible = state.qualityLevel !== 'low';

    // items 60 & 126: persistent waterfall mist (hidden on 'low')
    if (state.waterfallMist && state.waterfallMistData) {
        state.waterfallMist.visible = !low;
        if (!low) {
            const arr = state.waterfallMist.geometry.attributes.position.array;
            const puffs = state.waterfallMistData;
            for (let i = 0; i < puffs.length; i++) {
                const e = puffs[i];
                const t = (elapsed * e.speed + e.phase) % 1;
                arr[i * 3] = e.cx + e.ox + Math.sin(elapsed * 0.7 + e.phase * 14) * e.sway * (0.5 + t);
                arr[i * 3 + 1] = e.baseY + t * 1.8;
                arr[i * 3 + 2] = e.cz + e.oz + Math.cos(elapsed * 0.6 + e.phase * 10) * e.sway * (0.5 + t);
            }
            state.waterfallMist.geometry.attributes.position.needsUpdate = true;
            state.waterfallMist.material.opacity = 0.16 + Math.sin(elapsed * 1.1) * 0.05;
        }
    }

    // item 122: icicles fade with how "snowfall" the blended weather reads
    if (state.icicleMesh) {
        const ws = weatherState();
        const cold = (ws.cur === 'snowfall' ? 1 - ws.t : 0) + (ws.next === 'snowfall' ? ws.t : 0);
        state.icicleMesh.material.opacity = Math.min(0.95, cold * 1.3);
        state.icicleMesh.visible = state.icicleMesh.material.opacity > 0.02;
    }

    // items 66 & 75: cascade rainbow — fades in only when the sun is strong
    // AND the camera looks roughly away from it (a rainbow's anti-solar point)
    if (state.cascadeRainbow) {
        let want = 0;
        if (!low && state.camera && state.sun && state.sun.intensity > 1.0) {
            state.camera.getWorldDirection(_camDir);
            if (_camDir.dot(SUN_DIRECTION) < -0.2) want = 0.5;
        }
        const m = state.cascadeRainbow.material;
        m.opacity += (want - m.opacity) * Math.min(1, dt * 1.5);
    }

    // item 116: rockfall debris — mostly idle, "falls" only in a short window
    // once every several seconds per debris point
    if (state.rockfallPts && state.rockfallData) {
        state.rockfallPts.visible = !low;
        if (!low) {
            const arr = state.rockfallPts.geometry.attributes.position.array;
            const items = state.rockfallData;
            const fallFrac = 0.22;
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                const cyc = ((elapsed / it.period) + it.phase) % 1;
                if (cyc > fallFrac) { arr[i * 3 + 1] = -1000; continue; }
                const u = cyc / fallFrac;
                const r = it.rStart + (it.rEnd - it.rStart) * u;
                const x = it.mt.x + Math.cos(it.ang) * r + Math.sin(it.ang) * it.lateral;
                const z = it.mt.z + Math.sin(it.ang) * r - Math.cos(it.ang) * it.lateral;
                const y = getTerrainHeight(x, z) + 0.15 + (1 - u) * 0.4;
                arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z;
            }
            state.rockfallPts.geometry.attributes.position.needsUpdate = true;
        }
    }

    // item 117: peak cloud collars — a slow ring rotation around each summit
    if (state.peakCloudPts && state.peakCloudData) {
        state.peakCloudPts.visible = !low;
        if (!low) {
            const arr = state.peakCloudPts.geometry.attributes.position.array;
            let idx = 0;
            for (const c of state.peakCloudData) {
                for (let i = 0; i < c.n; i++, idx++) {
                    const ang = c.baseAng + i * (Math.PI * 2 / c.n) + elapsed * c.spin;
                    arr[idx * 3] = c.mt.x + Math.cos(ang) * c.radius;
                    arr[idx * 3 + 1] = c.y + Math.sin(elapsed * 0.3 + i) * 0.3;
                    arr[idx * 3 + 2] = c.mt.z + Math.sin(ang) * c.radius;
                }
            }
            state.peakCloudPts.geometry.attributes.position.needsUpdate = true;
        }
    }

    // item 119: wind-blown snow streamers — only while snowfall/windy AND a
    // live gust is actually blowing (state.weatherWind/-Dir, set by weather.js)
    if (state.snowStreamPts && state.snowStreamData) {
        const ws2 = weatherState();
        const stormy = ws2.cur === 'snowfall' || ws2.next === 'snowfall' || ws2.cur === 'windy' || ws2.next === 'windy';
        const active = stormy && (state.weatherWind || 0) > 0.25;
        state.snowStreamPts.visible = !low && active;
        if (!low && active) {
            const arr = state.snowStreamPts.geometry.attributes.position.array;
            const wd = state.weatherWindDir || { x: 1, z: 0 };
            const wlen = state.weatherWind || 0.3;
            const streamers = state.snowStreamData;
            for (let i = 0; i < streamers.length; i++) {
                const s = streamers[i];
                const t = (elapsed * s.speed + s.phase) % 1;
                const bx = s.mt.x + Math.cos(s.ang) * s.rad;
                const bz = s.mt.z + Math.sin(s.ang) * s.rad;
                arr[i * 3] = bx + wd.x * wlen * 4 * t;
                arr[i * 3 + 1] = s.baseY + Math.sin(t * Math.PI) * 0.6;
                arr[i * 3 + 2] = bz + wd.z * wlen * 4 * t;
            }
            state.snowStreamPts.geometry.attributes.position.needsUpdate = true;
        }
    }

    // player interactions: waterfall loudness + magma push-back
    if (state.controls) {
        const p = state.controls.getObject().position;
        const dFall = Math.hypot(p.x - WATERFALL.poolX, p.z - WATERFALL.poolZ);
        const dBorder = Math.hypot(p.x - BORDER_FALL.poolX, p.z - BORDER_FALL.poolZ);
        const k = THREE.MathUtils.clamp(1 - dFall / 30, 0, 1);
        const kb = THREE.MathUtils.clamp(1 - dBorder / 34, 0, 1);
        setWaterfallVolume(Math.max(0.3 * k * k, 0.4 * kb * kb)); // louder near the big falls

        // scenic hazard: standing in the vent just nudges you back out
        const dvx = p.x - VENT.x, dvz = p.z - VENT.z;
        const dv = Math.hypot(dvx, dvz);
        if (dv < VENT.r + 0.7 && state.player.velocity) {
            const push = (VENT.r + 0.7 - dv) * 26 * dt;
            const inv = 1 / (dv || 0.001);
            state.player.velocity.x += dvx * inv * push * 10;
            state.player.velocity.z += dvz * inv * push * 10;
        }
    }
}

/* ------------------------------------------------------------
   Teardown
   ------------------------------------------------------------ */
function disposeMesh(mesh) {
    if (!mesh) return;
    if (state.scene) state.scene.remove(mesh);
    if (mesh.geometry) { try { mesh.geometry.dispose(); } catch (e) {} }
    if (mesh.material) { try { mesh.material.dispose(); } catch (e) {} }
}

export function disposeMountainFeatures() {
    disposeMesh(state.basinPool); state.basinPool = null;
    disposeMesh(state.waterfallMesh); state.waterfallMesh = null;
    disposeMesh(state.waterfallFoam); state.waterfallFoam = null;
    disposeMesh(state.borderFallMesh); state.borderFallMesh = null;
    disposeMesh(state.borderFallFoam); state.borderFallFoam = null;
    disposeMesh(state.lavaMesh); state.lavaMesh = null;
    disposeMesh(state.emberPoints); state.emberPoints = null;
    state.emberData = null;
    if (state.ventBounceLight) { if (state.scene) state.scene.remove(state.ventBounceLight); state.ventBounceLight = null; }
    disposeMesh(state.waterfallMist); state.waterfallMist = null;
    state.waterfallMistData = null;
    if (state.waterfallMistTex) { try { state.waterfallMistTex.dispose(); } catch (e) {} state.waterfallMistTex = null; }
    disposeMesh(state.icicleMesh); state.icicleMesh = null;
    disposeMesh(state.cascadeRainbow); state.cascadeRainbow = null;
    if (state.cascadeRainbowTex) { try { state.cascadeRainbowTex.dispose(); } catch (e) {} state.cascadeRainbowTex = null; }
    disposeMesh(state.rockfallPts); state.rockfallPts = null;
    state.rockfallData = null;
    disposeMesh(state.peakCloudPts); state.peakCloudPts = null;
    state.peakCloudData = null;
    if (state.peakCloudTex) { try { state.peakCloudTex.dispose(); } catch (e) {} state.peakCloudTex = null; }
    disposeMesh(state.snowStreamPts); state.snowStreamPts = null;
    state.snowStreamData = null;
    if (state.fallTex) { try { state.fallTex.dispose(); } catch (e) {} state.fallTex = null; }
    if (state.borderFallTex) { try { state.borderFallTex.dispose(); } catch (e) {} state.borderFallTex = null; }
    if (state.waterfallSrc) { try { state.waterfallSrc.stop(); } catch (e) {} state.waterfallSrc = null; }
    state.waterfallGain = null;
}
