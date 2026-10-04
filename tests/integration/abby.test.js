import 'dotenv/config';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { today, addDays } from '../../server/db.js';
import { enrollTotp, nextTotp, testTotpKey } from './totp-helper.js';

// Base jetable OBLIGATOIRE : on refuse tout ce qui n'est pas explicitement la base de test.
// Jamais la vraie DATABASE_URL. La couche Abby est MOCKÉE (ABBY_MOCK=1) : aucun appel réseau,
// aucune écriture dans le vrai compte Abby, aucune finalisation réelle.
const testUrl = new URL(process.env.TEST_DATABASE_URL || 'mysql://invalid/none');
if (testUrl.pathname !== '/birostweb_test' || process.env.NODE_ENV === 'production')
    throw new Error('Abby e2e exige TEST_DATABASE_URL sur une base dédiée « birostweb_test », hors production.');

const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: testUrl.toString(), SEED_DEMO: 'false', STORAGE_PATH: './tmp/test-storage', PORT: '3203', APP_ORIGIN: 'http://127.0.0.1:3203', ADMIN_EMAIL: 'abby-admin@birostweb.example', ADMIN_PASSWORD: randomUUID() + randomUUID(), ABBY_MOCK: '1', ABBY_API_KEY: 'suk-test-mock', ABBY_ENABLED: 'true', TOTP_ENCRYPTION_KEY: testTotpKey() };
delete env.ABBY_ALLOW_LIVE_FINALIZE; // on ne finalise qu'en mock, jamais en live
const base = 'http://127.0.0.1:3203/api', origin = env.APP_ORIGIN;
let child, logs = '', cookie = '', csrf = '', adminTotp, client, quoteA, quoteB, abbyInvoice;
const now = today();

