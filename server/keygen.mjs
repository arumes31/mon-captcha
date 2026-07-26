/* ============================================================
   Monster CAPTCHA — site key provisioning

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
                            --file server/keys.json

   Without --file it prints the JSON for MC_KEYS. With --file it merges the new
   key into that file (creating it if needed) and never overwrites an existing
   entry unless --force is given.
   ============================================================ */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
function flags(name) {
    const out = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--' + name) out.push(argv[i + 1]);
    return out.filter(Boolean);
}
const has = (name) => argv.includes('--' + name);

if (has('help') || (!flags('origin').length && !has('force'))) {
    console.log(`
Monster CAPTCHA — site key generator

  --origin <url>   site allowed to use this key (repeatable, REQUIRED)
                   exact scheme://host[:port], e.g. https://customer-a.com
  --name <slug>    label folded into the site key (default: derived from origin)
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

const sitekey = `mc_${name}_${rand(9)}`;
const secret = `mcs_${rand(32)}`;
const entry = { secret, origins };

const file = flags('file')[0];
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
    fs.writeFileSync(abs, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
    console.log(`\nwrote ${abs} (mode 0600, ${Object.keys(db).length} key(s))`);
    console.log(`start the service with:  MC_KEYS_FILE=${file} node server/verify.mjs`);
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
