import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sealSecret, openSecret, isSealed } from '../server/secrets.js';
import { redact, safeError } from '../server/redact.js';
import { parseTrustProxy } from '../server/config.js';
import { generateSecret, totpAt, currentCounter, matchTotpCounter } from '../server/totp.js';
import { consumeTotp, newRecoveryCodes, recoveryHash } from '../server/auth.js';
import { eventTimestamp } from '../server/routes/calendar.js';
import { createAbbyHttp } from '../server/services/abby/http.js';

const key = randomBytes(32);

test('TOTP secrets are sealed with AES-256-GCM and tampering is detected', () => {
    const secret = generateSecret();
    const sealed = sealSecret(secret, key);
    assert.ok(isSealed(sealed));
    assert.ok(!sealed.includes(secret), 'secret never stored in clear');
    assert.equal(openSecret(sealed, key), secret);
    const parts = sealed.split(':');
    parts[3] = Buffer.from('tampered-ciphertext').toString('base64url');
    assert.throws(() => openSecret(parts.join(':'), key));
    assert.throws(() => openSecret(sealed, randomBytes(32)), 'wrong key refused');
    // Héritage : un secret en clair (avant migration) reste lisible pour être rechiffré au prochain usage.
    assert.equal(openSecret(secret, key), secret);
    assert.throws(() => sealSecret(secret, null), /TOTP_ENCRYPTION_KEY/);
});

// Faux client Prisma reproduisant l'UPDATE conditionnel (totpLastCounter null ou < pas).
function fakeUserStore(user) {
    return { user: {
        updateMany: async ({ where, data }) => {
            const okCounter = user.totpLastCounter === null || where.OR.some(c => c.totpLastCounter?.lt !== undefined && user.totpLastCounter < c.totpLastCounter.lt);
            if (where.id !== user.id || !okCounter) return { count: 0 };
            Object.assign(user, data); return { count: 1 };
        },
        update: async ({ data }) => { Object.assign(user, data); return user; },
    } };
}

test('A TOTP code is accepted once: replay and older codes are refused', async () => {
    process.env.TOTP_ENCRYPTION_KEY = key.toString('hex');
    const secret = generateSecret();
    const user = { id: 'u1', totpSecret: sealSecret(secret, key), totpLastCounter: null };
    const store = fakeUserStore(user);
    const now = currentCounter();
    assert.equal(await consumeTotp(user, totpAt(secret, now), store), true);
    assert.equal(user.totpLastCounter, now);
    assert.equal(await consumeTotp(user, totpAt(secret, now), store), false, 'same code replayed');
    assert.equal(await consumeTotp(user, totpAt(secret, now - 1), store), false, 'older code refused');
    assert.equal(await consumeTotp(user, totpAt(secret, now + 1), store), true, 'next step accepted');
    // Deux requêtes concurrentes avec le même code : une seule gagne.
    const u2 = { id: 'u2', totpSecret: sealSecret(secret, key), totpLastCounter: null };
    const s2 = fakeUserStore(u2);
    const results = await Promise.all([consumeTotp(u2, totpAt(secret, now), s2), consumeTotp(u2, totpAt(secret, now), s2)]);
    assert.deepEqual(results.sort(), [false, true]);
});

test('Legacy plaintext TOTP secret is re-encrypted on first successful use', async () => {
    process.env.TOTP_ENCRYPTION_KEY = key.toString('hex');
    const secret = generateSecret();
    const user = { id: 'u3', totpSecret: secret, totpLastCounter: null };
    assert.equal(await consumeTotp(user, totpAt(secret, currentCounter()), fakeUserStore(user)), true);
    assert.ok(isSealed(user.totpSecret));
    assert.equal(openSecret(user.totpSecret, key), secret);
});

test('matchTotpCounter returns the matched step within ±1 window only', () => {
    const secret = generateSecret(), now = Date.now(), c = currentCounter(now);
    assert.equal(matchTotpCounter(secret, totpAt(secret, c), now), c);
    assert.equal(matchTotpCounter(secret, totpAt(secret, c + 1), now), c + 1);
    assert.equal(matchTotpCounter(secret, totpAt(secret, c + 3), now) === c + 3, false);
});

test('Recovery codes are random, formatted and hashed with normalisation', () => {
    const codes = newRecoveryCodes();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const c of codes) assert.match(c, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    assert.equal(recoveryHash(codes[0]), recoveryHash(codes[0].toLowerCase().replace('-', ' ')));
    assert.notEqual(recoveryHash(codes[0]), recoveryHash(codes[1]));
    assert.ok(!recoveryHash(codes[0]).includes(codes[0].replace('-', '')));
});

test('redact masks emails, IBAN, phones, SIRET, bearer tokens and Abby keys', () => {
    const out = redact('Client jean.dupont@example.com IBAN FR76 3000 6000 0112 3456 7890 189 tel 06 12 34 56 78 siret 12345678901234 Bearer abc.def suk-SECRET123 {"password":"hunter2"}');
    for (const leaked of ['jean.dupont@example.com', '3000 6000', '06 12 34 56 78', '12345678901234', 'abc.def', 'suk-SECRET123', 'hunter2']) assert.ok(!out.includes(leaked), leaked);
    assert.ok(redact('x'.repeat(1000), 50).length <= 51);
    const e = safeError(Object.assign(new Error('Unique failed for email=a@b.fr'), { code: 'P2002' }));
    assert.ok(!e.message.includes('a@b.fr')); assert.equal(e.code, 'P2002');
});

test('Abby provider error messages are redacted before being surfaced or logged', async () => {
    const fetch = async () => ({ ok: false, status: 400, headers: { get: () => 'application/json' }, json: async () => ({ message: 'Invalid customer jean@client.fr FR7630006000011234567890189' }) });
    const http = createAbbyHttp({ apiKey: 'suk-test', baseUrl: 'https://abby.invalid', fetch, retries: 0 });
    await assert.rejects(http.post('/organization', {}), (e) => !e.message.includes('jean@client.fr') && !e.message.includes('FR7630006000011234567890189') && !String(e.body).includes('jean@client.fr'));
});

test('TRUST_PROXY accepts a precise proxy list, hop count or legacy boolean', () => {
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy('1'), 1);
    assert.deepEqual(parseTrustProxy('10.0.1.2, 10.0.0.0/16'), ['10.0.1.2', '10.0.0.0/16']);
});

test('Cal.com webhook freshness window refuses stale, future and undated events', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    assert.equal(eventTimestamp({ createdAt: '2026-10-04T11:58:00Z' }, now).toISOString(), '2026-10-04T11:58:00.000Z');
    assert.throws(() => eventTimestamp({ createdAt: '2026-10-04T11:00:00Z' }, now), /fenêtre/);
    assert.throws(() => eventTimestamp({ createdAt: '2026-10-04T12:30:00Z' }, now), /fenêtre/);
    assert.throws(() => eventTimestamp({}, now), /absent/);
    assert.throws(() => eventTimestamp({ createdAt: 'nope' }, now), /absent/);
});
