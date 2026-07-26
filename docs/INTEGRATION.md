# Embedding monCAPTCHA on another site

Two moving parts:

| | what it is | where it runs |
|---|---|---|
| `embed/monster-captcha.js` | the widget: checkbox, modal, token plumbing | the customer's page |
| `server/verify.mjs` | issues and checks signed tokens | your infrastructure |
| `server/keygen.mjs` | mints site key / secret pairs into a JSON file | your workstation |

> [!IMPORTANT]
> **Not on this branch.** A self-service portal (`server/portal.mjs`) and DNS TXT domain
> verification (`server/dnsverify.mjs`) exist only on the unmerged `test1` branch, and
> `server/store.mjs` is present but not wired into `verify.mjs`. Keys are provisioned with
> `keygen.mjs` and read from `MC_KEYS` / `MC_KEYS_FILE` as plaintext secrets. Earlier revisions
> of this document described those features as shipped; they are not. Anything below marked
> **(test1 only)** is not a control you currently have.

The widget alone will run the challenge and hand you a token. **It will not tell you
anything trustworthy.** Read [Security](#security) before you rely on it.

---

## 1. Host the challenge

Anywhere static. The Docker image already serves `index.html`, `src/`, and `embed/`:

```sh
docker compose up -d --build      # -> http://localhost:8080
```

The widget derives the challenge origin from its own `<script src>`, so a customer only
ever configures one URL.

## 2. Get a site key

### keygen (the only option on this branch)

Mint a key straight into a JSON file:

```sh
node server/keygen.mjs --origin https://customer-a.com \
                       --origin https://www.customer-a.com \
                       --file server/keys.json
```

```
  sitekey   mc_customer-a-com_qTLtf17Ph3D
      public — goes in the customer's HTML:  data-sitekey="…"

  secret    mcs_A8uckZnc4guGpDsBpNB0Hezak…
      PRIVATE — goes to the customer's BACKEND only, for POST /siteverify.
      Never put it in a page. If it leaks, mint a new pair and retire this one.

  origins   https://customer-a.com, https://www.customer-a.com
      tokens for this key are only issued to these embedding sites
```

Origins must be exact `scheme://host[:port]` — no path, no trailing slash. `keygen` refuses
anything else, warns on non-HTTPS, and will not silently replace an existing key (`--force`
to add a second for the same name). The file is written `0600`.

Omit `--file` to just print the JSON for `MC_KEYS`. Pass `--required N` to set that key's
capture bar (default 6).

> [!WARNING]
> Secrets in this file are **plaintext**, and listing an origin is all it takes to issue for
> that domain — there is no proof-of-control step on this branch. Guard the file accordingly,
> and only add origins you actually control. The scrypt-hashed, DNS-verified variant lives on
> `test1` (see the note at the top).
>
> A self-service portal (`server/portal.mjs`, `MC_USE_STORE`, `MC_SIGNING_KEY`) is also
> **(test1 only)**. `verify.mjs` on this branch signs with each key's own secret and does not
> import `server/store.mjs`.

## 3. Run the verification service

```sh
MC_KEYS_FILE=server/keys.json \
MC_CHALLENGE_ORIGINS='https://captcha.yourdomain.com' \
node server/verify.mjs                                   # -> :8091
```

| variable | meaning |
|---|---|
| `MC_KEYS_FILE` | path to the keys file `keygen --file` writes |
| `MC_KEYS` | inline JSON alternative; wins over `MC_KEYS_FILE` if both are set |
| `MC_CHALLENGE_ORIGINS` | where **the challenge itself** is served from. `/issue` is called by the challenge frame, so this is what its `Origin` header carries. |
| `MC_TTL_MS` | token lifetime (default 120000) |
| `MC_CHALLENGE_TTL_MS` | how long a player has to finish (default 300000). Also the window in which one challenge is spendable — it mints exactly one token. |
| `MC_ISSUE_PER_MIN` | per-IP cap on `/challenge` + `/issue` (default 20) |
| `MC_SITE_PER_MIN` | per-**site-key** cap on the same endpoints (default 240). IPs are rentable; this is the bucket an attacker cannot rotate away from. |
| `MC_TRUST_PROXY` | set to `1` **only** when a reverse proxy is in front. Read the [deployment note](#deployment-mc_trust_proxy) — wrong either way costs you the per-IP limiter or every client's real address. |
| `MC_REQUIRED` | default capture points needed to solve (default 6). Per-key `required` wins. Keep it equal to `CONFIG.CAPTURES_REQUIRED` in `src/config.js` unless you are also passing `?required=` through. |

Starting with neither `MC_KEYS` nor `MC_KEYS_FILE` uses a printed demo key and warns loudly.
A malformed key entry is a startup failure, not a runtime surprise.

## 4. Customer adds two lines

```html
<form method="POST" action="/signup">
  <input name="email" type="email">

  <div class="monster-captcha"
       data-sitekey="mc_customer-a-com_qTLtf17Ph3D"
       data-verify="https://captcha.yourdomain.com:8091"></div>

  <button type="submit">Sign up</button>
</form>

<script src="https://captcha.yourdomain.com/embed/monster-captcha.js" defer></script>
```

That renders the checkbox and, on success, writes the token into a hidden input named
`monster-captcha-response` inside the surrounding form.

### Attributes

| attribute | required | meaning |
|---|---|---|
| `data-sitekey` | yes | public key identifying the customer |
| `data-verify` | **effectively yes** | base URL of the verification service. Omit it and the token is unverifiable. |
| `data-theme` | no | `light` (default) or `dark` |
| `data-callback` | no | global function name, called `(token, info)` on success |
| `data-expired-callback` | no | called `(reason)` when the challenge is closed unsolved |
| `data-error-callback` | no | called `(message)` on failure |

The error callback receives `domain-not-allowed` when this site key is not registered for the
page's origin, `invalid-sitekey` when the key is unknown, and `challenge-unreachable` when the
verification service cannot be reached. In all three the game never opens.

`info` is `{ points, seed, verified }`. **`verified: false` means no issuer was configured
and the token proves nothing** — the widget also logs a console warning.

### JS API

```js
MonsterCaptcha.render('#slot', { sitekey: '…', callback: 'onVerified', theme: 'dark' });
MonsterCaptcha.getResponse(id);   // current token, or ''
MonsterCaptcha.reset(id);         // back to unsolved
MonsterCaptcha.FIELD_NAME;        // 'monster-captcha-response'
```

Define `window.onMonsterCaptchaLoad` to be called once the widget script has bound.

## 5. Customer's backend verifies

Server to server, never from the browser:

```sh
curl -X POST https://captcha.yourdomain.com:8091/siteverify \
  -H 'content-type: application/json' \
  -d '{"secret":"mcs_A8uckZnc4guGpDsBpNB0Hezak…","response":"<token from the form>"}'
```

```json
{ "success": true, "challenge_ts": "2026-07-25T20:51:39.156Z",
  "hostname": "customer-a.com", "points": 6, "required": 6,
  "points_source": "client-asserted", "seed": "3245627019" }
```

**Check `hostname` yourself** — it is the site the challenge was embedded on.

`required` is the capture bar the server set for that run, and `/issue` does refuse to mint below
it, so you need not repeat the comparison. But read `points_source` and believe it: **`points` is
the number the browser reported.** The server checked it against a threshold it authored, which
stops an arbitrary score being minted into a token — it did not witness any capture. Do not treat
`points` as a measure of effort, and do not scale trust with it.

Failures come back as `{"success": false, "error-codes": [...]}`:

| code | meaning |
|---|---|
| `missing-input-secret` / `missing-input-response` | field absent |
| `invalid-input-secret` | no site key has that secret |
| `invalid-input-response` | not a token, or the signature does not match |
| `sitekey-mismatch` | token was minted for a different key |
| `timeout-or-duplicate` | expired, or already verified once |

Tokens are **single-use**: the second `/siteverify` for a token always fails.

---

## Security

### What this actually gives you

The challenge runs entirely in the visitor's browser. Nothing in it proves a human played:
a bot can drive the page, or call `/issue` directly, and get a genuine signed token. What
the design does buy:

* tokens cannot be **forged or altered** without the signing secret (HMAC-SHA256)
* tokens are **single-use**, short-lived, and bound to one site key, so they cannot be
  replayed, shared between sites, or minted in bulk and banked
* **one `/challenge` mints exactly one token** — a caller cannot fetch a blob once and then
  mint offline for the rest of its lifetime
* the **world seed and the win threshold are chosen by the server** and travel inside the
  signed challenge, so a client cannot pick a favourable world or lower its own bar
* `points` is **checked against that threshold**, so it cannot be inflated into the token
* issuance is **rate limited per IP and per site key**, so bulk minting is at least metered

### The limits, stated plainly

* **`points` is still the client's count.** Nothing server-side saw a capture. The threshold
  check stops inflation; it is not an observation. See `points_source` above.
* **`Origin` is a browser guarantee, not a network one.** It stops copied-key and cross-site
  abuse from real browsers — the same guarantee reCAPTCHA/hCaptcha domain restriction gives.
  A non-browser client sets any `Origin` it likes, so `/challenge` is reachable by script.
* **Per-IP metering depends on `MC_TRUST_PROXY`.** Get it wrong and one request header
  bypasses that half of the limiter — see the deployment note below.
* **Single-use is per-process.** The nonce and rate-limit stores are in memory, so behind more
  than one instance each replica will re-grant the same token. Back them with Redis first.

That is the ceiling for any client-side captcha, and it is the same ceiling the commercial
products sit on: Turnstile's `siteverify` returns no score and no proof either. Making the *run*
checkable would need the server to witness each capture — a signed receipt per catch with a
minimum interval the server derives itself — and even then the property gained is "a conforming
client produced this transcript over N seconds of serialized wall clock", not "a human played".
**Use this as a cost multiplier, never as the only control on anything that matters.**

### Deployment: `MC_TRUST_PROXY`

`X-Forwarded-For` is a request header, so any caller can set it. The per-IP limiter is the only
real meter this service has, and it reads XFF **only** when you say a proxy is in front:

| deployment | setting |
|---|---|
| behind nginx / Caddy / Cloudflare | `MC_TRUST_PROXY=1` (and make the proxy overwrite, not append, XFF) |
| exposed directly | leave it unset — otherwise a rotating header mints without limit |

### The in-page token is not the token

`src/security.js` `generateToken()` returns `SHA-256(nonce:hash:points:required)`. The nonce
is random and never transmitted, and `CONFIG.PRIVATE_SALT` ships to every browser inside
`src/config.js` — so it is not a secret and is not even used in that hash. A receiving
server holds nothing to check it against and cannot tell it from any other 32 bytes of hex.

It is kept for the standalone page's `window.__captcha.getToken()`. The embed path replaces
it with a server-signed token whenever `data-verify` is set, and reports `verified: false`
when it could not.

### Capture requirement

How many capture points a visitor must earn. Commons score 1, rarer tiers 2; the default is 6,
matching `CONFIG.CAPTURES_REQUIRED` in `src/config.js`. Set it per key in the keys file, or
globally with `MC_REQUIRED`:

```json
{ "mc_customer-a_xxx": { "secret": "mcs_…", "origins": ["https://customer-a.com"], "required": 6 } }
```

The number is **signed into the challenge blob**, so the value the game enforces locally and the
value `/issue` enforces are the same one, and only the second matters:

* the frame receives a copy as `?required=N`, which drives the HUD counter and the local win
  condition. Editing it only changes when the browser *thinks* it won — `/issue` compares
  against the number inside the *signed* challenge, so a client that pins `?required=1` wins on
  screen and is then refused a token
* `/issue` returns `insufficient-points` when the claim falls short, so no token is minted
* `/siteverify` reports `required` alongside `points`

Changing it applies to the next challenge; tokens already issued are unaffected. A non-integer or
non-positive `required` is rejected at startup rather than silently coerced; the client-side copy
is clamped to 1-60 so a bad URL cannot make a run unwinnable.

### Domain ownership (DNS TXT) — **(test1 only)**

> [!WARNING]
> **Not implemented on this branch.** There is no DNS verification in `server/verify.mjs`: a key
> issues for whatever origins you list in the keys file, immediately, with no proof of control.
> `/challenge` never returns `domain-not-verified`. If you provision keys for domains you do not
> control, nothing here will stop you. The design below lives on the unmerged `test1` branch.

### Domain ownership (DNS TXT)

Before a site key will issue anything for a domain, its owner must prove control by
publishing a TXT record:

```
_mon-captcha.shop.example.   IN TXT   "mon-captcha-<token>"
```

A TXT record on the bare apex (`shop.example`) is accepted too.

| rule | behaviour |
|---|---|
| **blocked until verified** | `/challenge` returns `domain-not-verified`, so an unverified domain cannot mint a challenge — and therefore cannot mint a token, since `/issue` only accepts a signed challenge |
| **one time** | once verified, the domain is never re-checked and never expires |
| **first check after 15 min** | a record published seconds ago has not propagated, so an immediate poll only produces a misleading "not found". *Check now* skips the wait. |
| **then every 5 min** | per host, until verified or the window closes |
| **12-hour window** | after that the poller drops the host and the owner must request verification again, which mints a fresh token |

Adding a *new* domain to an existing key re-blocks that domain until it is verified in turn;
domains already verified stay verified.

Tunable via `MC_DNS_FIRST_DELAY_MS`, `MC_DNS_CHECK_MS`, `MC_DNS_WINDOW_MS`, `MC_DNS_SERVERS`
(pin resolvers), and `MC_DNS_POLL=0` (disable the poller).

**What this proves:** control of the DNS zone at verification time. It does not prove the
domain still belongs to the same party later, and it is not a defence against a
sub-domain-takeover on the customer's own infrastructure.

### Domain restriction — how a site key is bound to a site

This is the part that stops someone copying a site key onto their own page.

```
widget (on customer-a.com) --POST /challenge--> verifier
    browser stamps Origin: https://customer-a.com   (page script cannot change it)
    verifier checks it against the key's origins
    <-- signed blob { sitekey, origin, exp }

widget --handshake(challenge)--> challenge frame
frame  --POST /issue { sitekey, challenge }--> verifier
    verifier checks the blob's signature and reads the origin OUT OF IT
    <-- token bound to that origin
```

The embedding domain is therefore never a value the client asserts — it comes from a blob the
server signed after the *browser* told it where the request came from. `/issue` ignores any
`origin` field in its request body entirely.

An unregistered domain is refused at `/challenge` with `domain-not-allowed`, before the game
loads, and receives no CORS headers at all — so the browser blocks the response too.

**The limit, stated plainly:** `Origin` is a browser guarantee, not a network one. A
non-browser client (curl, a headless script) can send any `Origin` it likes and would get a
challenge. This stops cross-site abuse and copied-key abuse from real browsers — the same
guarantee reCAPTCHA and hCaptcha domain restriction give — and is not a defence against a
determined scripted attacker.

### Origin handling in the frame

The frame must send the token to exactly one origin and never `'*'`. It cannot read that
from its own URL, because a query parameter is attacker-controlled. Instead:

```
frame  → '*'    { type: 'ready' }        carries no secret
parent → frame  { type: 'handshake' }    browser stamps event.origin
frame  records event.origin; every later message goes only there
```

`event.origin` is set by the browser and cannot be forged by page script. A hostile site can
still frame the widget — but then it *is* the parent, and only ever receives a token minted
for its own origin, which `/siteverify` reports and the real customer's `hostname` check
rejects.

The widget side checks both `event.origin` **and** `event.source === iframe.contentWindow`,
so one framed page cannot solve another widget.

`/issue` takes the embedding domain from the signed `/challenge` blob only (see above), so
there is no client-asserted origin anywhere in the token path.

### Production notes

* Serve everything over HTTPS. The frame refuses to send a token to a non-HTTPS issuer
  unless it is `localhost`.
* The nonce and rate-limit stores are in-process. Behind more than one instance, back them
  with Redis or equivalent, or replay protection is per-instance only.
* Set a real `MC_KEYS`. Starting without it uses a printed demo key and warns.

---

## Try it

```sh
docker compose up -d --build
MC_KEYS='{"demo-site-key":{"secret":"demo-secret","origins":["http://127.0.0.1:8090"]}}' \
MC_CHALLENGE_ORIGINS='http://localhost:8080' node server/verify.mjs &
# open http://localhost:8080/embed/demo.html
```

End-to-end test (real cross-origin: host on `127.0.0.1`, challenge on `localhost`):

```sh
cd tests && node embedtest.mjs      # 28 checks (widget, cross-origin)
cd tests && node portaltest.mjs     # 33 checks (portal, DNS gate, rotation)
```
