/* ============================================================
   Targeting — Palworld-style capture readout, field-guide skin
   ------------------------------------------------------------
   While the crosshair rests on a living creature in capture
   range: a walnut chip near the reticle names the creature, its
   tier and the live "Capture XX%" roll (back-position bonus
   included), plus a 3D additive ring at the creature's feet
   tinted cyan (sure thing) -> amber (risky). Also owns the
   "Back Bonus!" flourish shown when a ball actually connects
   from behind. All DOM is JS-injected with inline styles, same
   pattern as the capture toast.

   Backlog items folded in here (world-graphics-improvements.md):
     335  a screen-edge chromatic pulse reinforces a back-bonus hit,
          alongside the existing text flourish.
     345  the ring's chance-color now EASES toward the live capture
          chance instead of snapping the instant "behind" flips.
     346  a faint world-space trajectory-ghost line (the same
          BALL_SPEED/BALL_GRAVITY curve projectiles.js flies) previews
          the throw arc while a target is hovered.
     348  the panel's percent color/glow and the ring's base glow now
          scale continuously with the live chance instead of 3 buckets.
     349  a directional wedge on the ring marks the live back-bonus
          cone so circling a creature shows exactly where it opens up.
     350  hovering a target whose TRUE odds exceed CAPTURE_MAX_CHANCE
          shows a small ceiling marker, teaching the cap exists.
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state, reuse } from './state.js';
import { ui } from './ui.js';
import { getGroundY } from './heightfield.js';
import { caveCaptureBonus, tunnelBackDot, captureUiTags } from './caves/caves-gameplay.js';

const TIER_COLORS = { common: '#9aa5b1', uncommon: '#4ade80', rare: '#7db2ff', legendary: '#ffd75e' };
const RING_SURE = new THREE.Color(0x5ff0d0);   // ~100% — Palworld cyan
const RING_RISKY = new THREE.Color(0xff9a4d);  // low odds — HUD amber
const ringColor = new THREE.Color();

// item 348: continuous panel percent color (red -> amber -> green), replacing
// the old 3-bucket ternary. Scratch THREE.Colors so this never allocates.
const _pctA = new THREE.Color();
const _pctB = new THREE.Color();
function pctCss(chance) {
    if (chance >= 0.5) { _pctA.set(0xffd75e); _pctB.set(0x7fe8c9); _pctA.lerp(_pctB, (chance - 0.5) * 2); }
    else { _pctA.set(0xff8a66); _pctB.set(0xffd75e); _pctA.lerp(_pctB, chance * 2); }
    return '#' + _pctA.getHexString();
}

// item 346: trajectory-ghost simulation scratch (never allocates per frame).
const _ghostPos = new THREE.Vector3();
const _ghostVel = new THREE.Vector3();

export function initTargeting() {
    buildRing();
    buildPanel();
    buildBackFlash();
    buildEdgePulse();
    buildTrajectoryGhost();
}

/* ------------------------------------------------------------
   3D targeting ring — a thin base ring + three chasing arcs,
   additive so it glows over grass and water alike.
   ------------------------------------------------------------ */
