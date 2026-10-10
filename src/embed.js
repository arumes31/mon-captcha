/* ============================================================
   Embed bridge — the game side of the cross-origin widget protocol.

   Loaded always, active ONLY when the page is opened with ?embed=1 inside a
   frame. On the standalone page every function here early-returns, so the
   normal experience is byte-identical.

   HANDSHAKE (why it works this way)
   ---------------------------------
   The frame must send the solve token to exactly one origin and never to '*'.
   It cannot take that origin from its own URL: a query parameter is attacker-
   controlled, so trusting ?origin= would let a malicious embedder name someone
   else's site as the recipient.

   Instead the parent's origin is LEARNED from the browser:

     1. frame  -> '*'      { type: 'ready' }        (carries no secret)
     2. parent -> frame    { type: 'handshake' }    (browser stamps event.origin)
     3. frame  records event.origin, and every later message goes only there.

   Step 2's event.origin is set by the browser and cannot be forged by page
   script, so it is the one trustworthy statement of who is embedding us. A
   hostile embedder can still frame the widget, but then it IS the parent and
   only ever receives a token minted for its own origin — which the verification
   server binds to the sitekey and rejects for anyone else.

   The token itself is issued by the verification server (server/verify.mjs), not
   here: see docs/INTEGRATION.md. Without that server the message still arrives,
   but it proves nothing — a bot can post the same message itself.
   ============================================================ */

import { state } from './state.js';
import { CONFIG } from './config.js';

export const EMBED_PROTOCOL = 'monster-captcha';
export const EMBED_VERSION = 1;

let _active = false;
let _parentOrigin = null;   // learned in the handshake; null until then
let _pending = [];          // messages raised before the handshake landed
let _widgetId = null;       // opaque id echoed back so a page can host several
let _challenge = null;      // opaque server-signed proof of the embedding domain

function params() {
    try { return new URLSearchParams(window.location.search); } catch (e) { return null; }
}

/* Embedded == explicitly asked for it AND actually framed. Both, so that opening
   the ?embed=1 URL directly in a tab does not leave the game waiting on a
   handshake that can never arrive. */
export function isEmbedded() {
    const p = params();
    if (!p || !/^(1|true|yes)$/i.test(p.get('embed') || '')) return false;
    try { return window.parent && window.parent !== window; } catch (e) { return true; }
}

function send(msg, origin) {
    const target = origin || _parentOrigin;
    if (!target) { _pending.push(msg); return; }
    try {
        window.parent.postMessage({
            source: EMBED_PROTOCOL, v: EMBED_VERSION, widgetId: _widgetId, ...msg,
        }, target);
    } catch (e) { /* frame torn down mid-flight */ }
}

function flush() {
    if (!_parentOrigin) return;
    const q = _pending; _pending = [];
    for (const m of q) send(m);
}

function onMessage(ev) {
    const d = ev.data;
    if (!d || d.source !== EMBED_PROTOCOL || typeof d.type !== 'string') return;
    // Only the frame's real parent may drive us.
    try { if (ev.source !== window.parent) return; } catch (e) { return; }

    if (d.type === 'handshake') {
        // The browser sets ev.origin. This is the only place the parent origin
        // is ever established, and it is deliberately not re-assignable
        // afterwards: a second handshake from a different origin is ignored.
        if (_parentOrigin && ev.origin !== _parentOrigin) return;
        _parentOrigin = ev.origin;
        if (d.widgetId) _widgetId = d.widgetId;
        // Server-signed proof of which domain is embedding us, obtained by the
        // widget from the customer's own page (see /challenge in verify.mjs).
        // We only carry it; we cannot read or forge what is inside.
        if (typeof d.challenge === 'string') _challenge = d.challenge;
        send({ type: 'accepted', seed: CONFIG.WORLD_SEED, required: CONFIG.CAPTURES_REQUIRED });
        flush();
        return;
    }
    if (!_parentOrigin || ev.origin !== _parentOrigin) return;

    if (d.type === 'reset') {
        try {
            window.__captcha && window.__captcha.destroy();
            window.__captcha && window.__captcha.init();
        } catch (e) { send({ type: 'error', message: 'reset failed' }); }
        return;
    }
    if (d.type === 'ping') send({ type: 'pong' });
}

/* Exchange the in-page result for a server-signed token.

   The in-page token proves nothing (see server/verify.mjs): it is a hash of
   values the client already holds, and no secret is involved, so a relying
   party cannot check it. When ?verify= names an issuer, the FRAME calls it
   directly — browser-set Origin binds the token to this embedding site — and
   the signed token is what reaches the host page.

   Returns null when no issuer is configured or the call fails; the caller then
   falls back to the unverifiable token and says so in the message. */
async function issueSignedToken() {
    const p = params();
    const base = p && p.get('verify');
    // No challenge means the widget could not prove its domain, so /issue would
    // refuse anyway. Skip the round trip and fall back to the unverifiable path.
    if (!base || !_challenge) return null;
    let url;
    try {
        url = new URL('/issue', base);
        if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
            return null; // never ship a token over plaintext to a remote host
        }
    } catch (e) { return null; }
    try {
        const res = await fetch(url.toString(), {
            method: 'POST',
            mode: 'cors',
            credentials: 'omit',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                sitekey: (p && p.get('sitekey')) || '',
                // The embedding domain is NOT asserted here — it is inside the
                // signed challenge, put there by the server after the browser
                // told it the customer page's real origin. This request's own
                // Origin header is always the challenge host, so it could never
                // identify the customer.
                challenge: _challenge,
                points: state.creaturesCaught,
                // No seed: the issuer authored it and reads its own copy out of
                // the signed challenge. Sending ours would only be a claim, and
                // it is ignored on the far side.
            }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data && typeof data.token === 'string' ? data.token : null;
    } catch (e) { return null; }
}

/* Called from capture.js the moment the run is won. */
export async function emitEmbedSolved(token) {
    if (!_active) return;
    const signed = await issueSignedToken();
    send({
        type: 'solved',
        token: signed || token || null,
        // Tells the host whether this token can actually be checked server-side.
        // false means no issuer was configured: treat the result as decorative.
        verified: !!signed,
        points: state.creaturesCaught,
        required: CONFIG.CAPTURES_REQUIRED,
        seed: CONFIG.WORLD_SEED,
    });
}

/* The player dismissed the challenge without finishing it. */
export function emitEmbedClosed(reason) {
    if (!_active) return;
    send({ type: 'closed', reason: reason || 'dismissed' });
}

export function emitEmbedError(message) {
    if (!_active) return;
    send({ type: 'error', message: String(message || 'unknown') });
}

export function initEmbed() {
    if (_active || !isEmbedded()) return;
    _active = true;
    const p = params();
    _widgetId = (p && p.get('widget')) || null;

    window.addEventListener('message', onMessage, false);

    // Carries nothing secret, so '*' is correct here — it is the only way to
    // reach a parent whose origin we do not yet know. Everything after the
    // handshake is addressed to the learned origin.
    send({ type: 'ready' }, '*');

    // Tell the host if the player closes the tab/frame mid-challenge, so the
    // widget can drop back to its unsolved state instead of hanging.
    window.addEventListener('pagehide', () => emitEmbedClosed('unload'), false);
}

export function embedActive() { return _active; }
