/* ============================================================
   Software-Renderer Detection
   ------------------------------------------------------------
   A confirmed software rasterizer (SwiftShader, llvmpipe/Mesa, or
   Windows' "Microsoft Basic Render Driver" fallback) pays for every
   fragment shaded twice over versus a real GPU, so the two priciest
   FIXED renderer costs — MSAA antialiasing and soft-shadow PCF
   filtering — are worth deciding against BEFORE the real renderer
   (and its materials) are ever created, rather than waiting out the
   FPS sampler's ~60-frame ramp in quality.js.

   Deliberately narrow: only matches unambiguous software-rendering
   signatures. A real-but-weak GPU (an old integrated chip, say) is
   left to the existing live FPS-based tier stepper, which already
   handles "weak but real" fine — misclassifying a working GPU here
   would needlessly cut visuals for a device that didn't need it.
   ============================================================ */

const SOFTWARE_RENDERER_PATTERNS = [
    /swiftshader/i,
    /llvmpipe/i,
    /software rasterizer/i,
    /microsoft basic render driver/i,
    /mesa.*llvmpipe/i,
    // item 380: keep the list current as new confirmed-software strings
    // surface across browsers/OSes. Same bar as above — only added when
    // the string is an unambiguous software rasterizer, never a "this
    // integrated chip might be weak" guess.
    /google swiftshader/i,       // ANGLE's explicit vendor label for SwiftShader
    /apple software renderer/i,  // macOS's software GL fallback
    /softpipe/i,                 // Mesa's other software rasterizer (llvmpipe's sibling)
    /virgl/i,                    // virtio-gpu's virtualized GL, software-backed on the host in headless/CI VMs
];

// Spins up a throwaway 1x1 canvas + WebGL context purely to read the
// UNMASKED_RENDERER_WEBGL string, then lets it go (garbage-collected once
// this function returns and nothing references it anymore — deliberately
// NOT explicitly lost via WEBGL_lose_context, since that just makes the
// browser print its own generic "WebGL context was lost" console line for
// a context that was never in the DOM or rendered to in the first place).
export function detectSoftwareRenderer() {
    try {
        if (typeof document === 'undefined') return { isSoftware: false, rendererString: null };
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return { isSoftware: false, rendererString: null };

        // Firefox deprecated WEBGL_debug_renderer_info (console warning on every
        // getExtension() call) in favor of exposing the real string via the
        // plain RENDERER parameter directly — so skip the extension there
        // entirely. Other browsers (Chromium/WebKit) still mask the plain
        // parameter to a generic value, so they still need the debug extension.
        const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || '');
        let rendererString;
        if (isFirefox) {
            rendererString = gl.getParameter(gl.RENDERER);
        } else {
            const dbgExt = gl.getExtension('WEBGL_debug_renderer_info');
            rendererString = dbgExt
                ? gl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL)
                : gl.getParameter(gl.RENDERER);
        }

        const isSoftware = typeof rendererString === 'string' &&
            SOFTWARE_RENDERER_PATTERNS.some((re) => re.test(rendererString));

        return { isSoftware, rendererString: rendererString || null };
    } catch (e) {
        return { isSoftware: false, rendererString: null }; // safest default: treat as real hardware
    }
}
