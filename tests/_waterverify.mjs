/* TEMP — water fix verification. Frozen world, deterministic A/B/A, per seed+tier.
   "prefix" reproduces the pre-fix state exactly: extras-only onBeforeRender,
   identity textureMatrix, eye at the origin (i.e. the mirror pass never ran). */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { BASE_URL, SWIFTSHADER_ARGS, __dirname, attachCollectors, waitForReady, pumpFrames, hideOverlays } from './harness.mjs';

const seed = process.argv[2] || '777';
const tier = process.argv[3] || 'photo';
const OUT = path.join(__dirname, 'output', 'waterverify');
fs.mkdirSync(OUT, { recursive: true });
const photo = tier === 'low' ? '' : '&photo';
const tag = `${seed}-${tier}${process.argv[4] === 'aim' ? '-aim' : ''}`;

const browser = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
const p = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const bag = await attachCollectors(p);

await p.goto(`${BASE_URL}/index.html?probe${photo}&seed=${seed}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await waitForReady(p);
await pumpFrames(p, 24);
await p.evaluate(() => window.__probe.forceWeather('clear', true));
await p.waitForTimeout(2500);
await pumpFrames(p, 20);
await hideOverlays(p);

const aim = process.argv[4] === 'aim';
const info = await p.evaluate((doAim) => {
  const s = window.__probe.state;
  if (s.rafId) cancelAnimationFrame(s.rafId);
  s.rafId = null;
  if (doAim) { // park the camera over the central pond so every seed shows water
    s.camera.position.set(0, 5.5, 15);
    s.camera.rotation.set(0, 0, 0, 'YXZ');
    s.camera.lookAt(0, 0, 0);
    s.camera.updateMatrixWorld(true);
  }
  if (s.filmPass) s.filmPass.enabled = false;  // grain would swamp the A/B diff
  const w = s.water, u = w.material.uniforms;
  window.__chained = w.onBeforeRender;
  window.__save = { time: u.time.value };
  window.__draw = () => { try { (s.composer && s.composerEnabled) ? s.composer.render() : s.renderer.render(s.scene, s.camera); } catch (e) { console.log('drawerr', e.message); } };
  window.__set = (mode) => {
    const uu = s.water.material.uniforms;
    s.water.visible = true;
    uu.time.value = window.__save.time;
    if (mode === 'prefix') {
      s.water.onBeforeRender = (renderer, scene, camera) => window.__chained.__extrasOnly ? null : null;
      uu.textureMatrix.value.identity();
      uu.eye.value.set(0, 0, 0);
    } else if (mode === 'hidden') {
      s.water.onBeforeRender = window.__chained; s.water.visible = false;
    } else if (mode === 'fixed-t2') {
      s.water.onBeforeRender = window.__chained; uu.time.value = window.__save.time + 3.0;
    } else {
      s.water.onBeforeRender = window.__chained;
    }
    window.__draw(); window.__draw();
  };
  return {
    quality: s.qualityLevel, softwareRenderer: !!s.softwareRenderer, composerEnabled: !!s.composerEnabled,
    reflectRes: u.mirrorSampler.value.image.width,
    waterSegs: w.geometry.parameters.widthSegments,
    hookChained: /waterOwnHook/.test(String(w.onBeforeRender)),
    hasDistortionScale: 'distortionScale' in u,
    distortionScale: u.distortionScale.value,
    sizeUniform: u.size.value,
    materialType: w.material.type,
  };
}, aim);
console.log(`INFO ${tag}`, JSON.stringify(info));

const MODES = ['prefix', 'fixed', 'hidden', 'fixed-t2', 'prefix-again', 'fixed-again'];
const shots = {};
for (const m of MODES) {
  await p.evaluate((mm) => window.__set(mm.replace('-again', '')), m);
  const buf = await p.screenshot({ timeout: 300000, animations: 'disabled', path: path.join(OUT, `${tag}-${m}.png`) });
  shots[m] = PNG.sync.read(buf);
}

const A = shots['fixed'], H = shots['hidden'];
const W = A.width;
const mask = new Uint8Array(W * A.height);
let cnt = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
for (let y = 0; y < A.height; y++) for (let x = 0; x < W; x++) {
  const i = (W * y + x) << 2;
  const d = Math.abs(A.data[i] - H.data[i]) + Math.abs(A.data[i + 1] - H.data[i + 1]) + Math.abs(A.data[i + 2] - H.data[i + 2]);
  if (d > 10) { mask[W * y + x] = 1; cnt++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
}
console.log(`waterMask px=${cnt} bbox=[${minx},${miny} .. ${maxx},${maxy}]`);
{
  const out = new PNG({ width: W, height: A.height });
  for (let i = 0; i < mask.length; i++) { const j = i << 2; const m = mask[i]; out.data[j] = m ? 255 : A.data[j] >> 2; out.data[j + 1] = m ? 0 : A.data[j + 1] >> 2; out.data[j + 2] = m ? 255 : A.data[j + 2] >> 2; out.data[j + 3] = 255; }
  fs.writeFileSync(path.join(OUT, `${tag}-mask.png`), PNG.sync.write(out));
}

function metrics(png) {
  let h = 0, hn = 0, v = 0, vn = 0, n = 0, sum = 0, sum2 = 0, r = 0, g = 0, b = 0;
  for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
    const k = W * y + x; if (!mask[k]) continue;
    const i = k << 2;
    const l = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
    r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2];
    sum += l; sum2 += l * l; n++;
    if (mask[k + 1]) { const j = i + 4; h += (Math.abs(png.data[i] - png.data[j]) + Math.abs(png.data[i + 1] - png.data[j + 1]) + Math.abs(png.data[i + 2] - png.data[j + 2])) / 3; hn++; }
    if (y < maxy && mask[k + W]) { const j = i + (W << 2); v += (Math.abs(png.data[i] - png.data[j]) + Math.abs(png.data[i + 1] - png.data[j + 1]) + Math.abs(png.data[i + 2] - png.data[j + 2])) / 3; vn++; }
  }
  const mean = sum / n;
  return { hAdj: h / Math.max(1, hn), vAdj: v / Math.max(1, vn), lum: mean, sd: Math.sqrt(sum2 / n - mean * mean), rgb: [r / n, g / n, b / n].map(Math.round) };
}
function maskedDiff(a, b) {
  let s = 0, n = 0, mx = 0;
  for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
    const k = W * y + x; if (!mask[k]) continue;
    const i = k << 2;
    const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
    s += d; n++; if (d > mx) mx = d;
  }
  return { mean: s / n, max: mx };
}
for (const m of MODES) {
  if (m === 'hidden') continue;
  const q = metrics(shots[m]);
  console.log(m.padEnd(14), 'hAdj', q.hAdj.toFixed(3), 'vAdj', q.vAdj.toFixed(3), 'lumSD', q.sd.toFixed(2), 'lum', q.lum.toFixed(1), 'rgb', JSON.stringify(q.rgb));
}
console.log('control prefix vs prefix-again ', JSON.stringify(maskedDiff(shots['prefix'], shots['prefix-again'])));
console.log('control fixed  vs fixed-again  ', JSON.stringify(maskedDiff(shots['fixed'], shots['fixed-again'])));
console.log('ANIMATION fixed vs fixed-t2    ', JSON.stringify(maskedDiff(shots['fixed'], shots['fixed-t2'])));
console.log('EFFECT   prefix vs fixed       ', JSON.stringify(maskedDiff(shots['prefix'], shots['fixed'])));
console.log('pageErrors', bag.pageErrors.length, bag.pageErrors.slice(0, 4));
console.log('consoleErrors', bag.consoleErrors.length, bag.consoleErrors.slice(0, 4));
await browser.close();
