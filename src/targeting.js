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
   ============================================================ */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state, reuse } from './state.js';
import { ui } from './ui.js';
import { getGroundY } from './heightfield.js';
import { caveCaptureBonus, tunnelBackDot, captureUiTags } from './caves-gameplay.js';

const TIER_COLORS = { common: '#9aa5b1', uncommon: '#4ade80', rare: '#7db2ff', legendary: '#ffd75e' };
const RING_SURE = new THREE.Color(0x5ff0d0);   // ~100% — Palworld cyan
const RING_RISKY = new THREE.Color(0xff9a4d);  // low odds — HUD amber
const ringColor = new THREE.Color();

export function initTargeting() {
    buildRing();
    buildPanel();
    buildBackFlash();
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
    group.visible = false;
    state.scene.add(group);
    state.targetRing = { group, mat, shadowMat, arcs, geos };
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

export function showBackBonusFlourish() {
    const el = state.backFlashEl;
    if (!el) return;
    el.style.opacity = '1';
    el.style.transform = 'translate(-50%,-50%) scale(1)';
    if (state.backFlashTimer) clearTimeout(state.backFlashTimer);
    state.backFlashTimer = setTimeout(() => {
        if (!state.backFlashEl) return;
        state.backFlashEl.style.opacity = '0';
        state.backFlashEl.style.transform = 'translate(-50%,-50%) scale(0.6)';
    }, 850);
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
    const chance = Math.min(
        CONFIG.CAPTURE_MAX_CHANCE,
        base + (behind ? CONFIG.CAPTURE_BACK_BONUS : 0) + caveCaptureBonus(hovered)
    );
    const pctVal = Math.round(chance * 100);
    const tags = captureUiTags(hovered, behind); // e.g. ["Tunnel Back","Cornered"]

    if (panel) {
        const key = def.id + '|' + pctVal + '|' + tags.join(',');
        if (panel.lastKey !== key) { // touch the DOM only when the readout changes
            panel.lastKey = key;
            panel.name.textContent = def.name;
            panel.tier.textContent = def.tier;
            panel.tier.style.color = TIER_COLORS[def.tier] || '#fff';
            panel.pct.textContent = pctVal + '%';
            panel.pct.style.color = chance >= 0.95 ? '#7fe8c9' : chance >= 0.7 ? '#ffd75e' : '#ff8a66';
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
        ringColor.lerpColors(RING_RISKY, RING_SURE, THREE.MathUtils.clamp((chance - 0.5) * 2, 0, 1));
        ring.mat.color.copy(ringColor);
        ring.mat.opacity = 0.55 + Math.sin(now * 5.5) * 0.15;
        ring.group.visible = true;
    }
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
    state.targetHover = null;
}
