/* How much GPU memory does the render chain ask for at a real display size?

   SwiftShader cannot reproduce VRAM exhaustion, but the allocation is fully
   determined by the live object graph: every WebGLRenderTarget carries its own
   width/height/format/type, so the byte cost is computable exactly. This walks
   the real composer (ping-pong pair + every pass's internal targets, including
   UnrealBloomPass's mip chain and OutlinePass's mask/edge/blur buffers), the
   shadow map, and every scene texture, and reports the total at a range of
   canvas sizes x device pixel ratios.

   renderer.setPixelRatio caps dpr at 2 (engine.js), and the composer's targets
   are sized width * pixelRatio -- so a 1080p window on a HiDPI screen renders
   the whole post chain at 3840x2160.                                        */
import { chromium } from 'playwright';
import { SWIFTSHADER_ARGS } from './harness.mjs';

const BASE = process.env.CAPTCHA_BASE_URL || 'http://localhost:8348';

const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
const ctx = await b.newContext({ viewport: { width: Number(process.env.VW||960), height: Number(process.env.VH||600) }, deviceScaleFactor: Number(process.env.DSF||1) });
const p = await ctx.newPage();
let ready = false;
for (let a = 0; a < 4 && !ready; a++) {
  try { await p.goto(`${BASE}/index.html?probe&quality=high&seed=4242`, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) {}
  for (let i = 0; i < 70; i++) {
    if (await p.evaluate(() => !!window.__probe).catch(() => false)) { ready = true; break; }
    await p.waitForTimeout(1000);
  }
}
if (!ready) { console.log('LOAD FAILED'); await b.close(); process.exit(2); }

const out = await p.evaluate(() => {
  const s = window.__probe.state;
  const comp = s.composer;
  if (!comp) return { err: 'no composer' };

  // bytes per texel for the formats three actually uses here
  const CH = { 1023: 4, 1022: 3, 1028: 1, 1026: 1, 1027: 2 }; // RGBA, RGB, Alpha, Depth, DepthStencil
  const BY = { 1009: 1, 1010: 1, 1015: 4, 1016: 2, 1012: 2, 1014: 4, 1020: 4, 1030: 4 }; // Ubyte/Float/HalfFloat/...
  function rtBytes(rt) {
    if (!rt || !rt.texture) return 0;
    const w = rt.width | 0, h = rt.height | 0;
    const t = rt.texture;
    const ch = CH[t.format] != null ? CH[t.format] : 4;
    const by = BY[t.type] != null ? BY[t.type] : 1;
    let n = w * h * ch * by;
    if (t.generateMipmaps) n = Math.round(n * 1.334);
    if (rt.depthBuffer) n += w * h * (rt.stencilBuffer ? 4 : 3);
    return n;
  }

  // collect every WebGLRenderTarget reachable from the composer
  const seen = new Set();
  const items = [];
  function scan(obj, label, depth) {
    if (!obj || depth > 3 || typeof obj !== 'object') return;
    if (obj.isWebGLRenderTarget) {
      if (seen.has(obj)) return;
      seen.add(obj);
      items.push({ label, w: obj.width, h: obj.height, bytes: rtBytes(obj) });
      return;
    }
    if (Array.isArray(obj)) { obj.forEach((v, i) => scan(v, `${label}[${i}]`, depth + 1)); return; }
    for (const k of Object.keys(obj)) {
      if (!/RenderTarget|renderTarget|Buffer|buffer|Target/i.test(k)) continue;
      try { scan(obj[k], `${label}.${k}`, depth + 1); } catch (e) {}
    }
  }
  scan(comp.renderTarget1, 'composer.renderTarget1', 0);
  scan(comp.renderTarget2, 'composer.renderTarget2', 0);
  comp.passes.forEach((pass, i) => scan(pass, `${pass.constructor.name}#${i}`, 0));

  // shadow maps
  const shadows = [];
  s.scene.traverse((o) => {
    if (o.isLight && o.shadow && o.castShadow) {
      const m = o.shadow.mapSize;
      const faces = o.isPointLight ? 6 : 1;
      shadows.push({ label: `${o.type}.shadow`, w: m.x, h: m.y, bytes: m.x * m.y * 4 * faces });
    }
  });

  // scene textures (uploaded once, but they are VRAM too)
  const texSeen = new Set();
  let sceneTexBytes = 0, sceneTexCount = 0;
  s.scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      for (const k of Object.keys(m)) {
        const t = m[k];
        if (!t || !t.isTexture || texSeen.has(t)) continue;
        texSeen.add(t);
        const img = t.image;
        if (!img || !img.width) continue;
        let n = img.width * img.height * 4;
        if (t.generateMipmaps) n = Math.round(n * 1.334);
        sceneTexBytes += n; sceneTexCount++;
      }
    }
  });

  return {
    canvasW: s.renderer.domElement.width, canvasH: s.renderer.domElement.height,
    cssW: s.renderer.domElement.clientWidth, cssH: s.renderer.domElement.clientHeight,
    pixelRatio: s.renderer.getPixelRatio(), composerPR: comp._pixelRatio,
    tier: s.qualityLevel,
    passes: comp.passes.map((x) => x.constructor.name),
    items, shadows, sceneTexBytes, sceneTexCount,
  };
});

