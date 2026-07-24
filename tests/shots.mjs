/* ============================================================
   shots.mjs — screenshot helper (Phase 4a)
   ------------------------------------------------------------
   Shared screenshot routine used by visreg.mjs and runnable
   directly for ad-hoc / phase screenshots.

   Screenshot gotcha: SwiftShader renders at ~10 fps and
   chrome-headless-shell won't tick rAF without input, so we pump
   frames first and take the shot with `timeout: 120000,
   animations: 'disabled'` and generous settle waits.

   CLI:
     node shots.mjs [page] [seed] [outName]
       page    index | test | a full URL   (default: index)
       seed    integer to pin the world via ?seed=  (default: none)
       outName file name written under tests/output/ (default: auto)

   Examples:
     node shots.mjs index 777 p4a-index-777.png
     node shots.mjs test  42  p4a-test-42.png
   ============================================================ */

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  BASE_URL, PAGES, SWIFTSHADER_ARGS, __dirname,
  attachCollectors, waitForReady, pumpFrames, hideOverlays,
} from './harness.mjs';

export const OUTPUT_DIR = path.join(__dirname, 'output');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function urlFor(page, seed) {
  let base;
  if (page === 'index' || !page) base = PAGES.index;
  else if (page === 'test') base = PAGES.test;
  else base = page.startsWith('http') ? page : `${BASE_URL}/${page.replace(/^\//, '')}`;
  const params = ['probe'];
  if (seed !== undefined && seed !== null && seed !== '') params.push(`seed=${seed}`);
  return base + (base.includes('?') ? '&' : '?') + params.join('&');
}

/* ------------------------------------------------------------
   Capture one screenshot. Returns { buffer, bag, url }. If
   `outPath` is given the PNG is also written there. `revealWorld`
   hides the full-screen overlays so the rendered world shows.
   Reuses an existing browser if one is passed in.
   ------------------------------------------------------------ */
export async function capture(opts = {}) {
  const {
    page = 'index', seed = null, outPath = null,
    width = 1280, height = 720, revealWorld = true,
    settleMs = 3500, browser: sharedBrowser = null,
  } = opts;

  const browser = sharedBrowser || await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
  const context = await browser.newContext({ viewport: { width, height } });
  const p = await context.newPage();
  const bag = await attachCollectors(p);
  const url = urlFor(page, seed);

  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForReady(p);
  await pumpFrames(p, 24);          // wake the rAF loop
  await p.waitForTimeout(settleMs); // let the (slow) SwiftShader world settle
  await pumpFrames(p, 12);          // and keep it ticking right up to the shot
  if (revealWorld) await hideOverlays(p);

  // Force the heavy first composited frame inside evaluate (no action timeout)
  // so the screenshot grabs an already-rendered framebuffer — SwiftShader's
  // cold SSAO+bloom compile can otherwise exceed the capture timeout.
  await p.evaluate(() => {
    const s = window.__probe && window.__probe.state;
    if (!s || !s.renderer) return;
    const draw = () => { try { (s.composer && s.composerEnabled) ? s.composer.render() : s.renderer.render(s.scene, s.camera); } catch (e) { /* ignore */ } };
    draw(); draw();
  });

  const shotOpts = { timeout: 240000, animations: 'disabled' };
  if (outPath) { ensureDir(path.dirname(outPath)); shotOpts.path = outPath; }
  const buffer = await p.screenshot(shotOpts);

  await context.close();
  if (!sharedBrowser) await browser.close();
  return { buffer, bag, url };
}

// ---- CLI ----
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [, , page = 'index', seedArg, outArg] = process.argv;
  const seed = seedArg !== undefined ? seedArg : null;
  const outName = outArg || `shot-${page}${seed !== null ? '-' + seed : ''}-${Date.now()}.png`;
  const outPath = path.isAbsolute(outName) ? outName : path.join(OUTPUT_DIR, outName);
  capture({ page, seed, outPath }).then(({ url, bag }) => {
    console.log(`screenshot written: ${outPath}`);
    console.log(`  url: ${url}`);
    console.log(`  pageerrors=${bag.pageErrors.length} consoleErrors=${bag.consoleErrors.length} warnings=${bag.warnings.length}`);
    process.exit(0);
  }).catch((e) => { console.error('shots crashed:', e); process.exit(2); });
}
