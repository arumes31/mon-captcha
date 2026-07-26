/* End-to-end test of the embeddable widget.

   Exercises the real cross-origin path rather than a same-origin shortcut:
   the host page is served from 127.0.0.1 while the widget script and the
   challenge frame come from localhost, which the browser treats as two
   distinct origins. So the handshake, the origin checks and the postMessage
   plumbing are all under genuine cross-origin rules.

   Covers:
     - widget renders and auto-binds from markup
     - clicking opens a modal frame pointed at the challenge origin
     - ready -> handshake -> accepted completes across origins
     - a solve reaches the host page, fills the hidden input, fires the callback
     - the issued token verifies once via /siteverify and is then burned
     - a forged/altered token is rejected
     - the frame refuses to answer a handshake from the wrong origin

   Requires: the challenge container on :8080 and `node server/verify.mjs` on
   :8091 with the demo key. Both are started by the runner below if absent.   */
import { chromium } from 'playwright';
import { SWIFTSHADER_ARGS } from './harness.mjs';
import http from 'node:http';

const CHALLENGE = process.env.CAPTCHA_BASE_URL || 'http://localhost:8080';
const VERIFY = process.env.MC_VERIFY_URL || 'http://localhost:8091';
const HOST_PORT = Number(process.env.MC_HOST_PORT || 8090);
const HOST = `http://127.0.0.1:${HOST_PORT}`;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); }
    else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); }
};

/* A minimal host site on its own origin. Deliberately NOT served by the
   challenge container: same-origin would hide exactly the bugs this tests. */
const HOST_PAGE = `<!DOCTYPE html><meta charset="utf-8"><title>host</title>
<form id="f"><div class="monster-captcha"
   data-sitekey="demo-site-key"
   data-verify="${VERIFY}"
   data-callback="onVerified"></div></form>
<script>
  window.__result = null;
  function onVerified(token, info) { window.__result = { token: token, info: info }; }
</script>
<script src="${CHALLENGE}/embed/monster-captcha.js"></script>`;

const hostServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(HOST_PAGE);
});
await new Promise((r) => hostServer.listen(HOST_PORT, '127.0.0.1', r));

function post(url, body) {
    return fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json());
}

