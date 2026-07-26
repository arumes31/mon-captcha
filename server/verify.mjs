/* ============================================================
   monCAPTCHA — reference verification server

   Zero dependencies (node: built-ins only). Run:

     MC_KEYS='{"demo-site-key":{"secret":"demo-secret","origins":["http://localhost:8090"]}}' \
     node server/verify.mjs

   WHY THIS EXISTS
   ---------------
   The in-page token (src/security.js generateToken) is SHA-256 over values the
   client already knows, with a random nonce that is never transmitted, and
   CONFIG.PRIVATE_SALT ships to every browser inside src/config.js. A server
   receiving that token holds no secret and cannot distinguish it from any other
   32 bytes of hex. It is therefore not verifiable, and a widget that only moved
   it around would be decorative.

   This service issues a token the relying party CAN verify: an HMAC-SHA256 over
   a payload bound to the site key, the embedding origin, an expiry, and a
   single-use nonce. The signing secret never leaves the server.

   TWO ENDPOINTS
   -------------
     POST /issue       called by the CHALLENGE FRAME the moment the run is won.
                       Origin-checked against the site key. -> { token }
     POST /siteverify  called by the RELYING PARTY'S BACKEND, server to server,
                       with its shared secret. -> { success, ... }

   THREAT MODEL — read this before trusting it
   -------------------------------------------
   The challenge runs entirely in the visitor's browser, so nothing here proves
   a human played it: a bot can drive the page, or call /issue directly, and get
   a genuine signed token. That has not changed and is not fixable from here.
   What this design DOES buy you:

     * tokens cannot be forged or altered without the signing secret
     * a token is single-use, short-lived, and bound to one site key + origin,
       so it cannot be replayed, shared between sites, or banked in bulk
     * one /challenge mints exactly one token, so a caller cannot fetch a blob
       once and then mint offline for its lifetime
     * the world seed and the win threshold are chosen HERE and travel inside
       the signed challenge, so the client cannot pick a favourable world or
       lower the bar it has to clear
     * `points` is checked against that threshold, so it cannot be inflated —
       but it is still the client's own count, not an observed one
     * issuance is metered per IP and per site key, so bulk minting is at least
       rate limited (see MC_TRUST_PROXY — get that setting wrong and the per-IP
       half is bypassed by one request header)

   What none of that adds up to: a proof that captures happened. Every check
   above is a property of the TOKEN, plus one threshold on a number the client
   reports. To make the run itself checkable you would need the server to
   witness the captures — a signed receipt per catch, with a minimum interval
   the server derives from a distance it computed — and even then the property
   you gain is "a conforming client produced this transcript over N seconds of
   serialized wall clock", not "a human played". Those are different theorems
   and only the first is achievable in a browser. Price your reliance
   accordingly: use this as a cost multiplier, never as the sole control.

   The in-memory nonce and rate-limit stores are single-process. Behind more
   than one instance, back them with Redis or the equivalent — otherwise
   single-use is per-process and each replica re-grants the same token.
   ============================================================ */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const PORT = Number(process.env.MC_PORT || 8091);
const TOKEN_TTL_MS = Number(process.env.MC_TTL_MS || 120000);        // 2 minutes
const CHALLENGE_TTL_MS = Number(process.env.MC_CHALLENGE_TTL_MS || 300000); // 5 min to play
const ISSUE_PER_MIN = Number(process.env.MC_ISSUE_PER_MIN || 20);
const SITE_PER_MIN = Number(process.env.MC_SITE_PER_MIN || 240);
const MAX_BODY = 8192;

/* Win threshold. Must match CONFIG.CAPTURES_REQUIRED in src/config.js — the
   server is the one that decides it (it travels inside the signed challenge),
   the client only renders a counter. Per-key override: { required: N }. */
const DEFAULT_REQUIRED = Number(process.env.MC_REQUIRED || 6);

/* X-Forwarded-For is a request header: any client can set it to anything. The
   per-IP limiter is the only real meter this service has, so XFF is honoured
   ONLY when the operator states there is a proxy in front of us. Behind
   nginx/Caddy/Cloudflare set MC_TRUST_PROXY=1; exposed directly, leave it off
   or the limiter is bypassed by one header. */
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.MC_TRUST_PROXY || '');

/* Where the CHALLENGE itself is served from. /issue is called by the challenge
   frame, so this — not the customer's site — is what its Origin header carries. */
const CHALLENGE_ORIGINS = String(process.env.MC_CHALLENGE_ORIGINS || 'http://localhost:8080')
    .split(',').map((s) => s.trim()).filter(Boolean);

/* sitekey -> { secret, origins:[] }. Origins are the EMBEDDING sites allowed to
   use that key, as exact scheme://host[:port]. */
