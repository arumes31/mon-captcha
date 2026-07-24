import { CONFIG } from './config.js';

/* ============================================================
   Seeded PRNG & Noise (inline, no library)
   ============================================================ */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 2D value noise with smoothstep interpolation, fractal octaves
export function makeValueNoise(seed) {
    const rand = mulberry32(seed);
    const SIZE = 256;
    const perm = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) perm[i] = i;
    for (let i = SIZE - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
    }
    const grad = new Float32Array(SIZE);
    for (let i = 0; i < SIZE; i++) grad[i] = rand() * 2 - 1;

    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const lerp = (a, b, t) => a + (b - a) * t;

    function valueAt(ix, iz) {
        const h = (ix * 374761393 + iz * 668265263) >>> 0;
        return grad[(perm[h & 255] + (h >>> 8)) & 255];
    }

    return function noise2D(x, z, octaves = 4, lacunarity = 2.0, gain = 0.5) {
        let amp = 1, freq = 1, sum = 0, norm = 0;
        for (let o = 0; o < octaves; o++) {
            const x0 = Math.floor(x * freq), z0 = Math.floor(z * freq);
            const fx = x * freq - x0, fz = z * freq - z0;
            const v00 = valueAt(x0, z0), v10 = valueAt(x0 + 1, z0);
            const v01 = valueAt(x0, z0 + 1), v11 = valueAt(x0 + 1, z0 + 1);
            const sx = fade(fx), sz = fade(fz);
            const v = lerp(lerp(v00, v10, sx), lerp(v01, v11, sx), sz);
            sum += v * amp; norm += amp;
            amp *= gain; freq *= lacunarity;
        }
        return sum / norm; // ~[-1,1]
    };
}

export const worldRand = mulberry32(CONFIG.WORLD_SEED);
export const worldNoise = makeValueNoise(CONFIG.WORLD_SEED ^ 0x9e3779b9);
