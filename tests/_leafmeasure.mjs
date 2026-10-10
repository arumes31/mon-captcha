/* TEMP — single frozen measurement of canopy/scene blackness for before-after. */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { BASE_URL, SWIFTSHADER_ARGS, __dirname, attachCollectors, waitForReady, pumpFrames, hideOverlays } from './harness.mjs';

const OUT = path.join(__dirname, 'output', 'leafmeasure');
fs.mkdirSync(OUT, { recursive: true });
const seed = process.argv[2] || '777';
const tag = process.argv[3] || 'run';

const browser = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
const p = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
attachCollectors(p);
await p.goto(`${BASE_URL}/index.html?probe&photo&seed=${seed}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await waitForReady(p);
await pumpFrames(p, 24);
await p.evaluate(() => window.__probe.forceWeather('clear', true));
await p.waitForTimeout(2500);
await pumpFrames(p, 20);
await hideOverlays(p);

const noBounce = process.argv.includes('nobounce');
const inst = await p.evaluate((noBounce) => {
  const s = window.__probe.state;
  if (s.rafId) cancelAnimationFrame(s.rafId);
  s.rafId = null;
  if (noBounce && s.bounceFill) s.bounceFill.intensity = 0; // emulate the pre-fix 3-light rig
  (s.composer && s.composerEnabled) ? s.composer.render() : s.renderer.render(s.scene, s.camera);
  (s.composer && s.composerEnabled) ? s.composer.render() : s.renderer.render(s.scene, s.camera);
  const rgb2l = (hex) => {
    const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
    return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  };
  let n = 0, min = 1, sum = 0, black = 0, below10 = 0;
  for (const d of (s.detailInstances || [])) {
    if (d.kind !== 'leaf') continue;
    const l = rgb2l(d.color);
    if (l < min) min = l;
    if (d.color === 0) black++;
    if (l < 0.10) below10++;
    sum += l; n++;
  }
  return { leaves: n, minL: +min.toFixed(4), meanL: +(sum / n).toFixed(4), pureBlack: black, below0_10: below10 };
}, noBounce);

const buf = await p.screenshot({ timeout: 300000, animations: 'disabled', path: path.join(OUT, `${tag}-${seed}.png`) });
const png = PNG.sync.read(buf);
const px = (x, y) => { const i = (png.width * y + x) << 2; return [png.data[i], png.data[i + 1], png.data[i + 2]]; };
const band = (x0, x1, y0, y1, step) => {
  let n = 0, sum = 0, b8 = 0, b16 = 0, b32 = 0, sat = 0, sq = 0;
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const [r, g, bl] = px(x, y);
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    if (l < 8) b8++; if (l < 16) b16++; if (l < 32) b32++;
    const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
    sat += mx === 0 ? 0 : (mx - mn) / mx;
    sum += l; sq += l * l; n++;
  }
  const mean = sum / n;
  return { luma: +mean.toFixed(1), b8: +(100 * b8 / n).toFixed(2), b16: +(100 * b16 / n).toFixed(2), b32: +(100 * b32 / n).toFixed(2), sat: +(sat / n).toFixed(3), sd: +Math.sqrt(sq / n - mean * mean).toFixed(1) };
};
console.log(tag, 'seed', seed, JSON.stringify({
  instances: inst,
  canopyBand: band(150, 900, 0, 300, 2),
  frame: band(0, 1280, 0, 720, 4),
}));
await browser.close();