const KEYS = (() => {
    // A file is the practical option once there is more than one customer;
    // server/keygen.mjs writes and merges it. MC_KEYS (inline JSON) still wins
    // if both are set, so a container can override without touching the file.
    try {
        const raw = process.env.MC_KEYS;
        if (raw) return JSON.parse(raw);
    } catch (e) {
        console.error('[verify] MC_KEYS is not valid JSON — refusing to start with no keys');
        process.exit(1);
    }
    const file = process.env.MC_KEYS_FILE;
    if (file) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            console.error(`[verify] cannot read MC_KEYS_FILE=${file}: ${e.message}`);
            process.exit(1);
        }
    }
    console.warn('[verify] no MC_KEYS / MC_KEYS_FILE — using a DEMO key. Never do this in production.');
    console.warn('[verify] generate a real one: node server/keygen.mjs --origin https://your-customer.com');
    return { 'demo-site-key': { secret: 'demo-secret', origins: ['http://localhost:8090'] } };
})();

for (const [k, cfg] of Object.entries(KEYS)) {
    if (!cfg || typeof cfg.secret !== 'string' || !Array.isArray(cfg.origins)) {
        console.error(`[verify] site key "${k}" is malformed: expected { secret, origins: [] }`);
        process.exit(1);
    }
    if (cfg.required != null && !(Number.isInteger(cfg.required) && cfg.required > 0)) {
        console.error(`[verify] site key "${k}" has a bad "required": expected a positive integer`);
        process.exit(1);
    }
}

const requiredFor = (cfg) => (cfg.required != null ? cfg.required : DEFAULT_REQUIRED);

const b64u = (buf) => Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sign(payloadObj, secret) {
    const body = b64u(JSON.stringify(payloadObj));
    const mac = b64u(crypto.createHmac('sha256', secret).update(body).digest());
    return `${body}.${mac}`;
}

function verifySigned(token, secret) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return { ok: false, err: 'malformed' };
    const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
    let given;
    try { given = unb64u(parts[1]); } catch (e) { return { ok: false, err: 'malformed' }; }
    // Constant-time: length check first, then timingSafeEqual on equal lengths.
    if (given.length !== expected.length) return { ok: false, err: 'bad-signature' };
    if (!crypto.timingSafeEqual(given, expected)) return { ok: false, err: 'bad-signature' };
    try { return { ok: true, payload: JSON.parse(unb64u(parts[0]).toString('utf8')) }; }
    catch (e) { return { ok: false, err: 'malformed' }; }
}

/* ---- single-use nonces (replay protection) ----
   Two namespaces share the map, prefixed so they can never collide:
     'c:' challenge nonces, burned by /issue    — one challenge, one token
     't:' token nonces, burned by /siteverify   — one token, one verification */
const used = new Map();   // 'c:'|'t:' + nonce -> expiry ms
/* ---- crude issuance limiters ---- */
const buckets = new Map();     // ip -> { n, resetAt }
const siteBuckets = new Map(); // sitekey -> { n, resetAt }

setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of used) if (exp <= now) used.delete(k);
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    for (const [k, b] of siteBuckets) if (b.resetAt <= now) siteBuckets.delete(k);
}, 30000).unref();

function bump(map, key, limit) {
    const now = Date.now();
    let b = map.get(key);
    if (!b || b.resetAt <= now) { b = { n: 0, resetAt: now + 60000 }; map.set(key, b); }
    b.n++;
    return b.n <= limit;
}

/* Per-IP is spoofable the moment there is a proxy in front of us, and IPs are
   cheap to rent regardless. The per-sitekey bucket is the one an attacker
   cannot rotate away from: it caps a single customer's blast radius no matter
   how many addresses the caller has. Both must pass. */
function rateOk(ip, sitekey) {
    const ipOk = bump(buckets, ip, ISSUE_PER_MIN);
    const siteOk = sitekey ? bump(siteBuckets, sitekey, SITE_PER_MIN) : true;
    return ipOk && siteOk;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let n = 0; const chunks = [];
        req.on('data', (c) => {
            n += c.length;
            if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            const s = Buffer.concat(chunks).toString('utf8');
            if (!s) return resolve({});
            try { return resolve(JSON.parse(s)); } catch (e) { /* fall through to form */ }
            const out = {};
            for (const [k, v] of new URLSearchParams(s)) out[k] = v;
            resolve(out);
        });
        req.on('error', reject);
    });
}

