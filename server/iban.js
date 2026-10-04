import { sealSecret, openSecret, isSealed } from './secrets.js';
export function ibanKey() {
    const raw = process.env.IBAN_ENCRYPTION_KEY || '';
    const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('IBAN_ENCRYPTION_KEY doit contenir 32 octets, distincts de la base.');
    return key;
}
// Inclut les snapshots JSON de devis/factures et les paramètres entreprise.
export function protectIbans(value, writing, key) {
    if (Array.isArray(value)) return value.map(v => protectIbans(v, writing, key));
    if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([name, v]) => {
        if (name === 'iban' && writing && v && typeof v === 'object' && typeof v.set === 'string') return [name, {set: protectIbans({iban:v.set}, true, key).iban}];
        if (name === 'iban' && typeof v === 'string' && v) return [name, writing ? (isSealed(v) ? v : sealSecret(v, key || ibanKey())) : (isSealed(v) ? openSecret(v, key || ibanKey()) : v)];
        return [name, protectIbans(v, writing, key)];
    }));
}
