import 'dotenv/config';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Création Abby : concurrence et reprise après échec à chaque étape, avec un mock Abby à pannes injectées.
// Base jetable « birostweb_test » uniquement ; aucun appel réseau, aucune écriture dans un vrai compte Abby.
const testUrl = new URL(process.env.TEST_DATABASE_URL || 'mysql://invalid/none');
if (testUrl.pathname !== '/birostweb_test' || process.env.NODE_ENV === 'production')
    throw new Error('Test reprise Abby : TEST_DATABASE_URL doit viser « birostweb_test », hors production.');
Object.assign(process.env, { DATABASE_URL: testUrl.toString(), ABBY_API_KEY: 'suk-test-mock', ABBY_ENABLED: 'true', NODE_ENV: 'test' });
delete process.env.ABBY_ALLOW_LIVE_FINALIZE;
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });

const { default: Fastify } = await import('fastify');
const { db, today, addDays } = await import('../../server/db.js');
const { abby } = await import('../../server/routes/abby.js');
const { createAbbyHttp, createAbbyService, createMockFetch } = await import('../../server/services/abby/index.js');

const failures = new Map(); // étape → nombre d'échecs restants
const calls = { createDraft: 0, lines: 0, general: 0 };
const step = (path, method) => method === 'POST' && /^\/v2\/billing\/invoice\/[^/]+$/.test(path) ? 'createDraft' : method === 'PATCH' && /\/lines$/.test(path) ? 'lines' : method === 'PATCH' && /general-informations$/.test(path) ? 'general' : null;
const mockFetch = createMockFetch({ seedError: (path, method) => {
    const s = step(path, method);
    if (s) calls[s]++;
    if (s && failures.get(s) > 0) { failures.set(s, failures.get(s) - 1); return { ok: false, status: 502, headers: { get: () => 'application/json' }, json: async () => ({ message: 'panne simulée' }) }; }
    return null;
} });
// Latence simulée sur la création du brouillon pour élargir la fenêtre de course.
const slowFetch = async (url, opts) => { if (step(new URL(url).pathname, opts.method) === 'createDraft') await new Promise(r => setTimeout(r, 150)); return mockFetch(url, opts); };
const svc = createAbbyService(createAbbyHttp({ apiKey: 'suk-test-mock', baseUrl: 'https://abby.mock', fetch: slowFetch, retries: 0 }));
let app, user, client;

async function acceptedQuote() {
    const now = today();
    return db.quote.create({ data: { reference: 'DEV-T-' + randomUUID().slice(0, 8), clientId: client.id, title: 'Reprise', status: 'accepted', issuedDate: now, validUntil: addDays(now, 30), totalCents: 50000, issuerSnapshot: {}, clientSnapshot: {}, items: { create: [{ name: 'Prestation', category: 'Création', unitCents: 50000, quantityMilli: 1000 }] } } });
}
const create = (quoteId, body = {}) => app.inject({ method: 'POST', url: `/api/quotes/${quoteId}/abby-invoice`, payload: body });

before(async () => {
    user = await db.user.create({ data: { email: `resume-${randomUUID()}@test.example`, name: 'QA', passwordHash: 'x', totpEnabled: true } });
    client = await db.client.create({ data: { name: 'Client reprise', email: 'resume@test.example', status: 'active' } });
    app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (req) => { req.user = { id: user.id, role: 'admin' }; });
    app.setErrorHandler((e, req, reply) => reply.code(e.statusCode ?? 500).send({ message: e.message, code: e.publicCode }));
    await abby(app, { service: svc, lockWaitMs: 5000 });
});
after(async () => { await app?.close(); await db.$disconnect(); });

test('Concurrent creations produce exactly one Abby draft', async () => {
    const q = await acceptedQuote();
    const before = calls.createDraft;
    const results = await Promise.all([create(q.id), create(q.id), create(q.id)]);
    for (const r of results) assert.equal(r.statusCode, 200, r.body);
    assert.equal(calls.createDraft - before, 1, 'one draft only');
    assert.equal(new Set(results.map(r => r.json().abbyInvoiceId)).size, 1);
    assert.equal(results[0].json().abbySyncState, 'complete');
});

test('Failure after the draft is stored resumes lines and info without a second draft', async () => {
    for (const failing of ['lines', 'general']) {
        const q = await acceptedQuote();
        const before = { ...calls };
        failures.set(failing, 1);
        const first = await create(q.id);
        assert.equal(first.statusCode, 502, first.body);
        const stored = await db.invoice.findUnique({ where: { abbyQuoteKey: q.id } });
        assert.ok(stored.abbyInvoiceId); assert.equal(stored.abbySyncState, failing === 'lines' ? 'draft_created' : 'lines_set');
        assert.equal(stored.abbySyncLockedUntil, null, 'lock released after failure');
        // Finalisation refusée tant que la création est incomplète.
        assert.equal((await app.inject({ method: 'POST', url: `/api/invoices/${stored.id}/abby/finalize` })).statusCode, 409);
        const retry = await create(q.id);
        assert.equal(retry.statusCode, 200, retry.body);
        assert.equal(retry.json().abbySyncState, 'complete');
        assert.equal(retry.json().abbyInvoiceId, stored.abbyInvoiceId);
        assert.equal(calls.createDraft - before.createDraft, 1, `no duplicate draft after ${failing} failure`);
        const abbyDoc = mockFetch.store.invoices.get(stored.abbyInvoiceId);
        assert.equal(abbyDoc.lines.length, 1, 'lines present after resume');
    }
});

test('Interrupted draft creation requires explicit reconciliation before retrying', async () => {
    const q = await acceptedQuote();
    failures.set('createDraft', 1);
    const first = await create(q.id);
    assert.equal(first.statusCode, 502);
    assert.equal((await db.invoice.findUnique({ where: { abbyQuoteKey: q.id } })).abbySyncState, 'creating');
    const blocked = await create(q.id);
    assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().code, 'ABBY_RECONCILE_REQUIRED');
    const confirmed = await create(q.id, { confirmNoDuplicate: true });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().abbySyncState, 'complete');
});

test('A held lock blocks a concurrent operation and expires on its own', async () => {
    const q = await acceptedQuote();
    const ok = await create(q.id); assert.equal(ok.statusCode, 200);
    const inv = ok.json();
    await db.invoice.update({ where: { id: inv.id }, data: { abbySyncLockedUntil: new Date(Date.now() + 60_000) } });
    assert.equal((await app.inject({ method: 'POST', url: `/api/invoices/${inv.id}/abby/finalize` })).json().code, 'ABBY_SYNC_IN_PROGRESS');
    await db.invoice.update({ where: { id: inv.id }, data: { abbySyncLockedUntil: new Date(Date.now() - 1000) } });
    assert.equal((await app.inject({ method: 'POST', url: `/api/invoices/${inv.id}/abby/finalize` })).statusCode, 200, 'expired lock reclaimed');
});
