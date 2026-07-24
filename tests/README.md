# Monster CAPTCHA — QA harness (`tests/`)

Local, in-repo test tooling. Formalized in **Phase 4a** of EXPANSION PROGRAM III
(see `docs/plans/2026-07-16-expansion-plan.md`) so that every later phase inherits
one stable rig instead of rebuilding it in a scratchpad. Everything here still runs
fine manually from a shell — and as of 2026-07-23 it also runs in CI: see
`.github/workflows/ci.yml`, which serves the repo root the same way (`python -m
http.server`) and runs itest/axe/perfbudget/fuzzseed(10)/visreg/matrix on every push
and PR to `main`.

The shipped game stays **buildless and dependency-free**: `index.html`, `test.html`,
`main.js`, and everything under `src/` import nothing from `tests/`. The only
game-side test hooks are the two existing URL params `?probe` and `?seed` (added in
earlier phases — this phase added no production code).

---

## Prerequisites (one-time)

1. **Node** (used v24; anything modern works) and **npm**.
2. Install the dev-only test deps and browsers:
   ```
   cd tests
   npm install
   npx playwright install chromium        # REQUIRED
   npx playwright install firefox webkit  # best-effort (see matrix notes)
   ```
   `npm install` pulls `playwright`, `axe-core`, `pixelmatch`, `pngjs`
   (all dev-only; never shipped). `node_modules/` is git-ignored.
