import 'dotenv/config';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { today, addDays } from '../../server/db.js';
import { enrollTotp, testTotpKey } from './totp-helper.js';

// Base jetable OBLIGATOIRE : jamais la vraie DATABASE_URL.
const testUrl = new URL(process.env.TEST_DATABASE_URL || 'mysql://invalid/none');
if (testUrl.pathname !== '/birostweb_test' || process.env.NODE_ENV === 'production')
    throw new Error('Ce e2e exige TEST_DATABASE_URL sur une base dédiée « birostweb_test », hors production.');

const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: testUrl.toString(), SEED_DEMO: 'false', STORAGE_PATH: './tmp/test-storage', PORT: '3204', APP_ORIGIN: 'http://127.0.0.1:3204', ADMIN_EMAIL: 'edit-admin@birostweb.example', ADMIN_PASSWORD: randomUUID() + randomUUID(), TOTP_ENCRYPTION_KEY: testTotpKey() };
const base = 'http://127.0.0.1:3204/api', origin = env.APP_ORIGIN;
let child, logs = '', cookie = '', csrf = '', client;
const now = today();

async function call(path, { method = 'GET', body, headers = {}, anonymous = false } = {}) {
    const response = await fetch(base + path, { method, headers: { origin, ...(!anonymous ? { cookie, 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const json = response.headers.get('content-type')?.includes('application/json');
    return { status: response.status, data: json ? await response.json() : Buffer.from(await response.arrayBuffer()), headers: response.headers };
}
async function ok(path, opts) { const r = await call(path, opts); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.data)}`); return r.data; }
const line = (unitCents, extra = {}) => ({ name: 'Prestation QA', description: 'desc', category: 'Création', section: 'Projet', unitCents, quantityMilli: 1000, frequency: 'once', vatBps: 0, discountBps: 0, optional: false, selected: true, position: 0, ...extra });
const quoteBody = (extra = {}) => ({ clientId: client.id, title: 'QA édition devis', issuedDate: now, validUntil: addDays(now, 30), depositBps: 3000, discountBps: 0, conditions: 'Acompte 30%.', legalNotice: 'TVA non applicable, art. 293 B du CGI', items: [line(99900)], ...extra });

async function quoteIn(status) {
    const q = await ok('/quotes', { method: 'POST', body: quoteBody() });
    if (status === 'draft') return q;
    await ok('/quotes/' + q.id + '/status', { method: 'PATCH', body: { status: 'sent' } });
    if (status === 'sent') return q;
    await ok('/quotes/' + q.id + '/status', { method: 'PATCH', body: { status: 'accepted' } });
    return q;
}

before(async () => {
    for (const args of [['node_modules/prisma/build/index.js', 'migrate', 'deploy'], ['prisma/seed.js']])
        execFileSync(process.execPath, args, { env, stdio: 'pipe' });
    child = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
    let ready = false;
    for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 150)); }
    if (!ready) throw new Error(logs.slice(-3000));
    const login = await call('/auth/login', { method: 'POST', anonymous: true, body: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD } });
    assert.equal(login.status, 200, JSON.stringify(login.data)); cookie = login.headers.get('set-cookie').split(';')[0]; csrf = login.data.csrf;
    await enrollTotp(call, env.ADMIN_PASSWORD); // 2FA administrateur obligatoire
    const s = await ok('/settings'); await ok('/settings', { method: 'PUT', body: { ...s, address: '1 rue QA, 75001 Paris', siret: '00000000000000', vatEnabled: false } });
    client = await ok('/clients', { method: 'POST', body: { name: 'QA Édition', email: 'qa-edit@example.com', address: '1 rue QA', status: 'active' } });
});
after(async () => { if (child) { child.kill('SIGTERM'); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); }); } });

test('Un devis ENVOYÉ reste modifiable et conserve son statut', async () => {
    const q = await quoteIn('sent');
    const edited = await call('/quotes/' + q.id, { method: 'PUT', body: quoteBody({ title: 'Titre modifié (envoyé)' }) });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    const after = await ok('/quotes/' + q.id);
    assert.equal(after.status, 'sent'); // statut conservé, pas de retour en brouillon
    assert.equal(after.title, 'Titre modifié (envoyé)');
    assert.equal(edited.data.warning, undefined); // aucune facture : pas d'avertissement
});

test('Un devis ACCEPTÉ reste modifiable (lignes ajoutées/retirées) et conserve son statut', async () => {
    const q = await quoteIn('accepted');
    const edited = await call('/quotes/' + q.id, { method: 'PUT', body: quoteBody({ title: 'Devis accepté révisé', items: [line(99900), line(50000, { name: 'Ligne ajoutée' })] }) });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    const after = await ok('/quotes/' + q.id);
    assert.equal(after.status, 'accepted');
    assert.equal(after.items.length, 2);
    assert.equal(after.totalCents, 149900);
});

test('Une facture BROUILLON liée : édition autorisée avec AVERTISSEMENT', async () => {
    const q = await quoteIn('accepted');
    const inv = await ok('/invoices', { method: 'POST', body: { clientId: client.id, quoteId: q.id, title: 'Acompte QA', kind: 'deposit', issuedDate: now, dueDate: addDays(now, 10), items: [line(30000)] } });
    assert.match(inv.reference, /^BRO-/);
    const edited = await call('/quotes/' + q.id, { method: 'PUT', body: quoteBody({ title: 'Révisé avec brouillon' }) });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.match(edited.data.warning || '', /facture brouillon/i); // avertissement renvoyé
    assert.equal((await ok('/quotes/' + q.id)).invoiceDraftPending, true);
});

test('Une facture OFFICIELLE (émise, N° FAC-) BLOQUE l\'édition en 409', async () => {
    const q = await quoteIn('accepted');
    const inv = await ok('/invoices', { method: 'POST', body: { clientId: client.id, quoteId: q.id, title: 'Solde QA', kind: 'final', issuedDate: now, dueDate: addDays(now, 10), items: [line(99900)] } });
    const emitted = await ok('/invoices/' + inv.id + '/status', { method: 'PATCH', body: { status: 'sent' } });
    assert.match(emitted.reference, /^FAC-\d{4}-\d{3}$/);
    const blocked = await call('/quotes/' + q.id, { method: 'PUT', body: quoteBody({ title: 'Tentative interdite' }) });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
    assert.match(blocked.data.message, /facture officielle/i);
    assert.match(blocked.data.message, new RegExp(emitted.reference));
    assert.equal((await ok('/quotes/' + q.id)).invoiceLock, true);
});
