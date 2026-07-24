/* ============================================================
   Security (Checksum Token Generation)
   ============================================================ */

import { CONFIG } from './config.js';
import { state } from './state.js';

export function foldCapture(hash, index, timestamp, dist) {
    let h = (hash | 0) ^ 0x811c9dc5;
    h = Math.imul(h ^ (index & 0xff), 0x01000193);
    h = Math.imul(h ^ ((timestamp >>> 0) & 0xff), 0x01000193);
    h = Math.imul(h ^ ((timestamp >>> 8) & 0xff), 0x01000193);
    h = Math.imul(h ^ ((dist | 0) & 0xff), 0x01000193);
    for (let i = 0; i < CONFIG.PRIVATE_SALT.length; i++) {
        h = Math.imul(h ^ CONFIG.PRIVATE_SALT.charCodeAt(i), 0x01000193);
    }
    return h | 0;
}

export function validateCaptureHash(hash) {
    return (hash | 0) !== 0 && state.creaturesCaught >= CONFIG.CAPTURES_REQUIRED;
}

export async function generateToken() {
    const nonceBytes = new Uint8Array(16);
    let nonceHex = '';
    try {
        crypto.getRandomValues(nonceBytes);
        for (let i = 0; i < nonceBytes.length; i++) {
            nonceHex += nonceBytes[i].toString(16).padStart(2, '0');
        }
    } catch (e) {
        nonceHex = Math.random().toString(16).slice(2);
    }

    // payload folds the earned POINTS (state.creaturesCaught) + requirement
    const payload = `${nonceHex}:${state.captureHash >>> 0}:${state.creaturesCaught}:${CONFIG.CAPTURES_REQUIRED}`;
    try {
        const enc = new TextEncoder().encode(payload);
        const digest = await crypto.subtle.digest('SHA-256', enc);
        const arr = new Uint8Array(digest);
        let hex = '';
        for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
        return hex;
    } catch (e) {
        return null;
    }
}
