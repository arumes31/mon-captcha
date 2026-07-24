/* ============================================================
   Phase 4a QA harness — shared helpers
   ------------------------------------------------------------
   DEV-ONLY. Imported by itest / visreg / perfbudget / fuzzseed /
   matrix / axe / shots. Nothing here ships with the game.

   Centralises the facts every script needs to agree on:
     - the SwiftShader launch args (Chromium only),
     - the "chrome-headless-shell parks rAF at fps 0" gotcha and
       its fix (pump frames by jiggling the mouse before sampling),
     - the console-noise policy (fail on ERRORS; a short list of
       benign WARNINGS is allowed),
     - reading the instance total + renderer.info off ?probe.
   ============================================================ */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const BASE_URL = process.env.CAPTCHA_BASE_URL || 'http://localhost:8347';

export const PAGES = {
  index: `${BASE_URL}/index.html`,
  test: `${BASE_URL}/test.html`,
};

// Chromium-only. SwiftShader is a software GL backend so WebGL works headless
// with no GPU. Firefox/WebKit ignore these and use their own GL, so matrix.mjs
// only passes them to Chromium.
export const SWIFTSHADER_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

// Benign console noise. These are WARNINGS the game (or the environment) emits
// that are NOT failures. We only ever FAIL the suite on console ERRORS and
// pageerrors — this list additionally shields us from any of these that a
// browser happens to surface at error level.
export const BENIGN = [
  /useLegacyLights/i,                    // three r160 lighting-mode deprecation notice
  /THREE\.WebGLRenderer/i,               // assorted three deprecation notices
  /AudioContext was not allowed to start/i,
  /The AudioContext was not allowed/i,
  /user (gesture|activation)/i,          // audio-needs-gesture
  /\[captcha\] spawned \d+\/\d+/i,       // crowded-seed spawn shortfall (warn)
  /favicon/i,                            // /favicon.ico is not served by http.server
  /Failed to load resource.*favicon/i,
  /Download the (React|Vue) DevTools/i,
  /net::ERR_/i,                          // Phase 4b: transient CDN (jsdelivr) network drops
                                         // during a load/retry — the game's readiness is
                                         // separately gated by waitForReady (a persistent
                                         // fetch failure still hard-fails there), so a
                                         // recovered network blip is not a game error.
];

// A WebGL context loss must never happen. onContextLost() logs this string.
const CONTEXT_LOST = /context\s*lost|webglcontextlost/i;

export function isBenign(text) {
  return BENIGN.some((re) => re.test(text || ''));
}

/* ------------------------------------------------------------
   Attach console/error collectors to a page. Returns a bag the
   caller inspects after the page has settled. Also route-blocks
   /favicon.ico so the browser's automatic request never 404s
   into the console.
   ------------------------------------------------------------ */
export async function attachCollectors(page) {
  const bag = { pageErrors: [], consoleErrors: [], warnings: [], contextLost: [] };

  try {
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 200, body: '' }));
  } catch { /* context may already be closed */ }

  page.on('pageerror', (err) => bag.pageErrors.push(String(err && err.message || err)));

  page.on('console', (msg) => {
    const text = msg.text();
    if (CONTEXT_LOST.test(text)) { bag.contextLost.push(text); return; }
    const type = msg.type();
    if (type === 'error') {
      if (!isBenign(text)) bag.consoleErrors.push(text);
      else bag.warnings.push('(benign-error) ' + text);
    } else if (type === 'warning') {
      bag.warnings.push(text);
    }
  });

  page.on('weberror', (err) => bag.pageErrors.push(String(err)));

  return bag;
}

/* ------------------------------------------------------------
   Wait until main.js has finished init: window.__captcha exists
   and the #loading spinner has been hidden.
   ------------------------------------------------------------ */
export async function waitForReady(page, { timeout = 180000 } = {}) {
  // Node-side polling + CDN-load recovery (Phase 4b robustness). Two failure
  // modes in this environment:
  //   (1) SwiftShader's cold compile synchronously stalls the page JS thread,
  //       starving IN-page polling (page.waitForFunction) — so we poll from Node
  //       via short evaluates, which detect readiness the instant it frees up.
  //   (2) The jsdelivr three.js module fetch intermittently drops
  //       (ERR_CONNECTION_CLOSED) — the module graph, and window.__captcha,
  //       never appear. If __captcha stays absent well past a normal init, we
  //       re-navigate to refetch (never reload once the game has loaded and is
  //       merely compiling, so a slow composite is still just waited out).
  // Same contract: resolves when __captcha exists and #loading is hidden.
  const deadline = Date.now() + timeout;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    let st = { ready: false, hasCaptcha: false };
    try {
      st = await page.evaluate(() => {
        const l = document.getElementById('loading');
        return {
          ready: !!(window.__captcha) && !!l && l.classList.contains('hidden'),
          hasCaptcha: !!window.__captcha,
        };
      });
    } catch (e) { /* navigation/eval race — retry */ }
    if (st.ready) return;
    if (!st.hasCaptcha && (Date.now() - lastReload) > 25000) {
      lastReload = Date.now();
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) {}
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`waitForReady: timed out after ${timeout}ms`);
}