function send(res, code, obj, extraHeaders) {
    const body = JSON.stringify(obj);
    res.writeHead(code, Object.assign({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    }, extraHeaders || {}));
    res.end(body);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const origin = req.headers.origin || '';

    if (url.pathname === '/health') return send(res, 200, { ok: true });

    /* ------- /challenge : customer's PAGE proves which domain it is -------

       This is what actually restricts a site key to its registered domains.

       The request is made by the widget running on the CUSTOMER'S page, so the
       browser stamps Origin with that page's real origin and page script cannot
       change it. We hand back a short-lived blob signed with the site key's
       secret, naming that origin. /issue will only mint a token for an origin
       that came out of one of these blobs — so the embedding domain is never
       taken from anything the client can assert.

       Copy a site key onto an unregistered domain and this endpoint refuses:
       the browser tells us where the request really came from.

       Limit, stated plainly: Origin is a browser guarantee, not a network one.
       A non-browser client (curl, a headless script) can send any Origin it
       likes. This stops cross-site and copied-key abuse from real browsers,
       which is the same guarantee reCAPTCHA/hCaptcha domain restriction gives —
       it is not a defence against a determined scripted attacker. */
    if (url.pathname === '/challenge') {
        if (req.method === 'OPTIONS') return send(res, 204, {}, corsForSite(origin));
        if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });

        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 413, { error: 'body-too-large' }); }

        const sitekey = String(body.sitekey || '');
        const cfg = KEYS[sitekey];
        if (!cfg) return send(res, 403, { error: 'invalid-sitekey' }, corsForSite(origin));
        if (!origin || !cfg.origins.includes(origin)) {
            return send(res, 403, { error: 'domain-not-allowed', sitekey }, corsForSite(origin));
        }

        const ip = clientIp(req);
        if (!rateOk(ip, sitekey)) return send(res, 429, { error: 'rate-limited' }, corsForSite(origin));

        const now = Date.now();
        const required = requiredFor(cfg);
        /* WE choose the world, not the client.
           src/config.js rollWorldSeed() honours ?seed=N ungated, so a client
           left to pick its own seed can replay a recorded winning run into the
           exact world it was recorded in — every timing and aim genuinely
           human, because it once was. Authoring the seed here makes it a
           server-held nonce instead, and is the prerequisite for any future
           check that re-derives the world (a spawn table, a throw audit).
           On its own it proves nothing; it stops the world being negotiable. */
        const seed = crypto.randomBytes(4).readUInt32BE(0) >>> 0;
        const challenge = sign({
            t: 'c', k: sitekey, o: origin, n: b64u(crypto.randomBytes(9)),
            seed, req: required,
            iat: now, exp: now + CHALLENGE_TTL_MS,
        }, cfg.secret);
        return send(res, 200, {
            challenge, seed, required, expires_in: Math.floor(CHALLENGE_TTL_MS / 1000),
        }, corsForSite(origin));
    }

    /* ---------------- /issue : challenge frame -> token ---------------- */
    if (url.pathname === '/issue') {
        // CORS is scoped to the origins registered for the site key, so the
        // preflight has to resolve the key before it can answer.
        if (req.method === 'OPTIONS') {
            return send(res, 204, {}, corsFor(origin));
        }
        if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });

        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 413, { error: 'body-too-large' }); }

        // Request Origin is the CHALLENGE host — this fetch comes from inside the
        // challenge frame, so it is the same for every customer and says nothing
        // about which site is embedding. It is checked only to keep issuance
        // reachable from our own frame and nowhere else.
        if (!CHALLENGE_ORIGINS.includes(origin)) {
            return send(res, 403, { error: 'bad-challenge-origin' }, corsFor(origin));
        }

        const sitekey = String(body.sitekey || '');
        const cfg = KEYS[sitekey];
        if (!cfg) return send(res, 403, { error: 'invalid-sitekey' }, corsFor(origin));

        /* The embedding origin comes out of the /challenge blob — which WE
           signed, after the browser told us the customer page's real origin.
           It is never read from the request body, so a caller cannot name a
           domain it does not actually run on. */
        const ch = verifySigned(body.challenge, cfg.secret);
        if (!ch.ok || ch.payload.t !== 'c' || ch.payload.k !== sitekey) {
            return send(res, 403, { error: 'invalid-challenge' }, corsFor(origin));
        }
        if (!ch.payload.exp || Date.now() > ch.payload.exp) {
            return send(res, 403, { error: 'challenge-expired' }, corsFor(origin));
        }
        const siteOrigin = ch.payload.o;
        if (!cfg.origins.includes(siteOrigin)) {
            return send(res, 403, { error: 'domain-not-allowed' }, corsFor(origin));
        }

        const ip = clientIp(req);
        if (!rateOk(ip, sitekey)) return send(res, 429, { error: 'rate-limited' }, corsFor(origin));

        /* One challenge, one token. Without this a single /challenge blob mints
           tokens for its whole lifetime, so an attacker fetches one and then
           needs no further round trip to that endpoint at all. Burned AFTER the
           rate check so a throttled caller does not lose its challenge. */
        const chKey = `c:${ch.payload.n}`;
        if (!ch.payload.n || used.has(chKey)) {
            return send(res, 403, { error: 'challenge-already-used' }, corsFor(origin));
        }
        used.set(chKey, ch.payload.exp);

        /* The win threshold comes out of the challenge WE signed, never from the
           request. `points` is still a client claim — nothing here witnessed the
           captures — but it can no longer be inflated to an arbitrary score,
           and a caller cannot lower the bar it has to clear. */
        const required = Number(ch.payload.req) || DEFAULT_REQUIRED;
        const points = Number(body.points) || 0;
        if (!(points >= required)) {
            return send(res, 403, { error: 'insufficient-points', required }, corsFor(origin));
        }

        const now = Date.now();
        const token = sign({
            k: sitekey,
            o: siteOrigin,
            n: b64u(crypto.randomBytes(12)),
            iat: now,
            exp: now + TOKEN_TTL_MS,
            p: points,
            req: required,
            // The seed is ours, from the signed challenge — body.seed is ignored.
            s: ch.payload.seed == null ? null : String(ch.payload.seed),
        }, cfg.secret);

        return send(res, 200, { token, expires_in: Math.floor(TOKEN_TTL_MS / 1000) }, corsFor(origin));
    }

    /* ------------- /siteverify : relying party backend -> yes/no ------------- */
    if (url.pathname === '/siteverify') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 413, { error: 'body-too-large' }); }

        const errs = [];
        const secret = String(body.secret || '');
        const response = String(body.response || '');
        if (!secret) errs.push('missing-input-secret');
        if (!response) errs.push('missing-input-response');
        if (errs.length) return send(res, 200, { success: false, 'error-codes': errs });

        // Find the site key this secret belongs to. Compared in constant time so
        // the endpoint does not leak which secrets exist.
        let sitekey = null;
        const given = Buffer.from(secret);
        for (const [k, cfg] of Object.entries(KEYS)) {
            const want = Buffer.from(cfg.secret);
            if (want.length === given.length && crypto.timingSafeEqual(want, given)) { sitekey = k; break; }
        }
        if (!sitekey) return send(res, 200, { success: false, 'error-codes': ['invalid-input-secret'] });

        const v = verifySigned(response, KEYS[sitekey].secret);
        if (!v.ok) return send(res, 200, { success: false, 'error-codes': ['invalid-input-response'] });

        const p = v.payload;
        if (p.k !== sitekey) return send(res, 200, { success: false, 'error-codes': ['sitekey-mismatch'] });
        if (!p.exp || Date.now() > p.exp) return send(res, 200, { success: false, 'error-codes': ['timeout-or-duplicate'] });
        if (used.has(`t:${p.n}`)) return send(res, 200, { success: false, 'error-codes': ['timeout-or-duplicate'] });
        used.set(`t:${p.n}`, p.exp);   // burn it: one token, one verification

        let hostname = '';
        try { hostname = new URL(p.o).hostname; } catch (e) { hostname = p.o || ''; }

        return send(res, 200, {
            success: true,
            challenge_ts: new Date(p.iat).toISOString(),
            hostname,
            points: p.p,
            required: p.req == null ? null : p.req,
            /* Say plainly where `points` came from. The server checked it against
               a threshold it authored, and nothing more: no capture was observed
               server-side, so this is the client's own count. Do not read it as
               a measure of effort or of humanity. */
            points_source: 'client-asserted',
            seed: p.s,
        });
    }

    send(res, 404, { error: 'not-found' });
});

function cors(origin) {
    return {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-max-age': '600',
        'vary': 'Origin',
    };
}

/* /issue is only ever called from the challenge frame, so the only origins
   worth reflecting there are the hosts the challenge itself is served from. */
function corsFor(origin) {
    if (!origin || !CHALLENGE_ORIGINS.includes(origin)) return {};
    return cors(origin);
}

/* /challenge is called from a CUSTOMER's page, so it reflects origins that are
   registered against some site key — and nothing else. An unregistered domain
   gets no CORS headers at all, so the browser blocks it even before our 403. */
function corsForSite(origin) {
    if (!origin) return {};
    const known = Object.values(KEYS).some((c) => c.origins.includes(origin));
    return known ? cors(origin) : {};
}

function clientIp(req) {
    if (TRUST_PROXY) {
        const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        if (fwd) return fwd;
    }
    return req.socket.remoteAddress || 'unknown';
}

server.listen(PORT, () => {
    console.log(`[verify] listening on :${PORT}`);
    console.log(`[verify] site keys: ${Object.keys(KEYS).join(', ')}`);
});
