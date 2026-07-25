/* ============================================================
   Monster CAPTCHA — persistence + credential primitives

   A JSON file, written atomically, holding accounts, site keys and sessions.
   Deliberately dependency-free to match the rest of the project; swap this one
   module for a real database and nothing else has to change.

   WHAT IS AND IS NOT STORED
   -------------------------
   Passwords: scrypt hash + per-user salt. Never recoverable.

   Site-key SECRETS: scrypt hash only. The plaintext is shown once, at creation
   or rotation, and then it is gone — we cannot print it again and neither can
   anyone who steals the file. That is possible because the secret is only ever
   COMPARED (to authenticate /siteverify), never used to sign anything:
   challenges and tokens are signed with the server's own master key
   (MC_SIGNING_KEY). A store leak therefore exposes no customer credential and
   no token-forging ability.

   Sessions: random 32-byte ids, server-side, with an absolute expiry.
   ============================================================ */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.MC_STORE || path.join(process.cwd(), 'server', 'store.json');
const SESSION_TTL_MS = Number(process.env.MC_SESSION_TTL_MS || 12 * 3600 * 1000);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const EMPTY = { users: {}, keys: {}, sessions: {} };
let db = null;

function load() {
    if (db) return db;
    try {
        db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        for (const k of Object.keys(EMPTY)) if (!db[k]) db[k] = {};
    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.error(`[store] ${FILE} exists but is unreadable: ${e.message}`);
            process.exit(1);
        }
        db = JSON.parse(JSON.stringify(EMPTY));
    }
    return db;
}

/* Atomic: write a sibling temp file then rename, so a crash mid-write cannot
   truncate the store. 0600 because it holds password and secret hashes. */
function save() {
    const dir = path.dirname(FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.store.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, FILE);
}

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const rand = (n) => crypto.randomBytes(n).toString('base64url');

/* ---------- password / secret hashing ---------- */
function scrypt(pw, salt) {
    return crypto.scryptSync(String(pw), Buffer.from(salt, 'base64url'), SCRYPT.keylen, {
        N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
        // scrypt needs memory ~128*N*r; raise the default cap so N=16384 fits.
        maxmem: 256 * SCRYPT.N * SCRYPT.r,
    });
}

export function hashSecret(plain) {
    const salt = rand(16);
    return `s1$${salt}$${b64u(scrypt(plain, salt))}`;
}

export function verifySecret(plain, stored) {
    if (typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 's1') return false;
    let want, got;
    try {
        want = Buffer.from(parts[2], 'base64url');
        got = scrypt(plain, parts[1]);
    } catch (e) { return false; }
    return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/* ---------- accounts ---------- */
export function createUser(email, password) {
    const d = load();
    const id = String(email).trim().toLowerCase();
    if (!id || d.users[id]) return null;         // caller reports this generically
    d.users[id] = { email: id, pw: hashSecret(password), createdAt: Date.now() };
    save();
    return d.users[id];
}

export function authUser(email, password) {
    const d = load();
    const u = d.users[String(email).trim().toLowerCase()];
    // Hash even when the account is absent, so a missing user and a wrong
    // password take the same time and cannot be told apart by timing.
    const ref = u ? u.pw : 's1$AAAAAAAAAAAAAAAAAAAAAA$AAAA';
    const ok = verifySecret(password, ref);
    return ok && u ? u : null;
}

export function getUser(email) { return load().users[String(email || '').toLowerCase()] || null; }

/* ---------- sessions ---------- */
export function newSession(email) {
    const d = load();
    const sid = rand(32);
    d.sessions[sid] = { email, exp: Date.now() + SESSION_TTL_MS, csrf: rand(24) };
    save();
    return { sid, csrf: d.sessions[sid].csrf };
}

export function getSession(sid) {
    if (!sid) return null;
    const d = load();
    const s = d.sessions[sid];
    if (!s) return null;
    if (s.exp <= Date.now()) { delete d.sessions[sid]; save(); return null; }
    return s;
}

export function dropSession(sid) {
    const d = load();
    if (d.sessions[sid]) { delete d.sessions[sid]; save(); }
}

export function sweepSessions() {
    const d = load();
    const now = Date.now();
    let n = 0;
    for (const [sid, s] of Object.entries(d.sessions)) if (s.exp <= now) { delete d.sessions[sid]; n++; }
    if (n) save();
    return n;
}

/* ---------- site keys ---------- */
export function normaliseOrigin(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // Exact scheme://host[:port]; anything else would never match a browser's
    // Origin header and would silently fail at /challenge.
    return u.origin;
}

export function listKeys(email) {
    const d = load();
    return Object.entries(d.keys)
        .filter(([, k]) => k.owner === email)
        .map(([id, k]) => ({ sitekey: id, origins: k.origins, label: k.label, createdAt: k.createdAt }))
        .sort((a, b) => b.createdAt - a.createdAt);
}

export function getKey(sitekey) { return load().keys[sitekey] || null; }

export function createKey(email, label, origins) {
    const d = load();
    const slug = String(label || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 24) || 'site';
    const sitekey = `mc_${slug}_${rand(9)}`;
    const secret = `mcs_${rand(32)}`;
    d.keys[sitekey] = {
        owner: email, label: String(label || '').slice(0, 60), origins,
        secretHash: hashSecret(secret), createdAt: Date.now(),
    };
    save();
    return { sitekey, secret };   // secret returned ONCE, never stored in the clear
}

export function updateOrigins(email, sitekey, origins) {
    const d = load();
    const k = d.keys[sitekey];
    if (!k || k.owner !== email) return false;
    k.origins = origins;
    save();
    return true;
}

export function rotateSecret(email, sitekey) {
    const d = load();
    const k = d.keys[sitekey];
    if (!k || k.owner !== email) return null;
    const secret = `mcs_${rand(32)}`;
    k.secretHash = hashSecret(secret);
    k.rotatedAt = Date.now();
    save();
    return secret;
}

export function deleteKey(email, sitekey) {
    const d = load();
    const k = d.keys[sitekey];
    if (!k || k.owner !== email) return false;
    delete d.keys[sitekey];
    save();
    return true;
}

/* Find the site key a presented secret authenticates, for /siteverify. Walks
   every key because the secret carries no hint of which one it belongs to. */
export function keyForSecret(secret) {
    const d = load();
    for (const [id, k] of Object.entries(d.keys)) {
        if (verifySecret(secret, k.secretHash)) return { sitekey: id, ...k };
    }
    return null;
}

export function reload() { db = null; return load(); }
export function storePath() { return FILE; }