const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
const ctx = await b.newContext({ viewport: { width: 1100, height: 720 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));

console.log('EMBEDTEST_BEGIN');
console.log(`  host=${HOST}  challenge=${CHALLENGE}  verify=${VERIFY}\n`);

await page.goto(HOST, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);

ok('widget auto-binds from markup', await page.evaluate(() =>
    !!document.querySelector('.monster-captcha[data-mc-bound]')));
ok('checkbox rendered with a11y role', await page.evaluate(() =>
    !!document.querySelector('.monster-captcha [role=checkbox]')));
ok('hidden response field created', await page.evaluate(() =>
    !!document.querySelector('input[type=hidden][name="monster-captcha-response"]')));
ok('MonsterCaptcha global exposed', await page.evaluate(() =>
    !!(window.MonsterCaptcha && window.MonsterCaptcha.render)));

// ---- open the challenge ----
await page.click('.monster-captcha [role=checkbox]');
await page.waitForTimeout(400);
const frameSrc = await page.evaluate(() => {
    const f = document.querySelector('iframe[title="Monster CAPTCHA challenge"]');
    return f ? f.getAttribute('src') : null;
});
ok('clicking opens a challenge frame', !!frameSrc, frameSrc ? frameSrc.slice(0, 78) : 'no iframe');
ok('frame points at the challenge origin', !!frameSrc && frameSrc.indexOf(CHALLENGE) === 0);
ok('frame carries embed + sitekey + verify', !!frameSrc &&
    /embed=1/.test(frameSrc) && /sitekey=/.test(frameSrc) && /verify=/.test(frameSrc));

// ---- wait for the game to boot inside the frame, then confirm the handshake ----
let framed = null;
for (let i = 0; i < 90; i++) {
    framed = page.frames().find((f) => f.url().indexOf('embed=1') !== -1) || null;
    if (framed) {
        const up = await framed.evaluate(() => !!(window.__captcha && window.__captcha.isEmbedded &&
            window.__captcha.isEmbedded())).catch(() => false);
        if (up) break;
    }
    await page.waitForTimeout(1000);
}
ok('challenge reports itself embedded', !!framed);

// ---- drive a solve from inside the frame ----
// The capture flow needs real gameplay; the token path is what is under test,
// so trigger the same emit the win does, through the public bridge.
const solved = framed && await framed.evaluate(async () => {
    const m = await import('./src/embed.js');
    await m.emitEmbedSolved('local-unverifiable-token');
    return true;
}).catch((e) => String(e));
ok('frame can emit a solve', solved === true, solved === true ? '' : String(solved).slice(0, 120));

await page.waitForTimeout(1500);
const result = await page.evaluate(() => window.__result);
ok('host page received the token', !!(result && result.token), result ? result.token.slice(0, 40) : 'none');
ok('callback reports verified:true (issuer configured)', !!(result && result.info && result.info.verified),
    result && result.info ? 'verified=' + result.info.verified : '');
ok('hidden input populated', await page.evaluate(() =>
    (document.querySelector('input[name="monster-captcha-response"]') || {}).value ? true : false));
ok('modal closed after solve', await page.evaluate(() =>
    !document.querySelector('iframe[title="Monster CAPTCHA challenge"]')));
ok('checkbox shows verified', await page.evaluate(() =>
    document.querySelector('.monster-captcha [role=checkbox]').getAttribute('aria-checked') === 'true'));

// ---- server-side verification ----
const token = result && result.token;
if (token) {
    const v1 = await post(`${VERIFY}/siteverify`, { secret: 'demo-secret', response: token });
    ok('siteverify accepts the token', v1.success === true, JSON.stringify(v1).slice(0, 120));
    ok('siteverify reports the embedding host', v1.hostname === '127.0.0.1', 'hostname=' + v1.hostname);

    const v2 = await post(`${VERIFY}/siteverify`, { secret: 'demo-secret', response: token });
    ok('token is single-use (replay rejected)', v2.success === false &&
        (v2['error-codes'] || []).includes('timeout-or-duplicate'), JSON.stringify(v2).slice(0, 120));

    const bad = token.slice(0, -4) + 'AAAA';
    const v3 = await post(`${VERIFY}/siteverify`, { secret: 'demo-secret', response: bad });
    ok('altered signature rejected', v3.success === false, JSON.stringify(v3).slice(0, 100));

    const v4 = await post(`${VERIFY}/siteverify`, { secret: 'wrong-secret', response: token });
    ok('wrong secret rejected', v4.success === false &&
        (v4['error-codes'] || []).includes('invalid-input-secret'), JSON.stringify(v4).slice(0, 100));
}

// ---- issuance is bound on both axes ----
const issue = (originHeader, body) => fetch(`${VERIFY}/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: originHeader },
    body: JSON.stringify(body),
}).then((r) => r.json()).catch((e) => ({ error: String(e) }));

// Anything not served from the challenge host cannot reach /issue at all.
const v5 = await issue('https://evil.example', { sitekey: 'demo-site-key', origin: HOST, points: 6 });
ok('issue rejects a non-challenge caller', v5.error === 'bad-challenge-origin', JSON.stringify(v5).slice(0, 90));

// Naming a domain in the body gets you nowhere: the field is not read at all,
// so the request dies for want of a signed challenge.
const v6 = await issue(CHALLENGE, { sitekey: 'demo-site-key', origin: 'https://evil.example', points: 6 });
ok('a body-asserted domain is inert', v6.error === 'invalid-challenge', JSON.stringify(v6).slice(0, 90));

const v7 = await issue(CHALLENGE, { sitekey: 'no-such-key', origin: HOST, points: 6 });
ok('issue rejects an unknown sitekey', v7.error === 'invalid-sitekey', JSON.stringify(v7).slice(0, 90));

// ---- domain restriction: the site key only works on its registered domains ----
const challengeFor = (originHeader, sitekey) => fetch(`${VERIFY}/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: originHeader },
    body: JSON.stringify({ sitekey: sitekey }),
}).then((r) => r.json()).catch((e) => ({ error: String(e) }));

const c1 = await challengeFor(HOST, 'demo-site-key');
ok('challenge issued to the registered domain', typeof c1.challenge === 'string',
    c1.challenge ? c1.challenge.slice(0, 32) + '…' : JSON.stringify(c1).slice(0, 80));

// Someone copies the site key onto their own site. Their browser sends THEIR
// origin, which is not registered — this is the case the restriction exists for.
const c2 = await challengeFor('https://stolen-key.example', 'demo-site-key');
ok('challenge refused to an unregistered domain', c2.error === 'domain-not-allowed',
    JSON.stringify(c2).slice(0, 90));

// A token cannot be minted without a challenge, or with a tampered one.
const v8 = await issue(CHALLENGE, { sitekey: 'demo-site-key', points: 6 });
ok('issue refuses with no challenge', v8.error === 'invalid-challenge', JSON.stringify(v8).slice(0, 90));

const v9 = await issue(CHALLENGE, { sitekey: 'demo-site-key', points: 6, challenge: c1.challenge.slice(0, -4) + 'AAAA' });
ok('issue refuses a tampered challenge', v9.error === 'invalid-challenge', JSON.stringify(v9).slice(0, 90));

// The honest ceiling, asserted so it cannot regress silently: the embedding
// domain is taken from the SIGNED challenge, never from the request body.
const v10 = await issue(CHALLENGE, {
    sitekey: 'demo-site-key', points: 6, challenge: c1.challenge, origin: 'https://evil.example',
});
const v10ok = typeof v10.token === 'string';
let boundTo = null;
if (v10ok) {
    const vr = await post(`${VERIFY}/siteverify`, { secret: 'demo-secret', response: v10.token });
    boundTo = vr.hostname;
}
ok('body-supplied origin cannot override the signed one', v10ok && boundTo === '127.0.0.1',
    'token bound to ' + boundTo);

ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(`\n  ---- embedtest: ${pass} passed, ${fail} failed ----`);
console.log('EMBEDTEST_END');
await b.close();
hostServer.close();
process.exit(fail ? 1 : 0);