if (out.err) { console.log(out.err); await b.close(); process.exit(2); }

const MB = (n) => (n / 1048576).toFixed(1);
console.log('VRAM_BEGIN');
console.log(`tier=${out.tier}  canvas=${out.canvasW}x${out.canvasH} (css ${out.cssW}x${out.cssH})  rendererPR=${out.pixelRatio}  composerPR=${out.composerPR}`);
console.log(`passes: ${out.passes.join(' -> ')}\n`);

console.log('render targets at THIS canvas size:');
let postBytes = 0;
for (const it of out.items.sort((a, z) => z.bytes - a.bytes)) {
  postBytes += it.bytes;
  console.log(`  ${it.label.padEnd(46)} ${String(it.w).padStart(5)}x${String(it.h).padEnd(5)} ${MB(it.bytes).padStart(8)} MB`);
}
let shadowBytes = 0;
console.log('\nshadow maps:');
for (const s of out.shadows) { shadowBytes += s.bytes; console.log(`  ${s.label.padEnd(46)} ${String(s.w).padStart(5)}x${String(s.h).padEnd(5)} ${MB(s.bytes).padStart(8)} MB`); }

console.log(`\n  post-processing targets : ${MB(postBytes).padStart(8)} MB`);
console.log(`  shadow maps             : ${MB(shadowBytes).padStart(8)} MB`);
console.log(`  scene textures (${out.sceneTexCount})    : ${MB(out.sceneTexBytes).padStart(8)} MB`);
console.log(`  TOTAL                   : ${MB(postBytes + shadowBytes + out.sceneTexBytes).padStart(8)} MB`);

// The post chain scales with (canvas px * dpr^2); everything else is fixed.
const px = out.canvasW * out.canvasH;
console.log('\nprojected to real windows (post targets scale with pixel count; shadows+textures fixed):');
console.log('  window          dpr   post-proc      shadows     scene tex        TOTAL');
for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1440], [3440, 1440], [3840, 2160]]) {
  for (const dpr of [1, 2]) {
    const scale = (w * dpr * h * dpr) / px;
    const post = postBytes * scale;
    const tot = post + shadowBytes + out.sceneTexBytes;
    console.log(`  ${String(w + 'x' + h).padEnd(14)} ${dpr}    ${MB(post).padStart(8)} MB   ${MB(shadowBytes).padStart(6)} MB   ${MB(out.sceneTexBytes).padStart(7)} MB   ${MB(tot).padStart(8)} MB`);
  }
}
console.log('VRAM_END');
await b.close();
