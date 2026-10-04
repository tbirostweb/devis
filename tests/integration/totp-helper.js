// Aide de test : enrôlement 2FA des administrateurs (obligatoire) et génération de codes TOTP
// en respectant l'anti-rejeu (chaque code n'est utilisable qu'une fois, pas strictement croissant).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { totpAt, currentCounter } from '../../server/totp.js';
export const testTotpKey = () => randomBytes(32).toString('hex');
const lastCounter = new Map();
export async function nextTotp(secret) {
    const c = Math.max(currentCounter(), (lastCounter.get(secret) ?? -Infinity) + 1);
    while (c > currentCounter() + 1) await new Promise(r => setTimeout(r, 500));
    lastCounter.set(secret, c);
    return totpAt(secret, c);
}
// `call(path, opts)` : fonction HTTP authentifiée du test (cookie + CSRF de la session courante).
export async function enrollTotp(call, password) {
    const setup = await call('/auth/2fa/setup', { method: 'POST', body: { password } });
    assert.equal(setup.status, 200, JSON.stringify(setup.data));
    const enable = await call('/auth/2fa/enable', { method: 'POST', body: { token: await nextTotp(setup.data.secret) } });
    assert.equal(enable.status, 200, JSON.stringify(enable.data));
    assert.equal(enable.data.recoveryCodes.length, 10);
    return { secret: setup.data.secret, recoveryCodes: enable.data.recoveryCodes };
}
