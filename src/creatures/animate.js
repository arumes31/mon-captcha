/* ============================================================
   Creature Animation
   ------------------------------------------------------------
   Per-archetype secondary animation: walk/hop/fly/slither/swim
   cycles, wing flaps, tail wags, claw snips — plus shared idle
   life (eye blinks). Split out of behavior.js so the movement
   engine and the animation layer stay under the size budget.
   Only transforms are animated: materials are shared caches.
   ============================================================ */

export function animateCreature(c, elapsed, mul, hopK) {
    const ud = c.group.userData;
    const def = c.def;
    const move = Math.min(1, mul);
    const walkT = elapsed * (3 + def.speed * 5) + c.phase;

    switch (def.plan) {
        case 'slime': {
            const k = (def.gait && def.gait.t === 'hop') ? hopK : move * Math.abs(Math.sin(elapsed * 8 + c.phase));
            ud.body.scale.y = 0.82 + k * 0.4;       // stretch in the air,
            ud.body.scale.x = 1.15 - k * 0.25;      // squash on the ground
            ud.body.scale.z = 1.15 - k * 0.25;
            break;
        }
        case 'bunny': {
            const k = (def.gait && def.gait.t === 'hop') ? hopK : move * Math.abs(Math.sin(elapsed * 7 + c.phase));
            ud.body.rotation.x = -k * 0.3;
            ud.head.rotation.x = k * 0.2;
            ud.ears[0].rotation.x = 0.1 + k * 0.45; // ears flop back mid-hop
            ud.ears[1].rotation.x = 0.1 + k * 0.5;
            ud.legs[0].rotation.x = k * 0.9;        // hind feet kick
            ud.legs[1].rotation.x = k * 0.9;
            if (c.taunting || move < 0.05) ud.head.rotation.y = Math.sin(elapsed * 0.7 + c.phase) * 0.4; // look around
            else ud.head.rotation.y = 0;
            break;
        }
        case 'fox': {
            for (let i = 0; i < 4; i++) { // diagonal trot pairs
                const ph = (i === 0 || i === 3) ? 0 : Math.PI;
                ud.legs[i].rotation.x = Math.sin(walkT * 2 + ph) * 0.55 * move;
            }
            ud.tail[0].rotation.y = Math.sin(elapsed * 5 + c.phase) * 0.3;       // tail wag
            ud.tail[1].rotation.y = Math.sin(elapsed * 5 + c.phase + 0.6) * 0.45;
            ud.head.rotation.y = move < 0.05 ? Math.sin(elapsed * 0.8 + c.phase) * 0.5 : 0; // look-around
            ud.body.position.y = 0.34 + Math.abs(Math.sin(walkT * 2)) * 0.02 * move;
            break;
        }
        case 'bird': {
            const flap = Math.sin(elapsed * 13 + c.phase) * (0.35 + move * 0.45);
            ud.wings[0].rotation.z = 0.25 + flap;
            ud.wings[1].rotation.z = -0.25 - flap;
            ud.tail.rotation.x = -0.3 + Math.sin(elapsed * 3 + c.phase) * 0.12;
            ud.head.rotation.y = Math.sin(elapsed * 1.1 + c.phase) * 0.3;
            break;
        }
        case 'duck': {
            c.group.rotation.z = Math.sin(elapsed * 3 + c.phase) * 0.06 * (0.4 + move); // paddling rock
            const dip = (elapsed * 0.14 + c.phase) % 1;                                  // dabble cycle
            c.group.rotation.x = dip < 0.12 ? Math.sin((dip / 0.12) * Math.PI) * 0.42 : 0;
            ud.tail.rotation.z = dip < 0.12 ? Math.sin(elapsed * 16) * 0.35 : 0;         // tail waggle while dabbling
            ud.head.rotation.y = dip >= 0.12 ? Math.sin(elapsed * 0.9 + c.phase) * 0.5 : 0;
            break;
        }
        case 'frog': {
            ud.legs[0].scale.z = 1 + hopK * 0.8;    // rear legs extend mid-leap
            ud.legs[1].scale.z = 1 + hopK * 0.8;
            const croak = Math.max(0, Math.sin(elapsed * 5.5 + c.phase)) * (1 - hopK);
            ud.throat.scale.set(1 + croak * 0.35, 1 + croak * 0.45, 1 + croak * 0.35); // vocal sac
            break;
        }
        case 'spider': {
            for (let i = 0; i < 8; i++) { // alternating-tetrapod scuttle
                const ph = (i % 2) * Math.PI;
                ud.legs[i].rotation.x = Math.sin(walkT * 2.4 + ph + (i % 4) * 0.4) * 0.5 * move;
            }
            ud.body.position.y = 0.24 + (c.taunting
                ? Math.abs(Math.sin(elapsed * 6)) * 0.08   // menacing bob taunt
                : Math.abs(Math.sin(walkT * 2.4)) * 0.02 * move);
            break;
        }
        case 'golem': {
            if (c.lookFrozen) break; // statue-still while watched
            const sway = Math.sin(walkT) * 0.5 * move;
            if (c.taunting) { // raises both arms and rumbles
                ud.arms[0].rotation.x = -1.1 + Math.sin(elapsed * 3) * 0.15;
                ud.arms[1].rotation.x = -1.1 - Math.sin(elapsed * 3) * 0.15;
            } else {
                ud.arms[0].rotation.x = sway;
                ud.arms[1].rotation.x = -sway;
            }
            ud.legs[0].position.y = 0.14 + Math.max(0, sway) * 0.1;
            ud.legs[1].position.y = 0.14 + Math.max(0, -sway) * 0.1;
            c.group.rotation.z = sway * 0.08;
            ud.head.rotation.y = move < 0.05 && !c.taunting ? Math.sin(elapsed * 0.5 + c.phase) * 0.4 : 0;
            break;
        }
        case 'crab': {
            for (let i = 0; i < 4; i++) {
                ud.legs[i].rotation.x = Math.sin(walkT * 3 + i * Math.PI * 0.5) * 0.45 * move;
            }
            const snip = c.scaredUntil > elapsed ? Math.sin(elapsed * 14) * 0.4 : Math.sin(elapsed * 2.2 + c.phase) * 0.15;
            ud.claws[1].rotation.y = 0.2 + snip;    // claws snip faster when scared
            ud.claws[3].rotation.y = -0.2 - snip;
            break;
        }
        case 'turtle': {
            for (let i = 0; i < 4; i++) {
                ud.legs[i].rotation.x = Math.sin(walkT * 1.2 + (i % 2) * Math.PI) * 0.35 * move;
                ud.legs[i].scale.y = 1 - c.hideK * 0.7;   // legs tuck when hiding
            }
            ud.head.position.z = 0.32 - c.hideK * 0.16;   // head retracts into shell
            ud.head.scale.setScalar(1 - c.hideK * 0.5);
            ud.tail.rotation.y = Math.sin(elapsed * 2 + c.phase) * 0.3 * move;
            if (def.aquatic) c.group.rotation.z = Math.sin(elapsed * 1.1 + c.phase) * 0.04; // gentle raft sway
            break;
        }
        case 'snail': {
            ud.body.scale.z = 1 + Math.sin(walkT * 1.5) * 0.16 * move; // creeping stretch
            ud.stalks[0].rotation.z = Math.sin(elapsed * 1.6 + c.phase) * 0.25;
            ud.stalks[1].rotation.z = Math.sin(elapsed * 1.6 + c.phase + 1.2) * 0.25;
            ud.shell[1].rotation.y = 0.3 + Math.sin(elapsed * 0.9 + c.phase) * 0.08; // shell wobble
            break;
        }
        case 'ghost': {
            ud.body.rotation.y = Math.sin(elapsed * 1.3 + c.phase) * 0.2;
            ud.arms[0].rotation.z = 0.5 + Math.sin(elapsed * 2.2 + c.phase) * 0.25;
            ud.arms[1].rotation.z = -0.5 - Math.sin(elapsed * 2.2 + c.phase + 0.8) * 0.25;
            for (let i = 0; i < 3; i++) {
                ud.wisps[i].rotation.x = Math.sin(elapsed * 2.5 + c.phase + i * 1.4) * 0.3;
                ud.wisps[i].position.x = Math.sin(elapsed * 1.7 + i * 2.1) * 0.05;
            }
            break;
        }
        case 'dragon': {
            const flap = Math.sin(elapsed * 9 + c.phase) * 0.85;
            ud.wings[0].rotation.z = 0.2 + flap;
            ud.wings[1].rotation.z = -0.2 - flap;
            ud.tail[0].rotation.y = Math.sin(elapsed * 4 + c.phase) * 0.25;      // tail undulates
            ud.tail[1].rotation.y = Math.sin(elapsed * 4 + c.phase + 0.9) * 0.4;
            ud.head.rotation.x = Math.sin(elapsed * 2 + c.phase) * 0.12;
            break;
        }
        case 'mushroom': {
            c.group.rotation.z = Math.sin(walkT * 1.6) * 0.12 * move;            // waddle rock
            ud.legs[0].position.y = 0.035 + Math.max(0, Math.sin(walkT * 1.6)) * 0.05 * move;
            ud.legs[1].position.y = 0.035 + Math.max(0, -Math.sin(walkT * 1.6)) * 0.05 * move;
            const capDrop = c.hideK * 0.14;                                       // cap pulls down to hide
            ud.cap.position.y = 0.42 - capDrop + Math.abs(Math.sin(walkT * 1.6)) * 0.02 * move;
            ud.capTop.position.y = 0.53 - capDrop;
            for (const sp of ud.spots) sp.position.y = (sp === ud.spots[2] ? 0.49 : 0.5) - capDrop;
            break;
        }
        case 'beetle': {
            for (let i = 0; i < 4; i++) {
                ud.legs[i].rotation.x = Math.sin(walkT * 3.4 + (i % 2) * Math.PI) * 0.4 * move;
            }
            ud.shell[0].rotation.z = -0.05 - move * 0.1;  // elytra flare when hustling
            ud.shell[1].rotation.z = 0.05 + move * 0.1;
            ud.head.rotation.y = Math.sin(elapsed * 1.3 + c.phase) * 0.2;
            break;
        }
        case 'swarm': {
            // each gnat jitters around its home offset; the cloud tightens when
            // still, loosens (spreads) when the swarm is moving/fleeing
            if (ud.motes) {
                const spread = 1 + move * 0.6;
                for (let i = 0; i < ud.motes.length; i++) {
                    const m = ud.motes[i], h = m.userData.home, ph = m.userData.ph;
                    m.position.x = h.x * spread + Math.sin(elapsed * 6 + ph) * 0.06;
                    m.position.y = h.y + Math.sin(elapsed * 7.3 + ph * 1.7) * 0.06;
                    m.position.z = h.z * spread + Math.cos(elapsed * 5.4 + ph) * 0.06;
                }
            }
            break;
        }
        case 'jelly': {
            const k = (def.gait && def.gait.t === 'pulse') ? c.pulseK : Math.max(0, Math.sin(elapsed * 2 + c.phase));
            ud.body.scale.set(1.12 - k * 0.2, 0.8 + k * 0.45, 1.12 - k * 0.2);   // medusa contraction
            for (let i = 0; i < 4; i++) {
                ud.tentacles[i].rotation.x = Math.sin(elapsed * 2.4 + c.phase + i * 1.5) * 0.3;
                ud.tentacles[i].rotation.z = Math.cos(elapsed * 2.1 + i * 1.1) * 0.2;
            }
            break;
        }
        case 'fish': {
            const beat = elapsed * (5 + def.speed * 4) + c.phase;
            ud.tail.rotation.y = Math.sin(beat) * (0.35 + move * 0.35);           // sculling tail
            ud.body.rotation.y = Math.sin(beat) * 0.08 * (0.4 + move);
            ud.fins[0].rotation.z = 0.4 + Math.sin(beat + 1.2) * 0.25;
            ud.fins[1].rotation.z = -0.4 - Math.sin(beat + 1.6) * 0.25;
            // leap pitch: nose up out of the water, nose down into the entry
            c.group.rotation.x = c.leapK > 0 ? (c.leapK * 2 - 1) * 0.85 : Math.sin(elapsed * 1.4 + c.phase) * 0.05;
            break;
        }
        case 'otter': {
            const paddle = elapsed * 7 + c.phase;
            c.group.rotation.z = Math.sin(paddle * 0.5) * 0.1 * (0.3 + move);     // playful roll
            ud.paws[0].rotation.x = Math.sin(paddle) * 0.6 * move;
            ud.paws[1].rotation.x = Math.sin(paddle + Math.PI) * 0.6 * move;
            ud.tail.rotation.y = Math.sin(paddle * 0.6) * 0.35;                   // rudder sweep
            ud.head.rotation.y = move < 0.1 ? Math.sin(elapsed * 1.1 + c.phase) * 0.5 : 0;
            ud.head.rotation.x = move < 0.1 ? Math.sin(elapsed * 2.3 + c.phase) * 0.12 : 0;
            break;
        }
        case 'dragonfly': {
            const buzz = Math.sin(elapsed * 46 + c.phase);                        // wing blur flick
            ud.wings[0].rotation.z = 0.15 + buzz * 0.5;
            ud.wings[1].rotation.z = -0.15 - buzz * 0.5;
            ud.wings[2].rotation.z = 0.1 - buzz * 0.42;
            ud.wings[3].rotation.z = -0.1 + buzz * 0.42;
            ud.tail.rotation.x = 0.05 + Math.sin(elapsed * 3.2 + c.phase) * 0.14; // abdomen flexes
            c.group.rotation.x = -move * 0.35;                                    // darts nose-down
            break;
        }
        case 'owl': {
            const flap = Math.sin(elapsed * 6.5 + c.phase) * (0.15 + move * 0.75); // slow deep strokes
            ud.wings[0].rotation.z = 0.2 + flap;
            ud.wings[1].rotation.z = -0.2 - flap;
            ud.tail.rotation.x = -0.35 - move * 0.2;
            // trademark head swivel while perched-still
            ud.head.rotation.y = move < 0.08 ? Math.sin(elapsed * 0.6 + c.phase) * 1.1 : 0;
            c.group.rotation.x = -move * 0.2;                                     // leans into the glide
            break;
        }
        case 'bat': {
            const l = Math.sin(elapsed * 17 + c.phase);                           // frantic uneven strokes
            const r2 = Math.sin(elapsed * 17 + c.phase + 0.7);
            ud.wings[0].rotation.z = 0.3 + l * 0.8;
            ud.wings[1].rotation.z = -0.3 - r2 * 0.8;
            ud.wingTips[0].rotation.z = 0.5 + l * 1.0;
            ud.wingTips[1].rotation.z = -0.5 - r2 * 1.0;
            c.group.rotation.z = (l - r2) * 0.18;                                 // lurching roll
            break;
        }
        case 'hummingbird': {
            const blur = Math.sin(elapsed * 60 + c.phase);                        // wing blur
            ud.wings[0].rotation.z = blur * 0.9;
            ud.wings[1].rotation.z = -blur * 0.9;
            ud.tail.rotation.x = -0.35 + Math.sin(elapsed * 8 + c.phase) * 0.2;   // tail fans
            c.group.rotation.x = -move * 0.4 + 0.08;                              // tips forward to dash
            break;
        }
        case 'phoenix': {
            const flap = Math.sin(elapsed * 4.2 + c.phase) * (0.5 + move * 0.35); // grand slow strokes
            ud.wings[0].rotation.z = 0.15 + flap;
            ud.wings[1].rotation.z = -0.15 - flap;
            ud.wingTips[0].rotation.z = 0.25 + flap * 1.35;
            ud.wingTips[1].rotation.z = -0.25 - flap * 1.35;
            for (let i = 0; i < 3; i++) {                                         // plume tails ripple
                ud.tail[i].rotation.y = Math.sin(elapsed * 2.2 + c.phase + i * 1.1) * 0.3;
                ud.tail[i].rotation.x = 0.25 + Math.sin(elapsed * 1.7 + i * 0.9) * 0.15;
            }
            ud.head.rotation.x = Math.sin(elapsed * 1.4 + c.phase) * 0.12;
            ud.crest[0].rotation.x = -0.4 + Math.sin(elapsed * 3.1 + c.phase) * 0.2;
            break;
        }
        case 'elk': {
            for (let i = 0; i < 4; i++) { // heavy diagonal walk
                const ph = (i === 0 || i === 3) ? 0 : Math.PI;
                ud.legs[i].rotation.x = Math.sin(walkT * 1.3 + ph) * 0.4 * move;
            }
            // grazes head-down when idle, proud head-high when moving
            ud.head.rotation.x = move < 0.05
                ? 0.55 + Math.sin(elapsed * 0.9 + c.phase) * 0.1
                : -0.05 + Math.sin(walkT * 1.3) * 0.05;
            ud.tail.rotation.y = Math.sin(elapsed * 4 + c.phase) * 0.3;
            c.group.rotation.z = Math.sin(walkT * 1.3) * 0.02 * move;             // ponderous sway
            break;
        }
    }

    // Idle life: blinks via eye scale (shared across all archetypes)
    if (ud.eyes && ud.eyes.length) {
        if (elapsed > c.nextBlink) {
            c.blinkUntil = elapsed + 0.12;
            c.nextBlink = elapsed + 2.4 + Math.random() * 3.4;
        }
        const bs = elapsed < c.blinkUntil ? 0.12 : 1;
        for (const eye of ud.eyes) eye.scale.y = bs;
    }
}
