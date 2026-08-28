import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';

async function availablePort() {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
    });
    const { port } = listener.address();
    await new Promise((resolve) => listener.close(resolve));
    return port;
}

async function waitForServer(baseURL) {
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            const response = await fetch(`${baseURL}/health`);
            if (response.ok) return;
        } catch {
            // The child process may still be binding its socket.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('verification server did not become healthy');
}

async function post(baseURL, path, body, origin) {
    const headers = { 'content-type': 'application/json' };
    if (origin) headers.origin = origin;
    const response = await fetch(`${baseURL}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

test('challenge, issuance, verification, and replay protection', async (t) => {
    const port = await availablePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server/verify.mjs'], {
        cwd: new URL('..', import.meta.url),
        env: {
            ...process.env,
            MC_PORT: String(port),
            MC_CHALLENGE_ORIGINS: 'http://challenge.test',
            MC_KEYS: JSON.stringify({
                'test-site': {
                    secret: 'test-secret-that-is-not-used-outside-this-process',
                    origins: ['https://customer.test'],
                    required: 2,
                },
            }),
        },
        stdio: 'ignore',
    });
    t.after(async () => {
        if (child.exitCode != null) return;
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
    });

    await waitForServer(baseURL);

    const denied = await post(baseURL, '/challenge', { sitekey: 'test-site' }, 'https://attacker.test');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'domain-not-allowed');

    const challenge = await post(baseURL, '/challenge', { sitekey: 'test-site' }, 'https://customer.test');
    assert.equal(challenge.status, 200);
    assert.equal(challenge.body.required, 2);

    const wrongOrigin = await post(baseURL, '/issue', {
        sitekey: 'test-site', challenge: challenge.body.challenge, points: 2,
    }, 'https://attacker.test');
    assert.equal(wrongOrigin.status, 403);
    assert.equal(wrongOrigin.body.error, 'bad-challenge-origin');

    const issued = await post(baseURL, '/issue', {
        sitekey: 'test-site', challenge: challenge.body.challenge, points: 2,
    }, 'http://challenge.test');
    assert.equal(issued.status, 200);
    assert.ok(issued.body.token);

    const verified = await post(baseURL, '/siteverify', {
        secret: 'test-secret-that-is-not-used-outside-this-process',
        response: issued.body.token,
    });
    assert.equal(verified.body.success, true);
    assert.equal(verified.body.hostname, 'customer.test');

    const replay = await post(baseURL, '/siteverify', {
        secret: 'test-secret-that-is-not-used-outside-this-process',
        response: issued.body.token,
    });
    assert.equal(replay.body.success, false);
    assert.deepEqual(replay.body['error-codes'], ['timeout-or-duplicate']);
});