function buildRing() {
    if (!state.scene) return;
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
        color: 0x5ff0d0, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    // soft dark contact ring underneath grounds the glow on bright grass
    const shadowMat = new THREE.MeshBasicMaterial({
        color: 0x1a2b24, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide,
    });
    const geos = [new THREE.RingGeometry(0.78, 0.94, 48), new THREE.RingGeometry(0.68, 1.2, 48)];
    const under = new THREE.Mesh(geos[1], shadowMat);
    under.rotation.x = -Math.PI / 2;
    under.position.y = -0.015;
    under.renderOrder = 4;
    group.add(under);
    const base = new THREE.Mesh(geos[0], mat);
    base.rotation.x = -Math.PI / 2;
    base.renderOrder = 5;
    group.add(base);

    const arcs = new THREE.Group();
    for (let i = 0; i < 3; i++) {
        const geo = new THREE.RingGeometry(1.02, 1.18, 12, 1, (i * Math.PI * 2) / 3, Math.PI / 3.2);
        geos.push(geo);
        const arc = new THREE.Mesh(geo, mat);
        arc.rotation.x = -Math.PI / 2;
        arc.renderOrder = 5;
        arcs.add(arc);
    }
    group.add(arcs);

    // item 349: a wedge spanning the live back-bonus cone (dot(throwDir,
    // facing) > BACK_BONUS_DOT), built symmetric around local +X, flattened
    // by the MESH's own rotation.x, then aimed purely via the HOLDER's
    // rotation.y each frame — holder.rotation.y = PI - heading points the
    // wedge's center at world direction (-cos(heading), -sin(heading)), i.e.
    // directly BEHIND the creature, matching the (cos h, sin h) facing
    // convention already used by isBehindCreature/projectiles.js below.
    const backHalf = Math.acos(THREE.MathUtils.clamp(CONFIG.BACK_BONUS_DOT, -1, 1));
    const backGeo = new THREE.RingGeometry(1.24, 1.46, 20, 1, -backHalf, backHalf * 2);
    geos.push(backGeo);
    const backMat = new THREE.MeshBasicMaterial({
        color: 0x9dffdd, transparent: true, opacity: 0.28,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const backMesh = new THREE.Mesh(backGeo, backMat);
    backMesh.rotation.x = -Math.PI / 2;
    backMesh.renderOrder = 5;
    const backHolder = new THREE.Group();
    backHolder.add(backMesh);
    group.add(backHolder);

    group.visible = false;
    state.scene.add(group);
    state.targetRing = {
        group, mat, shadowMat, arcs, geos,
        backCone: { holder: backHolder, mat: backMat },
        dispChance: null, lastEaseT: 0,
    };
}

/* ------------------------------------------------------------
   DOM panel — inline-styled walnut chip anchored under the
   reticle (pointer lock keeps the crosshair centered).
   ------------------------------------------------------------ */
function buildPanel() {
    if (!state.container) return;
    const root = document.createElement('div');
    root.style.cssText = [
        'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,44px)',
        'display:flex', 'flex-direction:column', 'align-items:center', 'gap:5px',
        'z-index:25', 'pointer-events:none', 'text-align:center', 'white-space:nowrap',
        'opacity:0', 'transition:opacity 0.14s ease',
    ].join(';');

    // row 1: name + tier
    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;align-items:baseline;gap:8px;text-shadow:0 1px 2px rgba(20,10,6,0.85);';
    const name = document.createElement('span');
    name.style.cssText = "font:700 16px/1.1 'Fraunces',Georgia,serif;color:#ffe9c6;letter-spacing:0.01em;";
    const tier = document.createElement('span');
    tier.style.cssText = 'font:800 10px/1.1 Nunito,system-ui,sans-serif;text-transform:uppercase;letter-spacing:0.16em;';
    nameRow.appendChild(name);
    nameRow.appendChild(tier);

    // row 2: capture chance pill (walnut chip skin)
    const pill = document.createElement('div');
    pill.style.cssText = [
        'display:flex', 'align-items:baseline', 'gap:7px', 'padding:5px 14px 6px',
        'background:linear-gradient(180deg,rgba(66,41,28,0.9),rgba(40,24,16,0.9))',
        'border:1px solid rgba(255,214,158,0.28)', 'border-radius:999px',
        'box-shadow:inset 0 1px 0 rgba(255,214,158,0.22),0 3px 8px rgba(20,10,6,0.5)',
    ].join(';');
    const label = document.createElement('span');
    label.style.cssText = 'font:700 11px/1 Nunito,system-ui,sans-serif;color:#cbb99d;letter-spacing:0.06em;';
    label.textContent = 'Capture';
    const pct = document.createElement('span');
    pct.style.cssText = 'font:800 17px/1 Nunito,system-ui,sans-serif;font-variant-numeric:tabular-nums;';
    pill.appendChild(label);
    pill.appendChild(pct);

    // row 3: live back-position bonus tag
    const bonus = document.createElement('div');
    bonus.style.cssText = [
        'display:none', 'padding:3px 10px 4px', 'border-radius:999px',
        'background:rgba(95,240,208,0.12)', 'border:1px solid rgba(95,240,208,0.5)',
        'font:800 10px/1.1 Nunito,system-ui,sans-serif', 'color:#5ff0d0',
        'letter-spacing:0.14em', 'text-transform:uppercase',
        'text-shadow:0 0 8px rgba(95,240,208,0.6)',
    ].join(';');
    bonus.textContent = 'Back Bonus +15%';

    root.appendChild(nameRow);
    root.appendChild(pill);
    root.appendChild(bonus);
    state.container.appendChild(root);
    state.targetPanel = { root, name, tier, pct, bonus, lastKey: '' };
}

// Big flourish stamped when a ball actually CONNECTS from behind
function buildBackFlash() {
    if (!state.container) return;
    const el = document.createElement('div');
    el.style.cssText = [
        'position:absolute', 'left:50%', 'top:42%', 'transform:translate(-50%,-50%) scale(0.6)',
        'font:italic 800 26px/1.1 Fraunces,Georgia,serif', 'color:#5ff0d0',
        'text-shadow:0 0 14px rgba(95,240,208,0.75),0 2px 0 rgba(20,10,6,0.6)',
        'letter-spacing:0.03em', 'z-index:26', 'pointer-events:none', 'white-space:nowrap',
        'opacity:0', 'transition:opacity 0.12s ease,transform 0.16s cubic-bezier(0.2,1.6,0.4,1)',
    ].join(';');
    el.textContent = 'Back Bonus!';
    state.container.appendChild(el);
    state.backFlashEl = el;
}

// item 335: a full-viewport inset chromatic-edge pulse, layered pink+cyan so
// it reads as a quick aberration flash rather than a flat color wash.
function buildEdgePulse() {
    if (!state.container) return;
    const el = document.createElement('div');
    el.style.cssText = [
        'position:absolute', 'inset:0', 'pointer-events:none', 'z-index:24',
        'opacity:0', 'transition:opacity 0.1s ease',
        'box-shadow:inset 0 0 46px 4px rgba(255,80,190,0.45), inset 0 0 92px 14px rgba(95,240,208,0.4)',
        'mix-blend-mode:screen',
    ].join(';');
    state.container.appendChild(el);
    state.backEdgePulseEl = el;
}

export function showBackBonusFlourish() {
    const el = state.backFlashEl;
    if (el) {
        el.style.opacity = '1';
        el.style.transform = 'translate(-50%,-50%) scale(1)';
        if (state.backFlashTimer) clearTimeout(state.backFlashTimer);
        state.backFlashTimer = setTimeout(() => {
            if (!state.backFlashEl) return;
            state.backFlashEl.style.opacity = '0';
            state.backFlashEl.style.transform = 'translate(-50%,-50%) scale(0.6)';
        }, 850);
    }
    // item 335
    const edge = state.backEdgePulseEl;
    if (edge) {
        edge.style.opacity = '1';
        if (state.backEdgeTimer) clearTimeout(state.backEdgeTimer);
        state.backEdgeTimer = setTimeout(() => {
            if (state.backEdgePulseEl) state.backEdgePulseEl.style.opacity = '0';
        }, 260);
    }
}

/* ------------------------------------------------------------
   Item 346 — a faint dashed line ghosting the throw's parabolic
   arc (BALL_SPEED/BALL_GRAVITY, same as projectiles.js) while a
   target is hovered, as a subtle aim-assist read.
   ------------------------------------------------------------ */
function buildTrajectoryGhost() {
    if (!state.scene) return;
    const n = CONFIG.TRAJECTORY_GHOST_STEPS;
    const positions = new Float32Array(n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineDashedMaterial({
        color: 0xcdeee0, transparent: true, opacity: 0.45, dashSize: 0.16, gapSize: 0.16, depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    line.visible = false;
    line.renderOrder = 4;
    state.scene.add(line);
    state.trajectoryGhost = { line, geo, mat, positions };
}

function updateTrajectoryGhost() {
    const tg = state.trajectoryGhost;
    if (!tg) return;
    _ghostPos.copy(reuse.rayOrigin);
    _ghostVel.copy(reuse.rayDir).multiplyScalar(CONFIG.BALL_SPEED);
    const n = CONFIG.TRAJECTORY_GHOST_STEPS;
    const dtSim = CONFIG.TRAJECTORY_GHOST_DT;
    for (let i = 0; i < n; i++) {
        tg.positions[i * 3] = _ghostPos.x;
        tg.positions[i * 3 + 1] = _ghostPos.y;
        tg.positions[i * 3 + 2] = _ghostPos.z;
        _ghostVel.y += CONFIG.BALL_GRAVITY * dtSim;
        _ghostPos.addScaledVector(_ghostVel, dtSim);
    }
    tg.geo.attributes.position.needsUpdate = true;
    tg.geo.computeBoundingSphere();
    tg.line.computeLineDistances();
    tg.line.visible = true;
}

/* ------------------------------------------------------------
   Per-frame hover — one raycast serves the crosshair scale
   class (legacy behavior), the readout panel and the ring.
   ------------------------------------------------------------ */
export function updateTargeting() {
    const active = state.controls && state.controls.isLocked && !state.isPaused && !state.isCaptchaSolved;
    let hovered = null;

    if (active) {
        state.camera.getWorldPosition(reuse.rayOrigin);
        state.camera.getWorldDirection(reuse.rayDir);
        state.raycaster.set(reuse.rayOrigin, reuse.rayDir);
        state.raycaster.far = CONFIG.CAPTURE_RANGE;

        reuse.intersectArray.length = 0;
        for (const c of state.creatures) {
            if (!c.alive) continue;
            for (const p of c.parts) reuse.intersectArray.push(p);
        }
        if (reuse.intersectArray.length > 0) {
            const hits = state.raycaster.intersectObjects(reuse.intersectArray, false);
            if (hits.length > 0 && hits[0].distance <= CONFIG.CAPTURE_RANGE) {
                hovered = hits[0].object.userData.creature || null;
                if (hovered && (!hovered.alive || hovered.capturing)) hovered = null;
            }
        }
    }

    if (ui.crosshair) {
        if (hovered) ui.crosshair.classList.add('hovering');
        else ui.crosshair.classList.remove('hovering');
    }
    state.targetHover = hovered;

    const panel = state.targetPanel;
    const ring = state.targetRing;
    if (!hovered) {
        if (panel) panel.root.style.opacity = '0';
        if (ring) ring.group.visible = false;
        if (state.trajectoryGhost) state.trajectoryGhost.line.visible = false;
        return;
    }

    // ---- capture odds (tier base + live back-position bonus) ----
    const def = hovered.def;
    const base = CONFIG.CAPTURE_RATE_BY_TIER[def.tier] !== undefined ? CONFIG.CAPTURE_RATE_BY_TIER[def.tier] : CONFIG.CAPTURE_MAX_CHANCE;
    const behind = isBehindCreature(hovered);
    // preview MIRRORS the single roll in capture.js: same base + back bonus + the
    // Phase 2k cave modifiers (dead-end 78, grotto ball 83), under the SAME cap —
    // so the readout never promises 100% (a common cornered from behind with the
    // grotto ball still reads 95%, its true ceiling).
    const uncapped = base + (behind ? CONFIG.CAPTURE_BACK_BONUS : 0) + caveCaptureBonus(hovered);
    const chance = Math.min(CONFIG.CAPTURE_MAX_CHANCE, uncapped);
    const pctVal = Math.round(chance * 100);
    const tags = captureUiTags(hovered, behind); // e.g. ["Tunnel Back","Cornered"]
    // item 350: the true odds exceed the hard ceiling — teach that it exists
    const atCeiling = uncapped > CONFIG.CAPTURE_MAX_CHANCE + 0.001;

    if (panel) {
        const key = def.id + '|' + pctVal + '|' + tags.join(',') + '|' + (atCeiling ? 1 : 0);
        if (panel.lastKey !== key) { // touch the DOM only when the readout changes
            panel.lastKey = key;
            panel.name.textContent = def.name;
            panel.tier.textContent = def.tier;
            panel.tier.style.color = TIER_COLORS[def.tier] || '#fff';
            panel.pct.textContent = pctVal + '%' + (atCeiling ? ' ▲' : '');
            // item 348: continuous color + glow instead of a 3-bucket ternary
            panel.pct.style.color = pctCss(chance);
            panel.pct.style.textShadow = '0 0 ' + (3 + chance * 15).toFixed(0) + 'px currentColor';
            if (tags.length) { panel.bonus.textContent = tags.join(' + ') + ' Bonus'; panel.bonus.style.display = 'block'; }
            else panel.bonus.style.display = 'none';
        }
        panel.root.style.opacity = '1';
    }

    // ---- ring at the creature's feet, tinted by the odds ----
    if (ring) {
        const groundY = Math.max(getGroundY(hovered.pos.x, hovered.pos.z), CONFIG.POND_WATER_LEVEL);
        ring.group.position.set(hovered.pos.x, groundY + 0.06, hovered.pos.z);
        const now = performance.now() / 1000;
        // ring hugs the body plan: tiny types get a readable minimum, huge
        // megafauna get a properly wide ring
        const s = THREE.MathUtils.clamp(hovered.hitRadius * 2.6, 0.55, 3.4) * (1 + Math.sin(now * 5.5) * 0.05);
        ring.group.scale.setScalar(s);
        ring.arcs.rotation.y = now * 1.6; // chasing arcs

        // item 345: ease the displayed chance toward the live one instead of
        // snapping the ring's color the instant "behind" flips as the player
        // circles the creature.
        if (ring.dispChance === null) { ring.dispChance = chance; ring.lastEaseT = now; }
        const easeDt = Math.min(0.1, Math.max(0, now - ring.lastEaseT));
        ring.lastEaseT = now;
        ring.dispChance += (chance - ring.dispChance) * Math.min(1, CONFIG.RING_COLOR_EASE * easeDt);

        ringColor.lerpColors(RING_RISKY, RING_SURE, THREE.MathUtils.clamp((ring.dispChance - 0.5) * 2, 0, 1));
        ring.mat.color.copy(ringColor);
        // item 348: base glow scales continuously with the eased chance
        ring.mat.opacity = (0.35 + ring.dispChance * 0.35) + Math.sin(now * 5.5) * 0.15;
        ring.group.visible = true;

        // item 349: aim the back-bonus cone wedge directly behind the
        // creature's heading (see buildRing's comment for the rotation math).
        if (ring.backCone) {
            ring.backCone.holder.rotation.y = Math.PI - hovered.heading;
            ring.backCone.mat.opacity = 0.22 + Math.sin(now * 4) * 0.08;
        }
    }

    // item 346
    updateTrajectoryGhost();
}

// Is the player positioned behind the creature's heading? Same test the
// projectile uses at impact, so the preview matches the roll.
function isBehindCreature(c) {
    const playerPos = state.controls ? state.controls.getObject().position : null;
    if (!playerPos) return false;
    let dx = c.pos.x - playerPos.x;
    let dz = c.pos.z - playerPos.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= len; dz /= len;
    // widened cone for tunnel-bound creatures (item 85), matching projectiles.js
    return (Math.cos(c.heading) * dx + Math.sin(c.heading) * dz) > tunnelBackDot(c);
}

export function disposeTargeting() {
    if (state.targetRing) {
        if (state.scene) state.scene.remove(state.targetRing.group);
        for (const g of state.targetRing.geos) { try { g.dispose(); } catch (e) {} }
        try { state.targetRing.mat.dispose(); } catch (e) {}
        try { state.targetRing.shadowMat.dispose(); } catch (e) {}
        if (state.targetRing.backCone) { try { state.targetRing.backCone.mat.dispose(); } catch (e) {} }
        state.targetRing = null;
    }
    if (state.targetPanel) {
        if (state.targetPanel.root.parentNode) state.targetPanel.root.parentNode.removeChild(state.targetPanel.root);
        state.targetPanel = null;
    }
    if (state.backFlashTimer) { clearTimeout(state.backFlashTimer); state.backFlashTimer = null; }
    if (state.backFlashEl) {
        if (state.backFlashEl.parentNode) state.backFlashEl.parentNode.removeChild(state.backFlashEl);
        state.backFlashEl = null;
    }
    if (state.backEdgeTimer) { clearTimeout(state.backEdgeTimer); state.backEdgeTimer = null; }
    if (state.backEdgePulseEl) {
        if (state.backEdgePulseEl.parentNode) state.backEdgePulseEl.parentNode.removeChild(state.backEdgePulseEl);
        state.backEdgePulseEl = null;
    }
    if (state.trajectoryGhost) {
        if (state.scene) state.scene.remove(state.trajectoryGhost.line);
        try { state.trajectoryGhost.geo.dispose(); } catch (e) {}
        try { state.trajectoryGhost.mat.dispose(); } catch (e) {}
        state.trajectoryGhost = null;
    }
    state.targetHover = null;
}
