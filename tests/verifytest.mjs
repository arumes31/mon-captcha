/* Server-only checks for server/verify.mjs — no browser, no challenge container.

   Spawns the verification service several times with different environments
   and asserts the startup and issuance guards that embedtest.mjs cannot reach
   (it needs one long-lived, permissively configured process):

     - no keys configured        -> refuses to start (no silent demo secret)
     - MC_DEMO=1                 -> starts, but on 127.0.0.1 only
     - MC_MIN_SOLVE_MS           -> an instant /issue is refused, the challenge
                                    survives it, and a later /issue succeeds
     - MC_TRUST_PROXY=1 / =N     -> the per-IP bucket keys on the right-most
                                    untrusted X-Forwarded-For hop, so rotating
                                    the client-controlled left part is useless
     - token purpose             -> a signed /challenge blob is refused by
                                    /siteverify, and the refusal burns nothing
     - malformed bodies          -> null / arrays / scalars / inherited key
                                    names get a 4xx, and the process survives
     - keygen                    -> refuses keys files inside the repo; an
                                    existing readable file ends up 0600

   Run:  cd tests && node verifytest.mjs                                      */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const VERIFY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'verify.mjs');
const CHALLENGE = 'http://localhost:8080';
const SITE = 'http://127.0.0.1:8090';
const KEYS = JSON.stringify({ 'test-key': { secret: 'test-secret', origins: [SITE] } });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); }
    else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextPort = 18190;

/* Start verify.mjs with a clean MC_* environment plus `env`. Resolves once it
   logs "listening" (or exits), with its output so far. */
