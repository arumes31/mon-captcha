/* ============================================================
   axe.mjs — accessibility audit (item 395)
   ------------------------------------------------------------
   Injects axe-core AT TEST TIME ONLY (the shipped pages stay
   dependency-free — nothing under src/ or the HTML references
   axe) and reports WCAG 2 A/AA violations on BOTH index.html and
   test.html.

   axe-core is loaded from tests/node_modules/axe-core/axe.min.js
   via addScriptTag, then axe.run() executes in-page.

   Waiver policy: the run FAILS on any violation that is not in the
   documented WAIVERS list below. Each waiver names the rule, the
   scope, and the reason. Keep this list and README.md in sync.

   Usage:  node axe.mjs
   Exit:   0 = no non-waived violations on either page, 1 = otherwise.
   ============================================================ */

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import {
  PAGES, SWIFTSHADER_ARGS, __dirname, attachCollectors, waitForReady, makeReporter,
} from './harness.mjs';

const AXE_PATH = path.join(__dirname, 'node_modules', 'axe-core', 'axe.min.js');

/* ------------------------------------------------------------
   Documented waivers. A violation is waived only if its ruleId is
   listed here. Anything else fails the audit. Every waiver states
   WHY it is acceptable for a full-screen procedural WebGL game.
   (Populated after the first real run — see README "axe waivers".)
   ------------------------------------------------------------ */
const WAIVERS = {
  // Example shape (kept in sync with README):
  // 'color-contrast': 'Decorative HUD chips over a dynamic 3D scene; text is a
  //                    non-essential control hint, not content. Re-evaluated in 4r (HUD II).',
};

async function auditPage(browser, label, url, rep) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const bag = await attachCollectors(page);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForReady(page);
  await page.addScriptTag({ path: AXE_PATH });

  const results = await page.evaluate(async () => {
    // WCAG 2.0/2.1 level A + AA, the standard captcha-relevant set.
    return await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
  });

  await context.close();

  const violations = results.violations || [];
  const waived = [];
  const failing = [];
  for (const v of violations) {
    if (WAIVERS[v.id]) waived.push(v);
    else failing.push(v);
  }

  console.log(`\n  --- ${label}: ${violations.length} violation rule(s) (${failing.length} failing, ${waived.length} waived), ${results.passes.length} passing checks ---`);
  for (const v of violations) {
    const status = WAIVERS[v.id] ? 'WAIVED' : 'FAIL';
    console.log(`    [${status}] ${v.id} (${v.impact}) x${v.nodes.length}: ${v.help}`);
    for (const n of v.nodes.slice(0, 2)) console.log(`        @ ${n.target.join(' ')}`);
  }

  rep.check(`${label}: no non-waived axe violations`, failing.length === 0,
    failing.length ? failing.map((v) => `${v.id}(${v.impact})`).join(', ') : 'clean');

  return { violations, waived, failing };
}

async function main() {
  if (!fs.existsSync(AXE_PATH)) {
    console.error(`axe-core not found at ${AXE_PATH} — run "npm install" in tests/ first.`);
    process.exit(2);
  }
  const rep = makeReporter('axe (accessibility)');
  const browser = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
  try {
    await auditPage(browser, 'index.html', PAGES.index, rep);
    await auditPage(browser, 'test.html', PAGES.test, rep);
  } finally {
    await browser.close();
  }
  const ok = rep.summary();
  console.log(`\n=== axe overall: ${ok ? 'PASS (green or fully waived)' : 'FAIL (un-waived violations)'} ===`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('axe crashed:', e); process.exit(2); });
