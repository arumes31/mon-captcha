/* Are shader programs still being linked DURING play?

   three links a material's program the first time it is rendered, so anything
   hidden or off-screen at spawn pays a synchronous driver stall the moment the
   player turns toward it. That is the shape of a mid-game freeze, and unlike
   frame timings the program COUNT is hardware-independent -- SwiftShader links
   the same set of programs a real driver does, just faster. So the count, and
   specifically how much of it lands after load, is the measurement that
   transfers.

   Reports programs at load and then during play. A warm-up is working when
   essentially all of the growth has moved to before the first frame.        */
import { chromium } from 'playwright';
import { SWIFTSHADER_ARGS } from './harness.mjs';

const BASE = process.env.CAPTCHA_BASE_URL || 'http://localhost:8080';
const SECONDS = Number(process.env.SECS || 180);
const SEED = process.env.SEED || '4242';

const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
const ctx = await b.newContext({ viewport: { width: 640, height: 400 } });
const p = await ctx.newPage();

let ready = false;
const t0 = Date.now();
for (let a = 0; a < 4 && !ready; a++) {
  try { await p.goto(`${BASE}/index.html?probe&quality=high&seed=${SEED}`, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) {}
  for (let i = 0; i < 70; i++) {
    if (await p.evaluate(() => !!window.__probe).catch(() => false)) { ready = true; break; }
    await p.waitForTimeout(1000);
  }
}
if (!ready) { console.log('LOAD FAILED'); await b.close(); process.exit(2); }

await p.evaluate(() => {
  const s = window.__probe.state;
  s.controls.isLocked = true;
  s.controls.dispatchEvent({ type: 'lock' });
});

const read = () => p.evaluate(() => {
  const s = window.__probe.state;
  let lights = 0;
  s.scene.traverse((o) => { if (o.isLight) lights++; });
  return { programs: s.renderer.info.programs ? s.renderer.info.programs.length : -1,
           frames: s.frameId | 0, tier: s.qualityLevel, pr: s.renderer.getPixelRatio(), lights };
}).catch(() => null);

const atLoad = await read();
console.log('WARM_BEGIN');
console.log(`programs immediately after load: ${atLoad.programs}   tier=${atLoad.tier} pr=${atLoad.pr} lights=${atLoad.lights}`);
console.log('\n t(s)  programs  frames  tier    newlyCompiled');

// Walk and look around so previously-unseen materials enter the frustum.
let driving = true;
(async () => {
  const keys = ['KeyW', 'KeyA', 'KeyW', 'KeyD'];
  let i = 0;
  while (driving) {
    if (i % 50 === 0) await p.keyboard.down(keys[(i / 50 | 0) % keys.length]).catch(() => {});
    if (i % 50 === 49) await p.keyboard.up(keys[(i / 50 | 0) % keys.length]).catch(() => {});
    await p.mouse.move(320 + 260 * Math.sin(i / 19), 200 + 90 * Math.cos(i / 27)).catch(() => {});
    await p.waitForTimeout(16);
    i++;
  }
})();

let prev = atLoad.programs, peak = atLoad.programs;
const start = Date.now();
while ((Date.now() - start) / 1000 < SECONDS) {
  await p.waitForTimeout(15000);
  const r = await read();
  if (!r) break;
  peak = Math.max(peak, r.programs);
  console.log(`${String(((Date.now() - start) / 1000) | 0).padStart(5)}  ${String(r.programs).padStart(8)}  ${String(r.frames).padStart(6)}  ${r.tier.padEnd(6)}  ${r.programs > prev ? '+' + (r.programs - prev) : '.'}`);
  prev = r.programs;
}
driving = false;
await p.waitForTimeout(200);

const during = peak - atLoad.programs;
console.log(`\n  programs linked at load : ${atLoad.programs}`);
console.log(`  programs linked IN PLAY : ${during}   <-- each of these is a synchronous stall on a real driver`);
console.log(`  total                   : ${peak}`);
console.log(`  load wall-clock         : ${(((Date.now() - t0) / 1000)).toFixed(1)}s (includes browser launch)`);
console.log('WARM_END');
await b.close();
