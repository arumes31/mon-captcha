/* ============================================================
   Boot gate — refuse to run the game unless import-map integrity is enforced.

   three.js comes from jsDelivr, and the only thing standing between a tampered
   CDN response and execution is the "integrity" member of the host page's
   import map. A browser that understands import maps but predates that member
   ignores it silently and runs whatever the CDN sent. So before main.js (and
   with it the CDN graph) is requested, two same-origin probes are imported:

     mc-sri-probe/tampered  mapped with a deliberately WRONG hash -> must fail
     mc-sri-probe/ok        mapped with the correct hash          -> must load

   Tampered loading means integrity is ignored; ok failing means the check
   itself is broken (or import maps are unsupported). Either way the game does
   not load — this fails closed. Both probes are the same tiny file
   (src/sri-probe.js) under different query strings, so they are distinct
   module-map entries.
   ============================================================ */

async function integrityEnforced() {
    try {
        await import('mc-sri-probe/tampered');
        return false;
    } catch (e) { /* refused, as it must be */ }
    try {
        await import('mc-sri-probe/ok');
        return true;
    } catch (e) {
        return false;
    }
}

function refuse() {
    const el = document.getElementById('loading');
    const msg = 'This browser cannot verify the integrity of the 3D engine it would download, '
        + 'so the challenge will not load. Please update your browser and try again.';
    if (el) {
        el.setAttribute('role', 'alert');
        el.replaceChildren(Object.assign(document.createElement('p'), { textContent: msg }));
    }
    console.error('[monCAPTCHA] import-map integrity is not enforced; refusing to load CDN modules.');
}

if (await integrityEnforced()) {
    await import('../main.js');
} else {
    refuse();
}
