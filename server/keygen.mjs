/* ============================================================
   monCAPTCHA — site key provisioning

   There is no signup portal and no central authority: YOU run the verification
   service, so YOU mint the keys. A "customer key" is just a pair you generate
   here and hand out:

     sitekey   public.  Goes in the customer's HTML (data-sitekey). Anyone can
                        read it — that is fine, it only names the account.
     secret    private. Goes to the customer's BACKEND for /siteverify. Never
                        put it in a page, and never send it to the browser.

   Usage:

     node server/keygen.mjs --origin https://customer-a.com
     node server/keygen.mjs --name customer-a \
                            --origin https://customer-a.com \
                            --origin https://www.customer-a.com \
                            --file /etc/moncaptcha/keys.json

   Without --file it prints the JSON for MC_KEYS. With --file it merges the new
   key into that file (creating it if needed) and never overwrites an existing
   entry unless --force is given. The file must live OUTSIDE this repository
   (keygen refuses otherwise) and is written owner-only.
   ============================================================ */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
function flags(name) {
    const out = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--' + name) out.push(argv[i + 1]);
    return out.filter(Boolean);
}
const has = (name) => argv.includes('--' + name);

if (has('help') || (!flags('origin').length && !has('force'))) {
    console.log(`
monCAPTCHA — site key generator

  --origin <url>   site allowed to use this key (repeatable, REQUIRED)
                   exact scheme://host[:port], e.g. https://customer-a.com
  --name <slug>    label folded into the site key (default: derived from origin)
  --required <n>   capture points needed to solve (default 6, the value in
                   src/config.js CAPTURES_REQUIRED). The server signs this into
                   each challenge, so the client cannot lower it.
  --file <path>    merge into this keys file instead of printing
  --force          overwrite an existing entry with the same name
  --help

A key pair is not registered anywhere else. Generate, store, hand over.
`.trim());
    process.exit(has('help') ? 0 : 1);
}

const origins = flags('origin');
for (const o of origins) {
    let u;
    try { u = new URL(o); } catch (e) {
        console.error(`error: --origin "${o}" is not a URL. Use scheme://host[:port].`);
        process.exit(1);
    }
    if (u.origin !== o.replace(/\/$/, '')) {
        console.error(`error: --origin "${o}" must be exactly "${u.origin}" (no path, no trailing slash).`);
        process.exit(1);
    }
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        console.error(`warning: "${o}" is not HTTPS. Tokens will not be issued to it in production.`);
    }
}

const rand = (n) => crypto.randomBytes(n).toString('base64url');
const name = (flags('name')[0] || (() => {
    try { return new URL(origins[0]).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase(); }
    catch (e) { return 'site'; }
})());

const requiredArg = flags('required')[0];
let required = null;
if (requiredArg != null) {
    required = Number(requiredArg);
    if (!Number.isInteger(required) || required < 1) {
        console.error(`error: --required "${requiredArg}" must be a positive integer.`);
        process.exit(1);
    }
}

const sitekey = `mc_${name}_${rand(9)}`;
const secret = `mcs_${rand(32)}`;
// Omitted rather than written as 6, so the server's default stays the one place
// the fallback lives (MC_REQUIRED, else 6).
const entry = required == null ? { secret, origins } : { secret, origins, required };

/* Write `data` to `abs` so that only the owner can ever read it.
   writeFileSync's `mode` applies only when the file is CREATED: rewriting an
   existing, wider-permissioned file keeps those permissions and would drop
   fresh secrets into it. So the content goes to a new temp file opened
   exclusively at 0600, is fchmod'd (umask cannot widen it, but be explicit),
   synced, and renamed over the target — the target inode is replaced, not
   reused. The result is checked, never assumed. */
function writeOwnerOnly(abs, data) {
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${rand(6)}.tmp`);
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', 0o600);
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        fs.renameSync(tmp, abs);
    } catch (e) {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* already failing */ }
        try { fs.unlinkSync(tmp); } catch (_) { /* never created */ }
        console.error(`error: could not write ${abs}: ${e.message}`);
        process.exit(1);
    }
    // POSIX modes mean nothing on Windows; access there is the directory's ACL.
    if (process.platform === 'win32') return 'Windows: access follows the folder ACL — restrict it to your account';
    const mode = fs.statSync(abs).mode & 0o777;
    if (mode & 0o077) {
        console.error(`error: ${abs} ended up mode ${mode.toString(8)}, readable by others. Fix it with chmod 600.`);
        process.exit(1);
    }
    return 'mode 0600, verified';
}

/* Secrets never go under a directory a static server might publish. The repo
   root IS one — the quick start serves it — so a keys file anywhere inside it
   is one URL away from the internet. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function insideRepo(abs) {
    const rel = path.relative(REPO_ROOT, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const file = flags('file')[0];
if (file && insideRepo(path.resolve(file))) {
    console.error(`error: --file ${file} is inside the repository (${REPO_ROOT}).`);
    console.error('       The repo root is a web document root in the quick start, so anything in it can be');
    console.error('       downloaded. Keep keys outside it, e.g. --file /etc/moncaptcha/keys.json');
    console.error('       or --file ~/.config/moncaptcha/keys.json');
    process.exit(1);
}
if (!file) {
    console.log('\nAdd to MC_KEYS (or a keys file via --file):\n');
    console.log(JSON.stringify({ [sitekey]: entry }, null, 2));
} else {
    const abs = path.resolve(file);
    let db = {};
    if (fs.existsSync(abs)) {
        try { db = JSON.parse(fs.readFileSync(abs, 'utf8')); }
        catch (e) { console.error(`error: ${abs} exists but is not valid JSON`); process.exit(1); }
    }
    const clash = Object.keys(db).find((k) => k.startsWith(`mc_${name}_`));
    if (clash && !has('force')) {
        console.error(`error: a key for "${name}" already exists (${clash}). Pass --force to add another.`);
        process.exit(1);
    }
    db[sitekey] = entry;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const perms = writeOwnerOnly(abs, JSON.stringify(db, null, 2) + '\n');
    console.log(`\nwrote ${abs} (${perms}, ${Object.keys(db).length} key(s))`);
    console.log(`start the service with:  MC_KEYS_FILE=${abs} node server/verify.mjs`);
}

console.log(`
  sitekey   ${sitekey}
      public — goes in the customer's HTML:  data-sitekey="${sitekey}"

  secret    ${secret}
      PRIVATE — goes to the customer's BACKEND only, for POST /siteverify.
      Never put it in a page. If it leaks, generate a new pair and retire this one.

  origins   ${origins.join(', ')}
      tokens for this key are only issued to these embedding sites
`);