async function call(path, { method = 'GET', body, headers = {}, anonymous = false } = {}) {
    const response = await fetch(base + path, { method, headers: { origin, ...(!anonymous ? { cookie, 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const json = response.headers.get('content-type')?.includes('application/json');
    return { status: response.status, data: json ? await response.json() : Buffer.from(await response.arrayBuffer()), headers: response.headers };
}
async function ok(path, opts) { const r = await call(path, opts); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.data)}`); return r.data; }
async function login(email, password, totpSecret) { const r = await call('/auth/login', { method: 'POST', anonymous: true, body: { email, password, ...(totpSecret ? { token: await nextTotp(totpSecret) } : {}) } }); assert.equal(r.status, 200, JSON.stringify(r.data)); cookie = r.headers.get('set-cookie').split(';')[0]; csrf = r.data.csrf; }
const line = (unitCents, extra = {}) => ({ name: 'Prestation QA', description: 'desc', category: 'Création', section: 'Projet', unitCents, quantityMilli: 1000, frequency: 'once', vatBps: 0, discountBps: 0, optional: false, selected: true, position: 0, ...extra });
const quoteBody = (extra = {}) => ({ clientId: client.id, title: 'QA Abby', issuedDate: now, validUntil: addDays(now, 30), depositBps: 3000, discountBps: 0, conditions: 'Acompte 30%.', legalNotice: 'TVA non applicable, art. 293 B du CGI', items: [line(99900), line(4500, { frequency: 'monthly', name: 'Hébergement' })], ...extra });

async function acceptedQuote() {
    const q = await ok('/quotes', { method: 'POST', body: quoteBody() });
    await ok('/quotes/' + q.id + '/status', { method: 'PATCH', body: { status: 'sent' } });
    await ok('/quotes/' + q.id + '/status', { method: 'PATCH', body: { status: 'accepted' } });
    return q;
}

before(async () => {
    // Base jetable : on applique les migrations (migrate deploy, non destructif) puis on sème.
    // Le nettoyage/recréation de la base de test est géré hors test (script dédié).
    for (const args of [['node_modules/prisma/build/index.js', 'migrate', 'deploy'], ['prisma/seed.js']])
        execFileSync(process.execPath, args, { env, stdio: 'pipe' });
    child = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
    let ready = false;
    for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 150)); }
    if (!ready) throw new Error(logs.slice(-3000));
    await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
    adminTotp = (await enrollTotp(call, env.ADMIN_PASSWORD)).secret; // 2FA administrateur obligatoire
    // Paramètres : franchise en base, TVA non applicable (lecture depuis Settings, pas de hardcode).
    const s = await ok('/settings'); await ok('/settings', { method: 'PUT', body: { ...s, address: '1 rue QA, 75001 Paris', siret: '00000000000000', vatEnabled: false } });
    client = await ok('/clients', { method: 'POST', body: { name: 'QA Abby Client', email: 'qa@abby.example', address: '1 rue QA', status: 'active' } });
});
after(async () => { if (child) { child.kill('SIGTERM'); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); }); } });

test('Abby routes require an authenticated session', async () => {
    assert.equal((await call('/quotes/x/abby-invoice', { method: 'POST', body: {}, anonymous: true })).status, 401);
});

test('A draft Abby invoice can only be created from an ACCEPTED quote', async () => {
    const draftQuote = await ok('/quotes', { method: 'POST', body: quoteBody() });
    assert.equal((await call('/quotes/' + draftQuote.id + '/abby-invoice', { method: 'POST', body: {} })).status, 409);
});

test('Creating the Abby invoice syncs the client and stores the draft link', async () => {
    quoteA = await acceptedQuote();
    abbyInvoice = await ok('/quotes/' + quoteA.id + '/abby-invoice', { method: 'POST', body: {} });
    assert.ok(abbyInvoice.abbyInvoiceId, 'abbyInvoiceId stored');
    assert.equal(abbyInvoice.abbyStatus, 'draft');
    assert.equal(abbyInvoice.abbyNumber, null); // pas de numéro officiel tant que non finalisée
    assert.equal(abbyInvoice.abbyTest, true);    // document de test, jamais une vraie facture légale
    assert.equal(abbyInvoice.status, 'draft');
    // La mention d'exonération (Settings) est reprise, pas hardcodée.
    assert.match(abbyInvoice.legalNotice, /293 B/);
    // Le client a bien été rattaché à une organisation Abby.
    const c = await ok('/clients/' + client.id);
    assert.ok(c.abbyClientId, 'client linked to an Abby organization');
    client = c;
});

test('Double-click never creates two Abby invoices (idempotent per quote)', async () => {
    const results = await Promise.all([
        call('/quotes/' + quoteA.id + '/abby-invoice', { method: 'POST', body: {} }),
        call('/quotes/' + quoteA.id + '/abby-invoice', { method: 'POST', body: {} }),
    ]);
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(results[0].data.id, results[1].data.id);
    assert.equal(results[0].data.abbyInvoiceId, abbyInvoice.abbyInvoiceId);
});

test('ensureClient reuses the same Abby organization across quotes (no duplicate)', async () => {
    quoteB = await acceptedQuote();
    const second = await ok('/quotes/' + quoteB.id + '/abby-invoice', { method: 'POST', body: {} });
    assert.notEqual(second.id, abbyInvoice.id); // une facture par devis
    const c = await ok('/clients/' + client.id);
    assert.equal(c.abbyClientId, client.abbyClientId); // même organisation réutilisée
});

test('Finalizing stores the official number and locks the invoice', async () => {
    const finalized = await ok('/invoices/' + abbyInvoice.id + '/abby/finalize', { method: 'POST', body: {} });
    assert.equal(finalized.abbyStatus, 'finalized');
    assert.match(finalized.abbyNumber, /^F-\d{4}-\d{4}$/); // numéro officiel attribué par Abby (mock)
    assert.equal(finalized.status, 'sent');
    // Re-finalisation refusée.
    assert.equal((await call('/invoices/' + abbyInvoice.id + '/abby/finalize', { method: 'POST', body: {} })).status, 409);
    abbyInvoice = finalized;
});

test('The Abby PDF proxy returns a PDF and records the fetch', async () => {
    const r = await call('/invoices/' + abbyInvoice.id + '/abby/pdf');
    assert.equal(r.status, 200);
    assert.equal(r.data.subarray(0, 5).toString(), '%PDF-');
    const i = await ok('/invoices/' + abbyInvoice.id);
    assert.ok(i.abbyPdfFetchedAt);
});

test('Status sync and payment reconciliation update the invoice', async () => {
    const synced = await ok('/invoices/' + abbyInvoice.id + '/abby/sync', { method: 'POST', body: {} });
    assert.ok(synced.lastSyncedAt);
    const paid = await ok('/invoices/' + abbyInvoice.id + '/abby/payment', { method: 'POST', body: { paid: true, amountCents: 99900, date: now, method: 'transfer' } });
    assert.equal(paid.abbyStatus, 'paid');
    const unpaid = await ok('/invoices/' + abbyInvoice.id + '/abby/payment', { method: 'POST', body: { paid: false } });
    assert.equal(unpaid.abbyStatus, 'finalized');
});

test('Abby billing is ADMIN only: a referrer account is refused (403)', async () => {
    const referrer = await ok('/referrers', { method: 'POST', body: { name: 'QA Ref', email: 'ref@abby.example' } });
    const pwd = randomUUID() + randomUUID();
    await ok('/users', { method: 'POST', body: { name: 'QA Ref User', email: 'refuser@abby.example', role: 'referrer', referrerId: referrer.id, password: pwd } });
    await login('refuser@abby.example', pwd);
    assert.equal((await call('/quotes/' + quoteA.id + '/abby-invoice', { method: 'POST', body: {} })).status, 403);
    assert.equal((await call('/invoices/' + abbyInvoice.id + '/abby/finalize', { method: 'POST', body: {} })).status, 403);
    await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD, adminTotp); // restaure la session admin
});
