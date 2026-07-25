/* Can a walkable mountain actually be laid over every cave, and what does it cost?

   My earlier attempt at a roof layer failed because it tried to FILL the band
   between the natural surface and the vault -- and the vault turned out to stand
   3-4 units ABOVE the natural surface, so the band was empty for 92-97% of
   columns. Raising the surface first inverts that, but only if the arithmetic
   works out. This measures the real numbers per seed:

     - vaultTop  = node.floorY + node.ceilH          (top of the tunnel void)
     - need      = vaultTop + ROOF                   (walkable surface above it)
     - have      = getTerrainHeight at that column   (today's surface)
     - rise      = need - have                       (how much to lift)

   and then estimates the added voxel count, because terrain.js stacks a column
   from max(-2.0, min(4 neighbours) - 0.45) up to the surface: on a SMOOTH ridge
   neighbouring columns rise together, so each only gains a voxel or two. The
   falloff shape, not the peak height, sets the cost.                        */
import { chromium } from 'playwright';
import { SWIFTSHADER_ARGS } from './harness.mjs';

const BASE = process.env.CAPTCHA_BASE_URL || 'http://localhost:8080';
const SEEDS = (process.env.SEEDS || '1,777,4242,20260718').split(',');
const ROOF = Number(process.env.ROOF || 1.6);      // walkable rock above the vault
const WIDTH = Number(process.env.WIDTH || 7);      // lateral falloff beyond hw

const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
const ctx = await b.newContext({ viewport: { width: 640, height: 400 } });
const p = await ctx.newPage();

console.log('RIDGEFIT_BEGIN');
console.log(`roof thickness=${ROOF}  lateral falloff=${WIDTH} beyond hw\n`);
console.log('seed        caves nodes   vaultTop      surface       rise(need-have)      cols   +voxels  %inst');

for (const seed of SEEDS) {
  let ok = false;
  for (let a = 0; a < 4 && !ok; a++) {
    try { await p.goto(`${BASE}/index.html?probe&quality=low&seed=${seed}`, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) {}
    for (let i = 0; i < 70; i++) { if (await p.evaluate(() => !!window.__probe).catch(() => false)) { ok = true; break; } await p.waitForTimeout(1000); }
  }
  if (!ok) { console.log(`${seed}  LOAD FAILED`); continue; }

  const r = await p.evaluate(({ ROOF, WIDTH }) => {
    const P = window.__probe, C = P.CONFIG;
    const { CAVES, getTerrainHeight } = P;
    const V = C.VOXEL_SIZE, half = C.ARENA_SIZE / 2;

    const nodes = [];
    for (const c of CAVES) for (const path of c.paths) for (const n of path) nodes.push(n);

    const vaultTops = [], surfaces = [], rises = [];
    for (const n of nodes) {
      const vt = n.floorY + n.ceilH;
      const have = getTerrainHeight(n.x, n.z);
      vaultTops.push(vt); surfaces.push(have); rises.push(vt + ROOF - have);
    }

    /* Ridge target field: for a column, the highest (vaultTop + ROOF) demanded by
       any node within (hw + WIDTH), smoothly falling to 0 at the outer edge. */
    const ridgeAt = (x, z, h) => {
      let want = h;
      for (const c of CAVES) {
        if (x < c.minX - WIDTH || x > c.maxX + WIDTH || z < c.minZ - WIDTH || z > c.maxZ + WIDTH) continue;
        for (const path of c.paths) {
          for (let i = 0; i < path.length - 1; i++) {
            const a = path[i], bb = path[i + 1];
            const abx = bb.x - a.x, abz = bb.z - a.z;
            const len2 = abx * abx + abz * abz || 1e-6;
            let s = ((x - a.x) * abx + (z - a.z) * abz) / len2;
            if (s < 0) s = 0; else if (s > 1) s = 1;
            const lat = Math.hypot(x - (a.x + abx * s), z - (a.z + abz * s));
            const hw = a.hw + (bb.hw - a.hw) * s;
            const outer = hw + WIDTH;
            if (lat > outer) continue;
            const top = (a.floorY + (bb.floorY - a.floorY) * s) + (a.ceilH + (bb.ceilH - a.ceilH) * s) + ROOF;
            // smootherstep falloff: full crest height over the passage, easing
            // back to the natural surface at hw + WIDTH so it reads as a mound
            const u = Math.max(0, Math.min(1, (lat - hw) / WIDTH));
            const k = 1 - u * u * u * (u * (u * 6 - 15) + 10);
            const target = h + (top - h) * k;
            if (target > want) want = target;
          }
        }
      }
      return want;
    };

    // Walk the real column grid and price the change.
    const n = Math.floor((2 * half) / V);
    let cols = 0, addedVox = 0, maxRise = 0;
    const heights = new Float64Array(n * n);
    const raised = new Float64Array(n * n);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const cx = -half + ix * V + V / 2, cz = -half + iz * V + V / 2;
        const h = getTerrainHeight(cx, cz);
        heights[iz * n + ix] = h;
        const want = ridgeAt(cx, cz, h);
        const nh = want > h ? want : h;
        raised[iz * n + ix] = nh;
        if (nh > h + 1e-6) { cols++; if (nh - h > maxRise) maxRise = nh - h; }
      }
    }
    // voxel delta with the real hidden-face rule, before vs after
    const stack = (arr, ix, iz) => {
      const at = (a, b) => arr[Math.max(0, Math.min(n - 1, b)) * n + Math.max(0, Math.min(n - 1, a))];
      const s = at(ix, iz);
      const fl = Math.max(-2.0, Math.min(s, at(ix, iz - 1), at(ix, iz + 1), at(ix - 1, iz), at(ix + 1, iz)) - 0.45);
      return Math.max(0, Math.floor((s - (fl + V / 2)) / V + 1e-6) + 1);
    };
    for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) addedVox += stack(raised, ix, iz) - stack(heights, ix, iz);

    const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { min: +s[0].toFixed(2), med: +s[s.length >> 1].toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
    return { caves: CAVES.length, nodes: nodes.length, vt: stats(vaultTops), sf: stats(surfaces), ri: stats(rises), cols, addedVox, maxRise: +maxRise.toFixed(2), grid: n };
  }, { ROOF, WIDTH });

  const inst = await p.evaluate(() => window.__probe.perf.instanceTotal().total);
  console.log(
    `${String(seed).padEnd(11)} ${String(r.caves).padStart(4)} ${String(r.nodes).padStart(5)}` +
    `  ${String(r.vt.min + '..' + r.vt.max).padStart(12)}` +
    `  ${String(r.sf.min + '..' + r.sf.max).padStart(12)}` +
    `  ${String(r.ri.min + '..' + r.ri.max).padStart(15)}` +
    `  ${String(r.cols).padStart(6)}  ${String(r.addedVox).padStart(7)}  ${(100 * r.addedVox / inst).toFixed(1)}%`);
}
console.log('\n(rise > 0 means the surface must LIFT to bury the vault; that is the whole feature.');
console.log(' +voxels is priced with terrain.js\'s real hidden-face rule, against a 42000 ceiling.)');
console.log('RIDGEFIT_END');
await b.close();
