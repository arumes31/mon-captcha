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
];

// Spins up a throwaway 1x1 canvas + WebGL context purely to read the
// UNMASKED_RENDERER_WEBGL string, then lets it go — a few ms, never added
// to the DOM, no relation to the game's real renderer/canvas.
export function detectSoftwareRenderer() {
    try {
        if (typeof document === 'undefined') return { isSoftware: false, rendererString: null };
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return { isSoftware: false, rendererString: null };

        const dbgExt = gl.getExtension('WEBGL_debug_renderer_info');
        const rendererString = dbgExt
            ? gl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER);

        const isSoftware = typeof rendererString === 'string' &&
            SOFTWARE_RENDERER_PATTERNS.some((re) => re.test(rendererString));

        const loseExt = gl.getExtension('WEBGL_lose_context');
        if (loseExt) loseExt.loseContext();

        return { isSoftware, rendererString: rendererString || null };
    } catch (e) {
        return { isSoftware: false, rendererString: null }; // safest default: treat as real hardware
    }
}
