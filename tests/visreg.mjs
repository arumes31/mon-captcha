/* ============================================================
   visreg.mjs — visual regression on pinned worlds (item 385)
   ------------------------------------------------------------
   Screenshots pinned ?seed= worlds and compares each against a
   committed golden image under tests/baseline/, PLUS structural
   assertions that survive machine-to-machine renderer drift.

   Why loose: SwiftShader is a software GL backend whose exact
   pixels vary per machine / driver / three.js build, so a strict
   pixel identity check is meaningless across machines. Instead:

     - STRUCTURAL asserts (always hard): the canvas is NON-BLANK
       (decoded-pixel luminance spread above a floor — a black or
       flat frame fails), the game HUD elements are present, and
       (?probe) the live scene actually has content.
     - PIXEL DIFF (loose): fraction of differing pixels vs the
       baseline must stay under MISMATCH_MAX (default 0.35). On the
       SAME machine a re-run is ~0; the loose bound is headroom for
       cross-machine AA/dither drift while still catching a
       catastrophic regression (world vanished, wrong scene, blank).

   Baselines: `node visreg.mjs --update` (re)generates and, being
   the golden set, they are committed (tests/baseline/*.png is the
   one screenshot location kept in git).

   Usage:
     node visreg.mjs            compare against baselines
     node visreg.mjs --update   (re)generate baselines, then pass
   Exit: 0 = all pass, 1 = any structural fail or over-threshold diff.
   ============================================================ */

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import {
  BASE_URL, SWIFTSHADER_ARGS, __dirname,
  attachCollectors, waitForReady, pumpFrames, hideOverlays, makeReporter,
} from './harness.mjs';

const BASELINE_DIR = path.join(__dirname, 'baseline');
const DIFF_DIR = path.join(__dirname, 'diff');
const WIDTH = 1280, HEIGHT = 720;

// Pinned worlds (page + seed). Same seed => same procedural world.
const CASES = [
  { name: 'index-seed777', page: 'index.html', seed: 777 },
  { name: 'index-seed4242', page: 'index.html', seed: 4242 },
  { name: 'index-seed20260718', page: 'index.html', seed: 20260718 },
];

// Thresholds (documented above / in README).
const MISMATCH_MAX = 0.35;      // loose per-pixel mismatch fraction ceiling
const PIXELMATCH_THRESHOLD = 0.2; // per-pixel color-distance sensitivity
const LUMA_SPREAD_FLOOR = 8;    // stddev of luminance a non-blank frame must clear

const UPDATE = process.argv.includes('--update') || process.argv.includes('--baseline');

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

// Standard-deviation of luminance across the decoded frame — our "non-blank" metric.
function lumaSpread(png) {
  const { data } = png;
  let sum = 0, sum2 = 0, n = 0;
  // sample every 4th pixel for speed
  for (let i = 0; i < data.length; i += 16) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += l; sum2 += l * l; n++;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

async function captureCase(browser, c, rep) {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page = await context.newPage();
  const bag = await attachCollectors(page);
  const url = `${BASE_URL}/${c.page}?probe&seed=${c.seed}`;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForReady(page);
  await pumpFrames(page, 24);
  await page.waitForTimeout(3500);
  await pumpFrames(page, 12);

  const facts = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const p = window.__probe;
    let sceneChildren = null;
    if (p && p.state && p.state.scene) sceneChildren = p.state.scene.children.length;
    return {
      hasCanvas: !!q('#captcha-container canvas'),
      hasCounter: !!q('#counter'),
      hasCrosshair: !!q('#crosshair'),
      counter: q('#counter') ? q('#counter').textContent.trim() : null,
      sceneChildren,
    };
  });

  await hideOverlays(page);
  // Force the heavy first composited frame NOW. On a cold WebGL context the
  // SSAO+bloom+output shader compile under SwiftShader can take minutes; doing it
  // inside page.evaluate (which has no action timeout) means the subsequent
  // screenshot grabs an already-rendered framebuffer instead of blowing its own
  // capture timeout. Render twice so the buffer is fresh at capture time
  // (preserveDrawingBuffer is off).
  await page.evaluate(() => {
    const s = window.__probe && window.__probe.state;
    if (!s || !s.renderer) return;
    const draw = () => { try { (s.composer && s.composerEnabled) ? s.composer.render() : s.renderer.render(s.scene, s.camera); } catch (e) { /* ignore */ } };
    draw(); draw();
  });
  const buffer = await page.screenshot({ timeout: 240000, animations: 'disabled' });
  await context.close();
  return { buffer, facts, bag };
}

async function main() {
  ensureDir(BASELINE_DIR);
  const rep = makeReporter(`visreg (${UPDATE ? 'UPDATE baselines' : 'compare'})`);
  const browser = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });

  try {
    for (const c of CASES) {
      const { buffer, facts, bag } = await captureCase(browser, c, rep);
      const png = PNG.sync.read(buffer);
      const spread = lumaSpread(png);

      // Structural asserts (always hard).
      rep.check(`${c.name}: canvas present`, facts.hasCanvas);
      rep.check(`${c.name}: HUD (#counter + #crosshair) present`, facts.hasCounter && facts.hasCrosshair);
      rep.check(`${c.name}: counter == "Captured: 0/6"`, facts.counter === 'Captured: 0/6', JSON.stringify(facts.counter));
      rep.check(`${c.name}: scene has content (?probe children)`, (facts.sceneChildren || 0) > 5, `children=${facts.sceneChildren}`);
      rep.check(`${c.name}: frame NON-BLANK (luma spread > ${LUMA_SPREAD_FLOOR})`, spread > LUMA_SPREAD_FLOOR, `spread=${spread.toFixed(1)}`);
      rep.check(`${c.name}: clean console`, bag.pageErrors.length === 0 && bag.consoleErrors.length === 0 && bag.contextLost.length === 0);

      const baselinePath = path.join(BASELINE_DIR, `${c.name}.png`);

      if (UPDATE || !fs.existsSync(baselinePath)) {
        fs.writeFileSync(baselinePath, buffer);
        rep.info(`${c.name}: baseline ${UPDATE ? 're' : ''}generated -> ${path.relative(__dirname, baselinePath)} (spread=${spread.toFixed(1)})`);
        continue;
      }

      // Pixel diff vs baseline (loose).
      const base = PNG.sync.read(fs.readFileSync(baselinePath));
      if (base.width !== png.width || base.height !== png.height) {
        rep.check(`${c.name}: baseline dimensions match`, false, `baseline ${base.width}x${base.height} vs shot ${png.width}x${png.height}`);
        continue;
      }
      const diff = new PNG({ width: png.width, height: png.height });
      const mismatched = pixelmatch(base.data, png.data, diff.data, png.width, png.height, { threshold: PIXELMATCH_THRESHOLD });
      const fraction = mismatched / (png.width * png.height);
      ensureDir(DIFF_DIR);
      fs.writeFileSync(path.join(DIFF_DIR, `${c.name}.diff.png`), PNG.sync.write(diff));
      rep.check(`${c.name}: pixel mismatch <= ${MISMATCH_MAX}`, fraction <= MISMATCH_MAX, `mismatch=${(fraction * 100).toFixed(2)}%`);
    }
  } finally {
    await browser.close();
  }

  const ok = rep.summary();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('visreg crashed:', e); process.exit(2); });
