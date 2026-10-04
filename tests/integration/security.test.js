import 'dotenv/config';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { today, addDays } from '../../server/db.js';
import { enrollTotp, nextTotp, testTotpKey } from './totp-helper.js';

// Régressions sécurité (audit 04/10/2026) sur base jetable « birostweb_test » uniquement, Abby mocké.
const testUrl = new URL(process.env.TEST_DATABASE_URL || 'mysql://invalid/none');
if (testUrl.pathname !== '/birostweb_test' || process.env.NODE_ENV === 'production')
    throw new Error('Tests sécurité : TEST_DATABASE_URL doit viser une base dédiée « birostweb_test », hors production.');
const webhookSecret = randomUUID();
const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: testUrl.toString(), SEED_DEMO: 'false', STORAGE_PATH: './tmp/test-storage', PORT: '3205', APP_ORIGIN: 'http://127.0.0.1:3205', ADMIN_EMAIL: 'sec-admin@birostweb.example', ADMIN_PASSWORD: randomUUID() + randomUUID(), ABBY_MOCK: '1', ABBY_API_KEY: 'suk-test-mock', ABBY_ENABLED: 'true', CALCOM_WEBHOOK_SECRET: webhookSecret, TOTP_ENCRYPTION_KEY: testTotpKey(), TRUST_PROXY: '127.0.0.1' };
delete env.ABBY_ALLOW_LIVE_FINALIZE;
const base = 'http://127.0.0.1:3205/api', origin = env.APP_ORIGIN;
const db = new PrismaClient({ datasources: { db: { url: testUrl.toString() } } });
let child, logs = '', session = { cookie: '', csrf: '' }, adminTotp, recoveryCodes, now = today();

