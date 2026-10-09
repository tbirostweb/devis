import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buffer) {
    let bits = 0, value = 0, out = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}
export function base32Decode(input) {
    const clean = input.replace(/=+$/,'').replace(/\s/g,'').toUpperCase();
    let bits = 0, value = 0; const out = [];
    for (const ch of clean) {
        const idx = ALPHABET.indexOf(ch);
        if (idx === -1) throw new Error('Secret TOTP invalide.');
        value = (value << 5) | idx; bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return Buffer.from(out);
}
export function generateSecret() { return base32Encode(randomBytes(20)); }
function hotp(secret, counter) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = createHmac('sha1', secret).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(bin % 1_000_000).padStart(6, '0');
}
// Fenêtre ±1 pas (30 s) pour tolérer une petite dérive d'horloge. Comparaison à temps constant.
export function verifyTotp(secretBase32, token, atMs = Date.now(), window = 1) {
    if (!secretBase32 || !/^\d{6}$/.test(String(token ?? ''))) return false;
    let secret; try { secret = base32Decode(secretBase32); } catch { return false; }
    const counter = Math.floor(atMs / 1000 / 30);
    for (let i = -window; i <= window; i++) {
        const candidate = Buffer.from(hotp(secret, counter + i));
        const provided = Buffer.from(String(token));
        if (candidate.length === provided.length && timingSafeEqual(candidate, provided)) return true;
    }
    return false;
}
export function otpauthURL(secretBase32, account, issuer = 'Birostweb') {
    const label = encodeURIComponent(`${issuer}:${account}`);
    const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
    return `otpauth://totp/${label}?${params}`;
}
