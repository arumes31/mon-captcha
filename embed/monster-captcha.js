/* ============================================================
   Monster CAPTCHA — embeddable widget

   Drop this on any site:

     <script src="https://YOUR-HOST/embed/monster-captcha.js" defer></script>
     <form method="POST" action="/signup">
       <div class="monster-captcha" data-sitekey="YOUR_SITE_KEY"></div>
       <button type="submit">Sign up</button>
     </form>

   It renders a checkbox, opens the game in a modal frame when clicked, and on
   success writes the token into a hidden input named "monster-captcha-response"
   inside the surrounding form. Your BACKEND then verifies that token — see
   docs/INTEGRATION.md. A token that is never verified server-side means nothing.

   No dependencies, no build step, no globals beyond window.MonsterCaptcha.
   Everything is inline-styled and namespaced so it cannot collide with the
   host page's CSS.
   ============================================================ */
(function () {
    'use strict';

    var PROTOCOL = 'monster-captcha';
    var VERSION = 1;
    var FIELD_NAME = 'monster-captcha-response';

    /* Where the challenge is served from. Derived from THIS script's own src, so
       a site only ever configures one URL (the script tag). Falls back to the
       current origin when the script is same-origin. */
    var ORIGIN = (function () {
        try {
            var s = document.currentScript;
            if (!s) {
                var all = document.getElementsByTagName('script');
                for (var i = all.length - 1; i >= 0; i--) {
                    if (all[i].src && all[i].src.indexOf('monster-captcha.js') !== -1) { s = all[i]; break; }
                }
            }
            return s && s.src ? new URL(s.src, location.href).origin : location.origin;
        } catch (e) { return location.origin; }
    })();

    var CHALLENGE_PATH = '/index.html';
    var widgets = [];
    var seq = 0;

    function el(tag, style, attrs) {
        var n = document.createElement(tag);
        if (style) n.setAttribute('style', style);
        for (var k in attrs || {}) n.setAttribute(k, attrs[k]);
        return n;
    }

    function findForm(node) {
        var p = node;
        while (p && p !== document.body) { if (p.tagName === 'FORM') return p; p = p.parentNode; }
        return null;
    }

    function callbackFor(name) {
        if (!name) return null;
        // Only a plain global function name is honoured — never eval'd. A dotted
        // path is walked property by property so nothing is executed by lookup.
        try {
            var parts = String(name).split('.');
            var ctx = window;
            for (var i = 0; i < parts.length; i++) { ctx = ctx[parts[i]]; if (!ctx) return null; }
            return typeof ctx === 'function' ? ctx : null;
        } catch (e) { return null; }
    }

    /* ---------- one widget instance ---------- */
    function Widget(mount) {
        var self = this;
        this.mount = mount;
        this.id = PROTOCOL + '-' + (++seq);
        this.sitekey = mount.getAttribute('data-sitekey') || '';
        // Base URL of the verification service. Without it the challenge still
        // runs, but the token it returns is unverifiable — the 'solved' message
        // reports verified:false and your backend should treat it as decorative.
        this.verify = mount.getAttribute('data-verify') || '';
        this.theme = mount.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        this.onVerify = mount.getAttribute('data-callback');
        this.onExpire = mount.getAttribute('data-expired-callback');
        this.onError = mount.getAttribute('data-error-callback');
        this.token = null;
        this.frame = null;
        this.overlay = null;
        this.frameOrigin = null;

        var dark = this.theme === 'dark';
        var bg = dark ? '#20242b' : '#fafafa';
        var fg = dark ? '#e8eaed' : '#222';
        var bd = dark ? '#3a4049' : '#d3d3d3';

        this.root = el('div', 'display:inline-flex;align-items:center;gap:12px;box-sizing:border-box;' +
            'width:302px;height:76px;padding:0 14px;border:1px solid ' + bd + ';border-radius:4px;' +
            'background:' + bg + ';color:' + fg + ';font:400 14px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
            'user-select:none;');

        this.box = el('div', 'width:28px;height:28px;flex:0 0 28px;border:2px solid #b0b6be;border-radius:3px;' +
            'background:#fff;cursor:pointer;position:relative;transition:border-color .15s;',
            { role: 'checkbox', 'aria-checked': 'false', tabindex: '0', 'aria-label': 'Verify you are human by playing a short game' });

        this.label = el('span', 'flex:1 1 auto;cursor:pointer;');
        this.label.textContent = "I'm not a robot";

        this.brand = el('div', 'flex:0 0 auto;text-align:center;font-size:10px;color:' + (dark ? '#8b93a1' : '#9aa0a6') + ';line-height:1.25;');
        this.brand.appendChild(document.createTextNode('Monster'));
        this.brand.appendChild(el('br'));
        this.brand.appendChild(document.createTextNode('CAPTCHA'));

        this.root.appendChild(this.box);
        this.root.appendChild(this.label);
        this.root.appendChild(this.brand);
        mount.innerHTML = '';
        mount.appendChild(this.root);

        // Hidden field: the value your server verifies.
        this.input = el('input', null, { type: 'hidden', name: FIELD_NAME });
        var form = findForm(mount);
        (form || mount).appendChild(this.input);

        function open() { self.open(); }
        this.box.addEventListener('click', open, false);
        this.label.addEventListener('click', open, false);
        this.box.addEventListener('keydown', function (e) {
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); open(); }
        }, false);
    }

    Widget.prototype.setState = function (s) {
        if (s === 'solved') {
            this.box.style.borderColor = '#1a9e4b';
            this.box.style.background = '#1a9e4b';
            this.box.setAttribute('aria-checked', 'true');
            this.box.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"' +
                ' style="position:absolute;inset:0"><path d="M5 13l4 4L19 7" fill="none" stroke="#fff"' +
                ' stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            this.label.textContent = 'Verified';
        } else if (s === 'working') {
            this.box.innerHTML = '';
            this.box.style.borderColor = '#4a90d9';
            this.label.textContent = 'Verifying…';
        } else {
            this.box.innerHTML = '';
            this.box.style.borderColor = '#b0b6be';
            this.box.style.background = '#fff';
            this.box.setAttribute('aria-checked', 'false');
            this.label.textContent = "I'm not a robot";
        }
    };

    /* Prove which domain we are, from the customer's own page.

       This fetch is issued by the host page, so the browser stamps Origin with
       the real embedding origin and page script cannot alter it. The server
       checks that against the site key's registered domains and returns a
       signed blob naming it; the challenge frame later presents that blob to
       /issue. The embedding domain therefore never travels as a client-asserted
       value, which is what makes the site key genuinely domain-restricted.

       Resolves to null when no issuer is configured or the domain is refused —
       open() reports the refusal rather than silently running an unverifiable
       challenge. */
    Widget.prototype.fetchChallenge = function () {
        var self = this;
        if (!this.verify) return Promise.resolve(null);
        var url;
        try { url = new URL('/challenge', this.verify).toString(); }
        catch (e) { return Promise.resolve(null); }
        return fetch(url, {
            method: 'POST',
            mode: 'cors',
            credentials: 'omit',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sitekey: this.sitekey }),
        }).then(function (r) {
            return r.json().then(function (d) { return { status: r.status, data: d }; });
        }).then(function (res) {
            if (res.status === 200 && res.data && res.data.challenge) return res.data.challenge;
            var code = (res.data && res.data.error) || 'challenge-failed';
            self.lastError = code;
            return null;
        }).catch(function () { self.lastError = 'challenge-unreachable'; return null; });
    };

    Widget.prototype.open = function () {
        if (this.token || this.overlay) return;
        var self = this;
        this.setState('working');
        this.fetchChallenge().then(function (challenge) { self.openWith(challenge); });
    };

    Widget.prototype.openWith = function (challenge) {
        var self = this;
        if (this.token || this.overlay) return;
        this.challenge = challenge;

        if (this.verify && !challenge) {
            // The service is configured but refused us. Running the game now
            // could only produce a token that fails verification, so say so.
            this.setState('idle');
            var msg = this.lastError === 'domain-not-allowed'
                ? 'This site key is not authorised for ' + location.origin
                : this.lastError === 'invalid-sitekey' ? 'Unknown site key'
                : 'Verification service unreachable';
            try { console.error('[monster-captcha] ' + msg); } catch (e) {}
            var ecb = callbackFor(this.onError);
            if (ecb) { try { ecb(this.lastError || 'challenge-failed'); } catch (e) { logErr(e); } }
            return;
        }

        var overlay = el('div', 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.72);' +
            'display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;');
        var shell = el('div', 'position:relative;width:min(1000px,100%);height:min(680px,100%);' +
            'background:#000;border-radius:8px;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,.5);');

        var url = ORIGIN + CHALLENGE_PATH + '?embed=1&widget=' + encodeURIComponent(this.id) +
            (this.sitekey ? '&sitekey=' + encodeURIComponent(this.sitekey) : '') +
            (this.verify ? '&verify=' + encodeURIComponent(this.verify) : '');
        // Pointer Lock is required to look around, so allow it explicitly; the
        // frame is otherwise given nothing (no top navigation, no downloads).
        var frame = el('iframe', 'width:100%;height:100%;border:0;display:block;', {
            src: url,
            title: 'Monster CAPTCHA challenge',
            allow: 'pointer-lock; fullscreen; autoplay',
            sandbox: 'allow-scripts allow-same-origin allow-pointer-lock',
        });

        var close = el('button', 'position:absolute;top:10px;right:10px;z-index:2;width:32px;height:32px;' +
            'border:0;border-radius:16px;background:rgba(0,0,0,.55);color:#fff;font:700 18px/1 sans-serif;' +
            'cursor:pointer;', { type: 'button', 'aria-label': 'Close challenge' });
        close.textContent = '×';
        close.addEventListener('click', function () { self.close('dismissed'); }, false);

        function onKey(e) { if (e.key === 'Escape') self.close('dismissed'); }
        document.addEventListener('keydown', onKey, false);
        this._onKey = onKey;

        shell.appendChild(frame);
        shell.appendChild(close);
        overlay.appendChild(shell);
        document.body.appendChild(overlay);

        this.overlay = overlay;
        this.frame = frame;
        this.frameOrigin = ORIGIN;
    };

    Widget.prototype.close = function (reason) {
        if (this._onKey) { document.removeEventListener('keydown', this._onKey, false); this._onKey = null; }
        if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
        this.overlay = null; this.frame = null;
        if (!this.token) {
            this.setState('idle');
            if (reason && reason !== 'solved') {
                var cb = callbackFor(this.onExpire);
                if (cb) { try { cb(reason); } catch (e) { logErr(e); } }
            }
        }
    };

    Widget.prototype.handle = function (msg) {
        if (msg.type === 'ready') {
            // Reply so the frame learns our origin from the browser rather than
            // from anything a page could forge. See src/embed.js.
            try {
                this.frame.contentWindow.postMessage({
                    source: PROTOCOL, v: VERSION, type: 'handshake', widgetId: this.id,
                    // Passed here rather than in the frame URL: it stays out of
                    // browser history, referrers and server access logs.
                    challenge: this.challenge || null,
                }, this.frameOrigin);
            } catch (e) { /* frame gone */ }
            return;
        }
        if (msg.type === 'solved') {
            this.token = msg.token || '';
            this.input.value = this.token;
            this.setState('solved');
            this.close('solved');
            if (!msg.verified) {
                try {
                    console.warn('[monster-captcha] no verification service configured (data-verify): ' +
                        'this token cannot be checked server-side and proves nothing. See docs/INTEGRATION.md');
                } catch (e) {}
            }
            var cb = callbackFor(this.onVerify);
            if (cb) {
                try { cb(this.token, { points: msg.points, seed: msg.seed, verified: !!msg.verified }); }
                catch (e) { logErr(e); }
            }
            return;
        }
        if (msg.type === 'closed') { this.close(msg.reason || 'dismissed'); return; }
        if (msg.type === 'error') {
            var eb = callbackFor(this.onError);
            if (eb) { try { eb(msg.message); } catch (e) { logErr(e); } }
            this.close('error');
        }
    };

    Widget.prototype.reset = function () {
        this.token = null;
        this.input.value = '';
        this.setState('idle');
        this.close('reset');
    };

    function logErr(e) { try { console.error('[monster-captcha] callback threw', e); } catch (_) {} }

    /* ---------- one message listener for every widget ---------- */
    window.addEventListener('message', function (ev) {
        var d = ev.data;
        if (!d || d.source !== PROTOCOL || typeof d.type !== 'string') return;
        for (var i = 0; i < widgets.length; i++) {
            var w = widgets[i];
            if (!w.frame) continue;
            // Both checks matter: the origin must be the challenge host, and the
            // message must come from THIS widget's frame — otherwise any framed
            // page could solve someone else's widget.
            if (ev.origin !== w.frameOrigin) continue;
            var src = null;
            try { src = w.frame.contentWindow; } catch (e) { continue; }
            if (ev.source !== src) continue;
            w.handle(d);
            return;
        }
    }, false);

    /* ---------- public API ---------- */
    function render(target, opts) {
        var node = typeof target === 'string' ? document.querySelector(target) : target;
        if (!node) return null;
        for (var k in opts || {}) {
            var attr = k === 'sitekey' ? 'data-sitekey' : k === 'callback' ? 'data-callback'
                : k === 'theme' ? 'data-theme' : null;
            if (attr) node.setAttribute(attr, opts[k]);
        }
        var w = new Widget(node);
        widgets.push(w);
        return w.id;
    }

    function forId(id) {
        for (var i = 0; i < widgets.length; i++) if (widgets[i].id === id) return widgets[i];
        return widgets[0] || null;
    }

    window.MonsterCaptcha = {
        render: render,
        reset: function (id) { var w = forId(id); if (w) w.reset(); },
        getResponse: function (id) { var w = forId(id); return w ? (w.token || '') : ''; },
        FIELD_NAME: FIELD_NAME,
        origin: ORIGIN,
    };

    function autoRender() {
        var nodes = document.querySelectorAll('.monster-captcha:not([data-mc-bound])');
        for (var i = 0; i < nodes.length; i++) {
            nodes[i].setAttribute('data-mc-bound', '1');
            widgets.push(new Widget(nodes[i]));
        }
        if (typeof window.onMonsterCaptchaLoad === 'function') {
            try { window.onMonsterCaptchaLoad(); } catch (e) { logErr(e); }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoRender, false);
    } else {
        autoRender();
    }
})();