/* ------------------------------------------------------------
   Pump frames. chrome-headless-shell has no display vsync, so the
   rAF game loop parks at fps 0 until an input event (or a
   screenshot) forces a compositor frame. Jiggle the mouse a few
   dozen times so recordFps() actually runs and state.fps climbs
   off zero before we sample it.
   ------------------------------------------------------------ */
export async function pumpFrames(page, n = 26) {
  for (let i = 0; i < n; i++) {
    await page.mouse.move(70 + ((i * 17) % 140), 70 + ((i * 11) % 100));
    await page.waitForTimeout(30);
  }
}

/* ------------------------------------------------------------
   Read the total InstancedMesh instance count off ?probe by
   walking the live scene graph. This is the "instance budget"
   the program tracks (ceiling ~42k). Requires the page to have
   been loaded with ?probe.
   ------------------------------------------------------------ */
export async function readInstanceTotal(page) {
  return page.evaluate(() => {
    const p = window.__probe;
    if (!p || !p.state || !p.state.scene) return null;
    // Phase 4b coordination: prefer the perf.js counter (item 357) when present
    // — it is the authoritative instance accountant now — and fall back to the
    // scene-walk so this stays backward-compatible with pre-4b pages. Both
    // return the identical { total, meshes } shape.
    if (p.perf && typeof p.perf.instanceTotal === 'function') {
      const r = p.perf.instanceTotal();
      if (r && typeof r.total === 'number') return r;
    }
    let total = 0;
    let meshes = 0;
    p.state.scene.traverse((o) => {
      if (o.isInstancedMesh) { total += (o.count || 0); meshes++; }
    });
    return { total, meshes };
  });
}

export async function readRendererInfo(page) {
  return page.evaluate(() => {
    const r = window.__probe && window.__probe.state && window.__probe.state.renderer;
    if (!r || !r.info) return null;
    return {
      calls: r.info.render.calls,
      triangles: r.info.render.triangles,
      geometries: r.info.memory.geometries,
      textures: r.info.memory.textures,
    };
  });
}

/* ------------------------------------------------------------
   Hide the full-screen overlays (start / pause / success / the
   test-harness panel) so a screenshot reveals the rendered world
   behind them. Leaves the game HUD (counter/crosshair) in place.
   ------------------------------------------------------------ */
export async function hideOverlays(page) {
  await page.evaluate(() => {
    for (const id of ['click-to-play', 'pause-overlay', 'success-modal', 'test-panel']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
  });
}

/* ------------------------------------------------------------
   Tiny assertion recorder + summary printer. No test-runner dep.
   ------------------------------------------------------------ */
export function makeReporter(title) {
  const rows = [];
  console.log(`\n=== ${title} ===`);
  return {
    check(name, cond, detail = '') {
      const pass = !!cond;
      rows.push({ name, pass, detail });
      const tag = pass ? 'PASS' : 'FAIL';
      console.log(`  [${tag}] ${name}${detail ? '  — ' + detail : ''}`);
      return pass;
    },
    info(msg) { console.log(`  ...  ${msg}`); },
    rows,
    passed() { return rows.filter((r) => r.pass).length; },
    failed() { return rows.filter((r) => !r.pass).length; },
    allPass() { return rows.every((r) => r.pass); },
    summary() {
      const p = this.passed(), f = this.failed();
      console.log(`  ---- ${title}: ${p} passed, ${f} failed ----`);
      return f === 0;
    },
  };
}

// Fold a collector bag into a reporter as 3 standard assertions.
export function checkClean(rep, bag, label = '') {
  const pfx = label ? label + ' ' : '';
  rep.check(`${pfx}zero pageerrors`, bag.pageErrors.length === 0, bag.pageErrors.slice(0, 3).join(' | '));
  rep.check(`${pfx}zero console errors`, bag.consoleErrors.length === 0, bag.consoleErrors.slice(0, 3).join(' | '));
  rep.check(`${pfx}no WebGL context-lost`, bag.contextLost.length === 0, bag.contextLost.slice(0, 2).join(' | '));
}

export function nowMs() { return Number(process.hrtime.bigint() / 1000000n); }