async function call(path, { method = 'GET', body, headers = {}, as = session, anonymous = false } = {}) {
    const response = await fetch(base + path, { method, headers: { origin, ...(!anonymous ? { cookie: as.cookie, 'x-csrf-token': as.csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
    const json = response.headers.get('content-type')?.includes('application/json');
    return { status: response.status, data: json ? await response.json() : await response.text(), headers: response.headers };
}
async function ok(path, opts) { const r = await call(path, opts); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.data)}`); return r.data; }
async function login(email, password, extra = {}) {
    // Proxy de confiance limité à 127.0.0.1 (TRUST_PROXY) : chaque connexion simule une IP cliente distincte
    // pour ne pas épuiser le quota de connexion par IP pendant la suite de tests.
    const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
    const r = await call('/auth/login', { method: 'POST', anonymous: true, headers: { 'x-forwarded-for': ip }, body: { email, password, ...extra } });
    return { r, s: r.headers.get('set-cookie') ? { cookie: r.headers.get('set-cookie').split(';')[0], csrf: r.data.csrf } : null };
}

before(async () => {
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env, stdio: 'pipe' });
    execFileSync(process.execPath, ['prisma/seed.js'], { env, stdio: 'pipe' });
    child = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
    let ready = false;
    for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 150)); }
    if (!ready) throw new Error(logs.slice(-3000));
});
after(async () => { await db.$disconnect(); if (child) { child.kill('SIGTERM'); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); }); } });

test('Admin without 2FA only reaches enrollment; setup requires re-authentication', async () => {
    const { r, s } = await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
    assert.equal(r.status, 200); assert.equal(r.data.enrollmentRequired, true);
    session = s;
    const blocked = await call('/clients');
    assert.equal(blocked.status, 403); assert.equal(blocked.data.code, 'TOTP_ENROLLMENT_REQUIRED');
    assert.equal((await call('/settings')).status, 403);
    assert.equal((await call('/auth/me')).status, 200);
    assert.equal((await call('/auth/2fa/setup', { method: 'POST', body: {} })).status, 400, 'password required');
    assert.equal((await call('/auth/2fa/setup', { method: 'POST', body: { password: 'wrong-password-123' } })).status, 400);
    ({ secret: adminTotp, recoveryCodes } = await enrollTotp(call, env.ADMIN_PASSWORD));
    assert.equal((await call('/clients')).status, 200);
    // Secret chiffré au repos, jamais en clair en base.
    const row = await db.user.findUnique({ where: { email: env.ADMIN_EMAIL } });
    assert.ok(row.totpSecret.startsWith('v1:') && !row.totpSecret.includes(adminTotp));
    assert.equal(await db.totpRecoveryCode.count({ where: { userId: row.id, usedAt: null } }), 10);
});

test('TOTP codes cannot be replayed at login; recovery codes are single use', async () => {
    const pending = await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
    assert.equal(pending.r.data.twoFactor, true); assert.equal(pending.s, null, 'no session before second factor');
    const code = await nextTotp(adminTotp);
    const first = await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD, { token: code });
    assert.equal(first.r.status, 200, JSON.stringify(first.r.data)); assert.ok(first.s);
    const replay = await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD, { token: code });
    assert.equal(replay.r.data.twoFactor, true); assert.match(replay.r.data.error, /déjà utilisé/); assert.equal(replay.s, null);
    const viaRecovery = await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD, { recoveryCode: recoveryCodes[0].toLowerCase() });
    assert.equal(viaRecovery.r.status, 200); assert.ok(viaRecovery.s);
    const reused = await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD, { recoveryCode: recoveryCodes[0] });
    assert.equal(reused.s, null); assert.match(reused.r.data.error, /secours/);
    session = first.s;
});

test('Email change requires password + 2FA code and revokes the other sessions', async () => {
    const other = (await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD, { recoveryCode: recoveryCodes[1] })).s;
    assert.equal((await call('/auth/me', { as: other })).status, 200);
    const newEmail = 'sec-admin2@birostweb.example';
    assert.equal((await call('/auth/email', { method: 'POST', body: { email: newEmail, password: env.ADMIN_PASSWORD } })).status, 400, '2FA code required');
    const changed = await ok('/auth/email', { method: 'POST', body: { email: newEmail, password: env.ADMIN_PASSWORD, token: await nextTotp(adminTotp) } });
    assert.equal(changed.email, newEmail);
    assert.equal((await call('/auth/me', { as: other })).status, 401, 'other session revoked');
    assert.equal((await call('/auth/me')).status, 200, 'current session kept');
    env.ADMIN_EMAIL = newEmail;
});

test('Referrers A and B are isolated (no IDOR) and never reach admin APIs', async () => {
    const mk = async (n) => {
        const ref = await ok('/referrers', { method: 'POST', body: { name: 'Ref ' + n, email: `ref${n}@sec.example`, iban: 'FR7630006000011234567890189' } });
        const client = await ok('/clients', { method: 'POST', body: { name: 'Client ' + n, email: `c${n}@sec.example`, referrerId: ref.id } });
        const password = randomUUID() + randomUUID();
        await ok('/users', { method: 'POST', body: { name: 'User ' + n, email: `user${n}@sec.example`, role: 'referrer', referrerId: ref.id, password } });
        return { ref, client, password, email: `user${n}@sec.example` };
    };
    const A = await mk('A'), B = await mk('B');
    const a = (await login(A.email, A.password)).s;
    const portal = await ok('/portal', { as: a });
    assert.equal(portal.referrer.name, 'Ref A');
    assert.deepEqual(portal.clients.map(c => c.name), ['Client A']);
    for (const path of ['/clients', '/referrers', '/users', '/invoices', '/settings', `/clients/${B.client.id}`, `/referrers/${B.ref.id}`, '/documents/x/download', '/calendar-entries'])
        assert.equal((await call(path, { as: a })).status, 403, path);
    assert.equal((await call(`/referrers/${B.ref.id}`, { method: 'PATCH', as: a, body: { name: 'pwned' } })).status, 403);
    await ok('/portal/profile', { method: 'PATCH', as: a, body: { name: 'Ref A bis', iban: 'FR7630006000011234567890189' } });
    assert.equal((await db.referrer.findUnique({ where: { id: B.ref.id } })).name, 'Ref B', 'B untouched');
});

function signed(body) {
    const raw = JSON.stringify(body);
    return { raw, sig: createHmac('sha256', webhookSecret).update(raw).digest('hex') };
}
async function webhook(body, sig) {
    const s = signed(body);
    return fetch(base + '/webhooks/cal-com', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cal-signature-256': sig ?? s.sig }, body: s.raw }).then(async r => ({ status: r.status, data: await r.json() }));
}

test('Cal.com webhook: bad signature, stale/replayed events and created-after-cancel are rejected', async () => {
    const uid = 'bk-' + randomUUID();
    const t = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString();
    const booking = { uid, title: 'RDV QA', startTime: addDays(now, 3) + 'T09:00:00Z', endTime: addDays(now, 3) + 'T10:00:00Z', attendees: [{ name: 'QA', email: 'qa@sec.example' }] };
    const created = { triggerEvent: 'BOOKING_CREATED', createdAt: t(-60), payload: booking };
    assert.equal((await webhook(created, 'f'.repeat(64))).status, 401);
    assert.equal((await webhook(created)).status, 200);
    assert.equal((await db.calendarEntry.findUnique({ where: { externalId: uid } })).status, 'confirmed');
    const replay = await webhook(created);
    assert.equal(replay.status, 200); assert.equal(replay.data.ignored, 'stale');
    assert.equal((await webhook({ triggerEvent: 'BOOKING_CANCELLED', createdAt: t(-10), payload: booking })).status, 200);
    assert.equal((await db.calendarEntry.findUnique({ where: { externalId: uid } })).status, 'cancelled');
    // Ancien CREATED (signé, encore dans la fenêtre) reçu après l'annulation : aucun effet.
    assert.equal((await webhook({ triggerEvent: 'BOOKING_CREATED', createdAt: t(-30), payload: booking })).data.ignored, 'stale');
    assert.equal((await db.calendarEntry.findUnique({ where: { externalId: uid } })).status, 'cancelled');
    // Événement trop ancien (hors fenêtre) ou non daté : refusé.
    assert.equal((await webhook({ triggerEvent: 'BOOKING_CREATED', createdAt: t(-3600), payload: { ...booking, uid: uid + 'x' } })).status, 400);
    assert.equal((await webhook({ triggerEvent: 'BOOKING_CREATED', payload: { ...booking, uid: uid + 'y' } })).status, 400);
    // Annulation reçue AVANT la création : le CREATED antérieur ne réactive pas le rendez-vous.
    const uid2 = 'bk-' + randomUUID();
    await webhook({ triggerEvent: 'BOOKING_CANCELLED', createdAt: t(-5), payload: { ...booking, uid: uid2 } });
    await webhook({ triggerEvent: 'BOOKING_CREATED', createdAt: t(-20), payload: { ...booking, uid: uid2 } });
    assert.equal((await db.calendarEntry.findUnique({ where: { externalId: uid2 } })).status, 'cancelled');
});

test('Abby reconciliation refuses drafts, overpayment and double payment', async () => {
    const s = await ok('/settings'); await ok('/settings', { method: 'PUT', body: { ...s, address: '1 rue QA', siret: '00000000000000', vatEnabled: false } });
    const client = await ok('/clients', { method: 'POST', body: { name: 'Abby Sec', email: 'abby@sec.example', status: 'active' } });
    const line = { name: 'Prestation', description: '', category: 'Création', section: 'Projet', unitCents: 50000, quantityMilli: 1000, frequency: 'once', vatBps: 0, discountBps: 0, optional: false, selected: true, position: 0 };
    const q = await ok('/quotes', { method: 'POST', body: { clientId: client.id, title: 'Sec', issuedDate: now, validUntil: addDays(now, 30), items: [line] } });
    await ok(`/quotes/${q.id}/status`, { method: 'PATCH', body: { status: 'sent' } });
    await ok(`/quotes/${q.id}/status`, { method: 'PATCH', body: { status: 'accepted' } });
    const inv = await ok(`/quotes/${q.id}/abby-invoice`, { method: 'POST', body: {} });
    assert.equal(inv.abbySyncState, 'complete');
    const pay = (amountCents) => call(`/invoices/${inv.id}/abby/payment`, { method: 'POST', body: { paid: true, amountCents, date: now, method: 'transfer' } });
    assert.equal((await pay(50000)).status, 409, 'draft cannot be reconciled');
    await ok(`/invoices/${inv.id}/abby/finalize`, { method: 'POST', body: {} });
    assert.equal((await pay(50001)).status, 400, 'overpayment refused');
    const both = await Promise.all([pay(50000), pay(50000)]);
    assert.deepEqual(both.map(r => r.status).sort(), [200, 409], 'only one concurrent reconciliation');
    assert.equal((await pay(50000)).status, 409, 'already paid');
});
