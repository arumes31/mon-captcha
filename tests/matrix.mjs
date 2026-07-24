/* ============================================================
   matrix.mjs — cross-browser + mobile-profile smoke (items 388/389)
   ------------------------------------------------------------
   Runs a small smoke suite across:
     - chromium  (REQUIRED, SwiftShader) — hard-fails the run,
     - firefox   (BEST-EFFORT) — own GL; skipped-with-log if the
       browser binary isn't installed,
     - webkit    (BEST-EFFORT) — own GL; skipped-with-log if absent,
     - a couple of Playwright MOBILE device profiles (Pixel 5 +
       iPhone 13) driven on the Chromium engine + SwiftShader, so
       we exercise mobile viewport / UA / touch with working WebGL.

   Any browser that cannot be launched is SKIPPED with a clear log
   line rather than hard-failing the whole matrix (388/389 are
   best-effort by design). Only a chromium failure fails the run.

   Smoke per target: page loads, window.__captcha is live, the
   counter reads "Captured: 0/6", zero pageerrors. For Chromium
   targets we additionally require the WebGL world (canvas + no
   error fallback); for firefox/webkit WebGL is reported but not
   required (their headless GL support varies by machine).

   Usage:  node matrix.mjs
   Exit:   0 = chromium (+mobile) green, 1 = a required target failed.
   ============================================================ */

import { chromium, firefox, webkit, devices } from 'playwright';
import {
  PAGES, SWIFTSHADER_ARGS, attachCollectors, waitForReady, pumpFrames, makeReporter,
} from './harness.mjs';

async function smoke(context, label, rep, { requireWebgl }) {
  const page = await context.newPage();
  const bag = await attachCollectors(page);
  let pass = true;
  try {
    const resp = await page.goto(PAGES.index, { waitUntil: 'domcontentloaded', timeout: 60000 });
    pass = rep.check(`${label}: HTTP ok`, resp && resp.ok(), resp ? `status ${resp.status()}` : 'no response') && pass;
    await waitForReady(page, { timeout: 60000 });
    await pumpFrames(page, 16);

    const facts = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const errBox = document.getElementById('error-message');
      return {
        hasApi: !!window.__captcha,
        counter: q('#counter') ? q('#counter').textContent.trim() : null,
        hasCanvas: !!q('#captcha-container canvas'),
        errorVisible: errBox ? getComputedStyle(errBox).display !== 'none' : false,
        fps: window.__captcha ? window.__captcha.getFps() : null,
      };
    });

    pass = rep.check(`${label}: window.__captcha live`, facts.hasApi) && pass;
    pass = rep.check(`${label}: counter == "Captured: 0/6"`, facts.counter === 'Captured: 0/6', JSON.stringify(facts.counter)) && pass;
    pass = rep.check(`${label}: zero pageerrors`, bag.pageErrors.length === 0, bag.pageErrors.slice(0, 2).join(' | ')) && pass;

    const webglOk = facts.hasCanvas && !facts.errorVisible;
    if (requireWebgl) {
      pass = rep.check(`${label}: WebGL world rendered (canvas, no fallback)`, webglOk, `canvas=${facts.hasCanvas} fallback=${facts.errorVisible} fps=${facts.fps}`) && pass;
    } else {
      rep.info(`${label}: WebGL ${webglOk ? 'OK' : 'unavailable (fallback shown) — tolerated for best-effort'} (canvas=${facts.hasCanvas} fps=${facts.fps})`);
    }
  } catch (e) {
    pass = rep.check(`${label}: smoke ran`, false, String(e && e.message || e)) && pass;
  } finally {
    await page.close();
  }
  return pass;
}

async function runEngine(engine, name, args, rep, { required }) {
  let browser;
  try {
    browser = await engine.launch({ headless: true, args });
  } catch (e) {
    if (required) {
      rep.check(`${name}: launch`, false, String(e && e.message || e));
      return { ran: true, pass: false };
    }
    console.log(`  [SKIP] ${name}: not launchable — ${String(e && e.message || e).split('\n')[0]}`);
    return { ran: false, pass: true };
  }
  let pass = true;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    pass = await smoke(context, name, rep, { requireWebgl: required }) && pass;
    await context.close();
  } finally {
    await browser.close();
  }
  return { ran: true, pass };
}

async function runMobile(deviceName, rep) {
  const descriptor = devices[deviceName];
  if (!descriptor) { console.log(`  [SKIP] mobile ${deviceName}: no such device profile`); return { ran: false, pass: true }; }
  let browser;
  try {
    // Mobile profiles run on the Chromium engine so SwiftShader gives us WebGL;
    // the device descriptor still supplies the mobile viewport / UA / touch.
    browser = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
  } catch (e) {
    console.log(`  [SKIP] mobile ${deviceName}: chromium not launchable`);
    return { ran: false, pass: true };
  }
  let pass = true;
  try {
    const context = await browser.newContext({ ...descriptor });
    pass = await smoke(context, `mobile:${deviceName}`, rep, { requireWebgl: true }) && pass;
    await context.close();
  } finally {
    await browser.close();
  }
  return { ran: true, pass };
}

async function main() {
  const rep = makeReporter('matrix (cross-browser + mobile)');
  let requiredPass = true;
  const ran = [], skipped = [];

  // Chromium — REQUIRED.
  const chromiumRes = await runEngine(chromium, 'chromium', SWIFTSHADER_ARGS, rep, { required: true });
  requiredPass = requiredPass && chromiumRes.pass;
  ran.push('chromium');

  // Firefox / WebKit — BEST-EFFORT (own GL; no SwiftShader flags).
  const ffRes = await runEngine(firefox, 'firefox', [], rep, { required: false });
  (ffRes.ran ? ran : skipped).push('firefox');
  const wkRes = await runEngine(webkit, 'webkit', [], rep, { required: false });
  (wkRes.ran ? ran : skipped).push('webkit');

  // Mobile device profiles on Chromium — treated as required (Chromium engine).
  for (const dev of ['Pixel 5', 'iPhone 13']) {
    const r = await runMobile(dev, rep);
    if (r.ran) { ran.push(`mobile:${dev}`); requiredPass = requiredPass && r.pass; }
    else skipped.push(`mobile:${dev}`);
  }

  console.log(`\n  ran: ${ran.join(', ')}`);
  if (skipped.length) console.log(`  skipped: ${skipped.join(', ')}`);

  rep.check('required targets (chromium + mobile) all green', requiredPass);
  const ok = rep.summary() && requiredPass;
  console.log(`\n=== matrix overall: ${ok ? 'PASS' : 'FAIL'} (best-effort browsers never fail the run) ===`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('matrix crashed:', e); process.exit(2); });