3. **Serve the project root** (file:// will NOT work — ES module + importmap):
   ```
   python -m http.server 8347      # run from the repo root, in its own shell
   ```
   All scripts default to `http://localhost:8347`. Override with
   `CAPTCHA_BASE_URL` if you serve elsewhere.

---

## Running

Run from inside `tests/` (each script is standalone; exit code 0 = pass):

| Script | What it checks |
| --- | --- |
| `node itest.mjs` | ~22 core assertions on **both** `index.html` and `test.html`. |
| `node perfbudget.mjs` | Instance total ≤ 42k, init-time bound, fps floor (across pinned seeds). |
| `node fuzzseed.mjs [N]` | N≥25 pinned seeds: zero errors, spawn success, budget, cave invariants. |
| `node visreg.mjs` | Screenshot + loose pixel-diff vs `baseline/` + structural asserts. |
| `node visreg.mjs --update` | (Re)generate the committed baselines. |
| `node matrix.mjs` | chromium (required) + firefox/webkit (best-effort) + mobile profiles. |
| `node axe.mjs` | axe-core accessibility audit on both pages. |
| `node shots.mjs [page] [seed] [name]` | Ad-hoc / phase screenshot into `output/`. |

Or `npm run itest`, `npm run perfbudget`, … `npm run all`.

---

## The Chromium launch args (SwiftShader)

Headless Chromium has no GPU, so we run WebGL on Google's **SwiftShader** software
GL backend. Every Chromium launch in this rig uses (see `harness.SWIFTSHADER_ARGS`):

```
--use-angle=swiftshader  --enable-unsafe-swiftshader  --ignore-gpu-blocklist
```

SwiftShader renders at roughly **10 fps** — that is expected, not a failure. The
game loop is dt-clamped, so all logic still runs correctly; the tests just use
generous waits. Firefox/WebKit ignore these flags and use their own GL, so
`matrix.mjs` only passes the flags to Chromium.

---

## The pump-frames gotcha (READ THIS)

`chrome-headless-shell` has **no display vsync**, so the `requestAnimationFrame`
game loop **parks at fps 0** until an input event (mouse move / click / key) or a
screenshot forces a compositor frame. Sampling fps or driving time-based logic on a
plain `waitForTimeout` therefore reads the world as frozen — this is the exact
harness artifact that made an earlier session think jump/dodge/magma were broken.

Fix: **jiggle the mouse before sampling.** `harness.pumpFrames(page, n)` moves the
mouse `n` times with small waits, which ticks `recordFps()` so `state.fps` climbs off
zero and any per-frame world state advances. Every script pumps frames before
reading fps or screenshotting.

---

## Thresholds & rationale

- **Instance budget ≤ 42,000** (`perfbudget.mjs`, `fuzzseed.mjs`). The program-wide
  worst-case ceiling. Measured live off `?probe` by summing every
  `InstancedMesh.count` in the scene graph. **Phase 4a baseline: measured worst-case
  = 33,572 instances** (across 25 fuzz seeds + 4 perf seeds), ~9.5k headroom to the
  42k ceiling. Later phases must keep this under 42k and re-record their own worst
  case in their handoff note.
- **Init-time ≤ 45,000 ms** (`perfbudget.mjs`). A loose *smoke* ceiling, not a
  benchmark — it includes the three.js CDN fetch and SwiftShader's software shader
  compile. It only catches a hang/regression, not micro-perf.
- **fps floor > 3** (`perfbudget.mjs`). SwiftShader-tolerant. Any positive,
  non-trivial fps after pumping proves the rAF loop is live (real value ~10).
- **Visual regression is deliberately LOOSE** (`visreg.mjs`). SwiftShader pixels vary
  by machine/driver/three build, so strict pixel identity is meaningless
  cross-machine. We instead assert:
  - **structural** (hard): canvas is **non-blank** (decoded-pixel luminance stddev
    `> 8` — a black/flat frame fails), the HUD elements are present, and `?probe`
    reports the live scene has content;
  - **pixel diff** (loose): mismatched-pixel fraction vs the baseline must stay under
    **0.35** (per-pixel `pixelmatch` threshold 0.2). On the **same machine** a re-run
    is ~0%; the loose bound is headroom for cross-machine AA/dither drift while still
    catching a catastrophic change (world gone, wrong scene, blank frame).
- **Spawn floor ≥ 18 creatures** (`fuzzseed.mjs`). A healthy surface population
  (deck target is 75 high-tier / 34 low). The benign `spawned N/x` shortfall warning
  is tolerated and logged, never failed.

---

## Console-noise policy

The suite fails on **console ERRORS**, **pageerrors**, and any **WebGL context
loss**. A short list of **benign WARNINGS** is allowed (`harness.BENIGN`): the three
r160 `useLegacyLights`/deprecation notices, the `AudioContext`-needs-user-gesture
notice, and the occasional `[captcha] spawned N/x` spawn-shortfall warning.
`/favicon.ico` is route-fulfilled so its automatic 404 never dirties the console.

---

## Cross-browser matrix (`matrix.mjs`)

- **chromium** — REQUIRED. Full WebGL smoke on SwiftShader; hard-fails the run.
- **firefox / webkit** — BEST-EFFORT. Launched with their own GL. If the browser
  binary is missing or not launchable on this host, it is **skipped with a clear log
  line** rather than failing the run. WebGL success is reported but not required for
  these (their headless GL support varies by machine).
- **mobile profiles** — `Pixel 5` + `iPhone 13` device descriptors driven on the
  **Chromium** engine + SwiftShader (so WebGL works while we exercise the mobile
  viewport / UA / touch). Treated as required.

> Host note (this machine): Playwright Firefox reported a missing system library
> (`msvcp140_1.dll`, part of the VC++ redistributable). Installing system libraries
> is out of scope for this phase, so Firefox is expected to **skip-with-log** here.
> See the matrix run output and the Phase 4a handoff for the exact browsers
> exercised.

---

## axe waivers

`axe.mjs` runs axe-core (WCAG 2.0/2.1 A + AA) on both pages and fails on any
violation whose rule id is **not** in the documented `WAIVERS` map at the top of the
script. Keep that map and this section in sync. Current waivers:

<!-- AXE_WAIVERS -->
**None.** As of the Phase 4a baseline run, both pages pass with **zero** axe
violations (`index.html`: 0 violations / 7 passing checks; `test.html`: 0 violations
/ 14 passing checks) under WCAG 2.0/2.1 A + AA. The `WAIVERS` map in `axe.mjs` is
therefore empty. If a future phase introduces a violation, either fix it or add a
waiver here **and** in `axe.mjs` with a stated reason.

---

## Screenshots & how future phases add theirs

- `visreg.mjs --update` writes the golden images to `baseline/` — the **only**
  screenshots committed to git (see the root `.gitignore`, which keeps
  `tests/baseline/**` and ignores `output/`, `diff/`, `shots-out/`).
- Ad-hoc / phase screenshots: `node shots.mjs index <seed> p<phase>-<name>.png`
  writes into `output/` (git-ignored). The STANDARD VERIFICATION for every phase
  requires screenshots named `p<phase>-*.png` that are actually **viewed**.
- To add a phase's own visual case: add an entry to `CASES` in `visreg.mjs` on a
  pinned `?seed=`, run `--update` once to mint its baseline, review it, and commit
  the new `baseline/*.png`. Name any extra loose phase shots `p<phase>-*.png`.

---

## Files

```
tests/
  harness.mjs      shared helpers (launch args, collectors, pump, probe reads, reporter)
  itest.mjs        core assertions (both pages)
  shots.mjs        screenshot helper + CLI
  visreg.mjs       visual regression (item 385)
  perfbudget.mjs   instance/init/fps budgets (item 387)
  fuzzseed.mjs     many-seed invariance sweep (item 391)
  matrix.mjs       cross-browser + mobile (items 388/389)
  axe.mjs          accessibility audit (item 395)
  baseline/        committed golden screenshots (kept in git)
  output/ diff/    transient run output (git-ignored)
  package.json     dev-only tooling manifest
```
