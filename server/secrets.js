import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
// Chiffrement applicatif des secrets TOTP au repos (AES-256-GCM).
// La clé vient UNIQUEMENT de l'environnement (TOTP_ENCRYPTION_KEY : 32 octets en base64 ou 64 caractères hex),
// distincte de la base : une fuite de dump SQL seule ne révèle pas les secrets 2FA.
const PREFIX = 'v1:';
export function totpKey() {
    const raw = process.env.TOTP_ENCRYPTION_KEY || '';
    if (!raw) return null;
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('TOTP_ENCRYPTION_KEY doit contenir 32 octets (base64 ou 64 caractères hexadécimaux).');
    return key;
}
export function isSealed(value) { return typeof value === 'string' && value.startsWith(PREFIX); }
export function sealSecret(plain, key = totpKey()) {
    if (!key) throw Object.assign(new Error('Chiffrement 2FA non configuré : définissez TOTP_ENCRYPTION_KEY.'), { statusCode: 503 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return PREFIX + [iv, cipher.getAuthTag(), ct].map(b => b.toString('base64url')).join(':');
}
// Lit un secret stocké. Compatibilité : une valeur héritée en clair (avant chiffrement) est renvoyée telle quelle
// et ré-enregistrée chiffrée par l'appelant au prochain usage réussi.
export function openSecret(stored, key = totpKey()) {
    if (!stored) return '';
    if (!isSealed(stored)) return stored;
    if (!key) throw Object.assign(new Error('Chiffrement 2FA non configuré : définissez TOTP_ENCRYPTION_KEY.'), { statusCode: 503 });
    const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map(s => Buffer.from(s, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