function start(env) {
    const port = nextPort++;
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_')));
    const child = spawn(process.execPath, [VERIFY], {
        env: Object.assign(base, { MC_PORT: String(port), MC_CHALLENGE_ORIGINS: CHALLENGE }, env),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    return new Promise((resolve) => {
        const done = (exitCode) => resolve({ child, port, out, exitCode, url: `http://127.0.0.1:${port}` });
        const timer = setTimeout(() => done(null), 5000);
        const onData = (d) => {
            out += d;
            if (/listening/.test(out)) { clearTimeout(timer); done(null); }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => { clearTimeout(timer); done(code); });
    });
}

const post = (url, body, headers) => fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

const challenge = (srv, headers) =>
    post(`${srv.url}/challenge`, { sitekey: 'test-key' }, Object.assign({ origin: SITE }, headers || {}));
const issue = (srv, ch, points) =>
    post(`${srv.url}/issue`, { sitekey: 'test-key', challenge: ch, points: points ?? 6 }, { origin: CHALLENGE });

console.log('VERIFYTEST_BEGIN');

// ---- no keys: refuse to start rather than run on a public secret ----
{
    const s = await start({});
    ok('refuses to start with no keys configured', s.exitCode === 1,
        'exit=' + s.exitCode + ' ' + s.out.split('\n')[0]);
    if (s.exitCode == null) s.child.kill();
}

// ---- MC_DEMO=1: allowed, but loopback only ----
{
    const s = await start({ MC_DEMO: '1' });
    ok('MC_DEMO=1 starts with the demo key', s.exitCode == null && /public DEMO key/.test(s.out));
    ok('MC_DEMO=1 binds to 127.0.0.1 only', /listening on 127\.0\.0\.1:/.test(s.out));
    const h = await fetch(`${s.url}/health`).then((r) => r.json()).catch(() => null);
    ok('demo server answers on loopback', !!(h && h.ok));
    s.child.kill();
}

// ---- minimum solve time ----
{
    const s = await start({ MC_KEYS: KEYS, MC_MIN_SOLVE_MS: '1500' });
    const c = await challenge(s);
    ok('challenge issued', c.status === 200 && typeof c.data.challenge === 'string', 'status=' + c.status);

    const early = await issue(s, c.data.challenge);
    ok('an instant /issue is refused', early.status === 403 && early.data.error === 'solved-too-fast',
        JSON.stringify(early.data));
    ok('the refusal says how long to wait', early.data.retry_after_ms > 0 && early.data.retry_after_ms <= 1500,
        'retry_after_ms=' + early.data.retry_after_ms);

    await sleep(1600);
    const late = await issue(s, c.data.challenge);
    ok('the same challenge redeems after the floor', late.status === 200 && typeof late.data.token === 'string',
        JSON.stringify(late.data).slice(0, 80));

    const v = await post(`${s.url}/siteverify`, { secret: 'test-secret', response: late.data.token });
    ok('siteverify reports the server-measured solve time', v.data.success === true && v.data.solve_ms >= 1500,
        'solve_ms=' + v.data.solve_ms);
    s.child.kill();
}

{
    const s = await start({ MC_KEYS: KEYS });
    const c = await challenge(s);
    const early = await issue(s, c.data.challenge);
    ok('the floor is on by default', early.data.error === 'solved-too-fast', JSON.stringify(early.data));
    s.child.kill();
}

// ---- X-Forwarded-For: right-most untrusted hop ----
{
    const s = await start({ MC_KEYS: KEYS, MC_TRUST_PROXY: '1', MC_ISSUE_PER_MIN: '3' });
    let limited = false;
    for (let i = 0; i < 10 && !limited; i++) {
        const r = await challenge(s, { 'x-forwarded-for': `203.0.113.${i + 1}, 198.51.100.7` });
        if (r.status === 429) limited = true;
    }
    ok('rotating the left-most XFF entry cannot outrun the per-IP limit', limited);

    const other = await challenge(s, { 'x-forwarded-for': '198.51.100.8' });
    ok('a different proxy-appended client still gets its own bucket', other.status === 200, 'status=' + other.status);
    s.child.kill();
}

{
    const s = await start({ MC_KEYS: KEYS, MC_TRUST_PROXY: '2', MC_ISSUE_PER_MIN: '2' });
    let limited = false;
    for (let i = 0; i < 6 && !limited; i++) {
        const r = await challenge(s, { 'x-forwarded-for': `203.0.113.${i + 1}, 198.51.100.9, 10.0.0.${i + 1}` });
        if (r.status === 429) limited = true;
    }
    ok('MC_TRUST_PROXY=2 keys on the second hop from the right', limited);
    s.child.kill();
}

// ---- a signed CHALLENGE is not a completion token ----
{
    const s = await start({ MC_KEYS: KEYS, MC_MIN_SOLVE_MS: '0' });
    const c = await challenge(s);
    const v = await post(`${s.url}/siteverify`, { secret: 'test-secret', response: c.data.challenge });
    ok('siteverify rejects an authentic /challenge blob', v.data.success === false
        && v.data['error-codes']?.[0] === 'invalid-input-response', JSON.stringify(v.data));

    // ...and that refusal must not have burned anything: the same challenge
    // still goes through /issue, and its token still verifies exactly once.
    const t = await issue(s, c.data.challenge);
    ok('the rejected challenge is still redeemable', t.status === 200, 'status=' + t.status);
    const v1 = await post(`${s.url}/siteverify`, { secret: 'test-secret', response: t.data.token });
    const v2 = await post(`${s.url}/siteverify`, { secret: 'test-secret', response: t.data.token });
    ok('the issued token verifies once', v1.data.success === true && v2.data.success === false,
        JSON.stringify([v1.data.success, v2.data['error-codes']]));
    s.child.kill();
}

// ---- malformed bodies are refused, never fatal ----
{
    const s = await start({ MC_KEYS: KEYS });
    const raw = (p, body, headers) => fetch(`${s.url}${p}`, {
        method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body,
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

    const cases = [
        ['/challenge', 'null', { origin: SITE }],
        ['/challenge', '[]', { origin: SITE }],
        ['/challenge', '7', { origin: SITE }],
        ['/issue', 'null', { origin: CHALLENGE }],
        ['/issue', '"x"', { origin: CHALLENGE }],
        ['/siteverify', 'null'],
        ['/siteverify', 'true'],
    ];
    for (const [p, body, headers] of cases) {
        const r = await raw(p, body, headers);
        ok(`${p} answers ${body} with 400`, r.status === 400 && r.data.error === 'invalid-body', JSON.stringify(r));
    }
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        const r = await raw('/challenge', JSON.stringify({ sitekey: k }), { origin: SITE });
        ok(`inherited name "${k}" is not a site key`, r.status === 403 && r.data.error === 'invalid-sitekey',
            JSON.stringify(r));
    }
    const r = await raw('/challenge', JSON.stringify({ sitekey: { toString: 1 } }), { origin: SITE });
    ok('a non-scalar sitekey is refused', r.status === 403, 'status=' + r.status);

    const h = await fetch(`${s.url}/health`).then((x) => x.json()).catch(() => null);
    ok('the server is still up after all of it', h && h.ok === true && s.child.exitCode === null);
    s.child.kill();
}

// ---- keygen: keys never land in the repo; files end up owner-only ----
{
    const KEYGEN = path.join(path.dirname(VERIFY), 'keygen.mjs');
    const run = (args) => new Promise((resolve) => {
        const c = spawn(process.execPath, [KEYGEN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { out += d; });
        c.on('exit', (code) => resolve({ code, out }));
    });

    const inRepo = path.join(path.dirname(VERIFY), 'keys.json');
    const r1 = await run(['--origin', 'https://a.example', '--file', inRepo]);
    ok('keygen refuses a keys file inside the repository', r1.code === 1 && !fs.existsSync(inRepo),
        r1.out.split('\n')[0]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-keygen-'));
    const f = path.join(dir, 'keys.json');
    fs.writeFileSync(f, '{}\n', { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    const r2 = await run(['--origin', 'https://a.example', '--file', f]);
    const db = JSON.parse(fs.readFileSync(f, 'utf8'));
    ok('keygen merges into an existing file', r2.code === 0 && Object.keys(db).length === 1, r2.out.split('\n')[1]);
    if (process.platform !== 'win32') {
        const mode = fs.statSync(f).mode & 0o777;
        ok('a world-readable keys file is rewritten owner-only', mode === 0o600, 'mode=' + mode.toString(8));
    }
    ok('no temp files are left behind', fs.readdirSync(dir).length === 1, fs.readdirSync(dir).join(','));
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ---- verifytest: ${pass} passed, ${fail} failed ----`);
console.log('VERIFYTEST_END');
process.exit(fail ? 1 : 0);
