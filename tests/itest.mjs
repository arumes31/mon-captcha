/* ============================================================
   itest.mjs — core integration assertions (Phase 4a)
   ------------------------------------------------------------
   Runs ~22 core assertions against BOTH index.html and test.html
   in headless Chromium + SwiftShader. This is the adopted,
   in-repo form of the rig that previously lived only in a session
   scratchpad.

   Asserts the loaded, pre-play state: the page comes up, the world
   inits, the frozen public API is present and reads its documented
   startup values, the counter shows exactly "Captured: 0/6", fps
   climbs off zero once frames are pumped, and the console stays
   clean (zero ERRORS / pageerrors / context-loss; benign warnings
   are allowed — see harness.BENIGN).

   Usage:  node itest.mjs
   Exit:   0 = all pass on both pages, 1 = any failure.
   ============================================================ */

import { chromium } from 'playwright';
import {
  PAGES, SWIFTSHADER_ARGS, attachCollectors, waitForReady, pumpFrames,
  makeReporter, checkClean,
} from './harness.mjs';

const API_METHODS = [
  'init', 'destroy', 'getCreaturesCaught', 'getIsCaptchaSolved',
  'getToken', 'getFps', 'getQualityLevel',
];

async function testPage(browser, label, url) {
  const rep = makeReporter(`itest: ${label} (${url})`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const bag = await attachCollectors(page);

  // 1. page loads (HTTP ok)
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  rep.check('HTTP response ok', resp && resp.ok(), resp ? `status ${resp.status()}` : 'no response');

  await waitForReady(page);

  // Snapshot DOM facts in one round-trip.
  const dom = await page.evaluate((methods) => {
    const q = (s) => document.querySelector(s);
    const canvas = q('#captcha-container canvas');
    const errBox = document.getElementById('error-message');
    const errStyle = errBox ? getComputedStyle(errBox).display : 'none';
    const api = window.__captcha;
    const apiShape = {};
    if (api) for (const m of methods) apiShape[m] = typeof api[m];
    return {
      title: document.title,
      hasContainer: !!q('#captcha-container'),
      hasCanvas: !!canvas,
      canvasW: canvas ? canvas.width : 0,
      canvasH: canvas ? canvas.height : 0,
      hasHud: !!q('#hud'),
      hasCounter: !!q('#counter'),
      counterText: q('#counter') ? q('#counter').textContent.trim() : null,
      hasCrosshair: !!q('#crosshair'),
      hasClickToPlay: !!q('#click-to-play'),
      errorVisible: errStyle !== 'none',
      hasApi: !!api,
      apiShape,
    };
  }, API_METHODS);

  rep.check('document.title present', !!dom.title, JSON.stringify(dom.title));
  rep.check('#captcha-container exists', dom.hasContainer);
  rep.check('canvas present in container', dom.hasCanvas);
  rep.check('canvas has non-zero size', dom.canvasW > 0 && dom.canvasH > 0, `${dom.canvasW}x${dom.canvasH}`);
  rep.check('#hud exists', dom.hasHud);
  rep.check('#crosshair exists', dom.hasCrosshair);
  rep.check('#click-to-play (start overlay) exists', dom.hasClickToPlay);
  rep.check('#error-message NOT visible (WebGL init ok)', !dom.errorVisible);
  rep.check('#counter exists', dom.hasCounter);
  rep.check('#counter == "Captured: 0/6"', dom.counterText === 'Captured: 0/6', JSON.stringify(dom.counterText));

  rep.check('window.__captcha defined', dom.hasApi);
  const shapeOk = API_METHODS.every((m) => dom.apiShape[m] === 'function');
  rep.check('__captcha exposes all 7 API methods', shapeOk, JSON.stringify(dom.apiShape));

  // API startup values.
  const api = await page.evaluate(() => {
    const a = window.__captcha;
    return a ? {
      caught: a.getCreaturesCaught(),
      solved: a.getIsCaptchaSolved(),
      token: a.getToken(),
      quality: a.getQualityLevel(),
    } : null;
  });
  rep.check('getCreaturesCaught() === 0', api && api.caught === 0, api ? String(api.caught) : 'n/a');
  rep.check('getIsCaptchaSolved() === false', api && api.solved === false, api ? String(api.solved) : 'n/a');
  rep.check('getToken() === null (no token yet)', api && api.token === null, api ? JSON.stringify(api.token) : 'n/a');
  // This harness always launches Chromium under SWIFTSHADER_ARGS (see harness.mjs),
  // a confirmed software rasterizer — gpu-detect.js now proactively seeds 'low'
  // for that case instead of paying for a ~60-frame FPS-sampled ramp-down, so
  // the deterministic expectation under this rig is 'low', not 'high'.
  rep.check('getQualityLevel() === "low" (SwiftShader is proactively detected)', api && api.quality === 'low', api ? String(api.quality) : 'n/a');

  // fps: pump frames first (chrome-headless-shell parks rAF otherwise).
  await pumpFrames(page);
  const fps = await page.evaluate(() => window.__captcha.getFps());
  rep.check('getFps() > 0 after pumping frames', fps > 0, `fps=${fps}`);

  // Console / error cleanliness.
  checkClean(rep, bag);
  if (bag.warnings.length) rep.info(`benign warnings (allowed): ${bag.warnings.length}`);

  await context.close();
  return rep.summary();
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
  let ok = true;
  try {
    ok = await testPage(browser, 'index.html', PAGES.index) && ok;
    ok = await testPage(browser, 'test.html', PAGES.test) && ok;
  } finally {
    await browser.close();
  }
  console.log(`\n=== itest overall: ${ok ? 'PASS' : 'FAIL'} ===`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('itest crashed:', e); process.exit(2); });
